const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const model = require('../utils/savings-model');
const copy = v => JSON.parse(JSON.stringify(v));
const deferred = () => { let resolve, reject; const promise = new Promise((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject}; };
const tick = async () => { for(let i=0;i<12;i++) await Promise.resolve(); };
function setup(storage = new Map()) {
  let actor = 'a'; let handler = async () => ({saved:true});
  const calls=[];
  const wx={getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,copy(v)),removeStorageSync:k=>storage.delete(k),showToast(){}};
  const context={module:{exports:{}},wx,require:n=>n==='./savings'?(action,data)=>{calls.push({action,data:copy(data)});return handler(action,data);}:n==='./auth'?{getSelfOpenid:()=>actor}:model};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../utils/savings-plan-draft.js'),'utf8'),context);
  const overview={scope:'user_a',version:2,plan:model.defaults(),months:[]};
  const page={...context.module.exports,_visible:true,_generation:1,_scope:'user_a',data:{year:2026,plan:model.defaults(),overview:null,dirty:false,tab:1,personOpen:0},setData(p){assert.ok(!this._unloaded,'setData after unload');Object.assign(this.data,p);},recalculate(){this.result=copy(this._confirmedPlan);},current(g){return this._visible && this._generation===g;},confirm:async()=>true};
  page.acceptOverview(overview);
  return{page,calls,storage,overview,edit(value){page.data.plan.people[0].salary=value;page.changedPlan();},handler(fn){handler=fn;},actor(value){actor=value;}};
}
test('member tab waits for one save then switches and updates confirmed target',async()=>{const h=setup();h.edit('10000');const wait=deferred();h.handler(()=>wait.promise);const change=h.page.openPerson({currentTarget:{dataset:{person:1}}});assert.equal(h.page.data.personOpen,0);assert.equal(h.page.result.people[0].salary,'');wait.resolve({saved:true});await change;assert.equal(h.page.data.personOpen,1);assert.equal(h.page.result.people[0].salary,'10000');assert.equal(h.page.data.dirty,false);assert.equal(h.calls.length,1);assert.equal(h.storage.size,0);});
test('unchanged tabs and confirmation do not write cloud data',async()=>{const h=setup();await h.page.savePlan();await h.page.changeTab({currentTarget:{dataset:{tab:0}}});assert.equal(h.calls.length,0);assert.equal(h.page.data.tab,0);});
test('invalid input blocks switch and leaves original confirmed result and recoverable draft',async()=>{const h=setup();h.edit('-1');await h.page.changeTab({currentTarget:{dataset:{tab:0}}});assert.equal(h.page.data.tab,1);assert.equal(h.calls.length,0);assert.equal(h.page.data.dirty,true);assert.equal(h.page.result.people[0].salary,'');assert.ok(h.page.data.calcError);assert.equal(h.storage.size,1);});
test('hide and unload share one request and avoid view writes after unload',async()=>{const h=setup();h.edit('10000');const wait=deferred();h.handler(()=>wait.promise);h.page.onHide();h.page.onUnload();assert.equal(h.calls.length,1);wait.resolve({saved:true});await tick();assert.equal(h.storage.size,0);});
test('edits during in-flight save are serialized with the next version including during unload',async()=>{const h=setup();h.edit('10000');const first=deferred();h.handler(()=>h.calls.length===1?first.promise:Promise.resolve({saved:true}));const save=h.page.flushPlan();h.edit('20000');h.page.onUnload();first.resolve({saved:true});await save;assert.equal(h.calls.length,2);assert.equal(h.calls[1].data.plan.people[0].salary,'20000');assert.equal(h.calls[1].data.version,3);assert.equal(h.storage.size,0);});
test('network failure survives page recreation, with account and year isolated',async()=>{const h=setup();h.edit('10000');h.handler(async()=>{throw new Error('断网');});h.page.onHide();await tick();assert.equal(h.storage.size,1);const restored=setup(h.storage);assert.equal(restored.page.data.plan.people[0].salary,'10000');assert.equal(restored.page.data.dirty,true);restored.page.data.year=2027;restored.page.data.dirty=false;restored.page.acceptOverview(restored.overview);assert.equal(restored.page.data.plan.people[0].salary,'');restored.actor('b');restored.page.data.year=2026;restored.page.acceptOverview({...restored.overview,scope:'user_b'});assert.equal(restored.page.data.dirty,false);});
test('ledger-only version conflict retries, but partner plan changes do not auto overwrite',async()=>{const h=setup();h.edit('10000');h.handler(async action=>{if(h.calls.length===1)throw Object.assign(new Error('冲突'),{code:'VERSION_CONFLICT'});if(action==='overview')return {...h.overview,version:3};return {saved:true};});assert.equal(await h.page.flushPlan(),true);assert.equal(h.calls[2].data.version,3);const x=setup();x.edit('10000');const other=model.defaults();other.people[1].salary='50000';x.handler(async action=>{if(action==='savePlan')throw Object.assign(new Error('冲突'),{code:'VERSION_CONFLICT'});return {...x.overview,version:3,plan:other};});assert.equal(await x.page.flushPlan(),false);assert.equal(await x.page.flushPlan(),false);assert.equal(x.calls.filter(c=>c.action==='savePlan').length,1);assert.equal(x.page.data.dirty,true);});
test('identity change prevents late confirmation from applying to a different user',async()=>{const h=setup();h.edit('10000');const wait=deferred();h.handler(()=>wait.promise);const save=h.page.flushPlan();h.actor('b');wait.resolve({saved:true});assert.equal(await save,false);assert.equal(h.page.result.people[0].salary,'');assert.equal(h.storage.size,1);});
test('late overview cannot roll back a confirmed plan',async()=>{const h=setup();h.edit('10000');await h.page.flushPlan();h.page.acceptOverview(h.overview);assert.equal(h.page.data.plan.people[0].salary,'10000');assert.equal(h.page.data.overview.version,3);});
function navigationHarness(guard) {
  let component; const switches=[]; const page={_visible:true,beforeTabLeave:guard};
  const context={Component:d=>component=d,getCurrentPages:()=>[page],require:n=>n==='./data'?[{url:'/a'},{url:'/b'}]:n.includes('chat-unread')?{getTotal:()=>0}:{getStoredThemeClass:()=>''},wx:{switchTab:options=>switches.push(options)}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../custom-tab-bar/index.js'),'utf8'),context);
  const nav={...component.methods,data:{active:0,list:[{url:'/a'},{url:'/b'}]},setData(p){Object.assign(this.data,p);}};
  return{nav,switches,page};
}
test('bottom tab waits for confirmation; repeated tap cannot duplicate navigation',async()=>{const wait=deferred();let saves=0;const h=navigationHarness(()=>{saves++;return wait.promise;});const event={currentTarget:{dataset:{index:1}}};const first=h.nav.onChange(event);await h.nav.onChange(event);assert.equal(saves,1);assert.equal(h.switches.length,0);wait.resolve(true);await first;assert.equal(h.switches.length,1);});
test('bottom tab remains selected when automatic confirmation fails',async()=>{const h=navigationHarness(async()=>false);await h.nav.onChange({currentTarget:{dataset:{index:1}}});assert.equal(h.switches.length,0);assert.equal(h.nav.data.active,0);});
test('returning overview waits for the editor save shared across page instances',async()=>{const h=setup();h.edit('10000');const wait=deferred();h.handler(()=>wait.promise);const saving=h.page.flushPlan();const overviewPage={...h.page,_saveFlight:null,data:{...h.page.data},_expectedScope:'user_a'};let loaded=false;const returning=overviewPage.waitForPlanSaves().then(()=>loaded=true);await tick();assert.equal(loaded,false);wait.resolve({saved:true});await saving;await returning;assert.equal(loaded,true);});
