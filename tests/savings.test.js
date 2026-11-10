const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const path=require('node:path');
const m=require('../utils/savings-model');
test('annual progressive tax boundaries and zero deduction floor',()=>{assert.equal(m.tax(-100),0);assert.equal(m.tax(3600000),108000);assert.equal(m.tax(14400000),1188000);assert.equal(m.bonusTax(6000000),579000);});
test('official example: 120000 salary, 60000 bonus, 40000 deductions',()=>{const p={...m.defaults().people[0],salary:'10000',bonusMonths:'6',pensionRate:'0',medicalRate:'0',unemploymentRate:'0',housingRate:'0',extraDeduction:'3333.33'};const r=m.calculatePerson(p,2026);assert.ok(Math.abs(r.separateTax-639000)<=1);assert.ok(Math.abs(r.combinedTax-548000)<=1);});
test('cash savings excludes both sides of housing fund and annualizes budgets',()=>{const plan=m.defaults();Object.assign(plan.people[0],{salary:'10000',bonusMonths:'1'});plan.budgets=[{name:'房租',amount:'2000',period:'month'},{name:'旅行',amount:'5000',period:'year'}];const r=m.calculate(plan,2026);assert.equal(r.gross,13000000);assert.equal(r.housing,1680000);assert.equal(r.budget,2900000);assert.equal(r.target,r.net-r.budget);assert.equal(r.people[0].personalHousing,840000);});
test('reject invalid input, duplicate budgets, future unsupported separate tax',()=>{assert.throws(()=>m.amount('1.001'));assert.throws(()=>m.amount('-2'));assert.throws(()=>m.amount('NaN'));const p=m.defaults();p.budgets=[{name:'A',amount:1,period:'month'},{name:'A',amount:2,period:'year'}];assert.throws(()=>m.calculate(p,2026));assert.throws(()=>m.calculate(m.defaults(),2028));assert.equal(m.progress(10,0).percent,'未设正目标');assert.equal(m.progress(200,100).percent,'200.0%');assert.equal(m.progress(200,100).width,100);});
test('cloud validator and frontend calculator stay identical',()=>{assert.equal(fs.readFileSync(path.join(__dirname,'../utils/savings-model.js'),'utf8'),fs.readFileSync(path.join(__dirname,'../cloudfunctions/savingsApi/model.js'),'utf8'));});
function harness(){let records={users:{a:{coupleId:'pair'},b:{coupleId:'pair'},c:{}},couples:{pair:{status:'active',members:['a','b']}},savingsYears:{},savingsEntries:{},savingsCategories:{}};let who='a';let revision=0;
const clone=x=>JSON.parse(JSON.stringify(x));
const matches=(record,where)=>where?.test?where.test(record):Object.entries(where).every(([key,value])=>value && value.test ? value.test(record[key]) : record[key]===value);
const cmp=(test)=>({test,and(other){return cmp(value=>test(value)&&other.test(value));}});
const col=(name,store)=>{
 const query=(where={},limit=30,orders=[])=>({where:w=>query(w,limit,orders),orderBy:(field,direction)=>query(where,limit,[...orders,[field,direction]]),limit:n=>query(where,n,orders),get:async()=>({data:Object.entries(store[name]).map(([id,r])=>({...r,_id:id})).filter(r=>matches(r,where)).sort((a,b)=>{for(const [field,dir]of orders){if(a[field]!==b[field])return (a[field]<b[field]?-1:1)*(dir==='desc'?-1:1);}return 0;}).slice(0,limit)})});
 return {...query(),doc:id=>({get:async()=>{if(!store[name][id])throw new Error('document not exist');return{data:clone({...store[name][id],_id:id})};},set:async({data})=>{assert.equal(data._id,undefined);store[name][id]=clone(data);}}),aggregate(){let where={},offset=0,limit=100;const chain={match(w){where=w;return chain;},group(){return chain;},sort(){return chain;},skip(n){offset=n;return chain;},limit(n){limit=n;return chain;},async end(){const groups=new Map();Object.values(store[name]).filter(r=>matches(r,where)).forEach(r=>{const key=r.type+':'+r.category;const g=groups.get(key)||{_id:{type:r.type,category:r.category},amount:0,count:0};g.amount+=r.amount;g.count++;groups.set(key,g);});return{list:[...groups.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,r])=>r).slice(offset,offset+limit)};}};return chain;}};
};
const db={command:{and:conditions=>({test:r=>conditions.every(c=>matches(r,c))}),or:conditions=>({test:r=>conditions.some(c=>matches(r,c))}),gte:v=>cmp(x=>x>=v),lte:v=>cmp(x=>x<=v),lt:v=>cmp(x=>x<v),aggregate:{sum:v=>({sum:v})}},collection:n=>col(n,records),runTransaction:async fn=>{for(let i=0;i<10;i++){const rev=revision;const draft=clone(records);const result=await fn({collection:n=>col(n,draft)});if(rev!==revision)continue;records=draft;revision++;return result;}throw new Error('conflict');}};
const sandbox={exports:{},console:{error(){}},require:n=>n==='wx-server-sdk'?{init(){},database:()=>db,getWXContext:()=>({OPENID:who})}:n==='./model'?m:n==='./categories'?require('../utils/savings-categories'):require(n)};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../cloudfunctions/savingsApi/index.js'),'utf8'),sandbox);
return{call:(user,action,extra={})=>{who=user;return sandbox.exports.main({action,year:2026,...extra});},records:()=>records};}
const entry={requestId:'request_123',type:'expense',amount:'12.34',date:'2026-11-09',category:'餐饮'};
test('idempotent bookkeeping, ownership and reversible summary totals',async()=>{const h=harness();let r=await h.call('a','add',entry);assert.equal(r.ok,true);const id=r.data.id;await h.call('a','add',entry);let v=(await h.call('b','overview')).data;assert.equal(v.months[10].expense,1234);assert.equal(v.months[10].categories['饮食'],1234);assert.equal((await h.call('b','remove',{id,requestId:'delete_123'})).ok,true);await h.call('a','remove',{id,requestId:'delete_123'});await h.call('a','remove',{id,requestId:'delete_123'});v=(await h.call('a','overview')).data;assert.equal(v.months[10].expense,0);await h.call('a','add',entry);assert.equal((await h.call('a','overview')).data.months[10].expense,0);});
test('concurrent writes preserve counters and stale plans are rejected',async()=>{const h=harness();await Promise.all([h.call('a','add',entry),h.call('b','add',{...entry,requestId:'request_456'})]);const v=(await h.call('a','overview')).data;assert.equal(v.months[10].expense,2468);assert.equal((await h.call('a','savePlan',{version:0,plan:m.defaults()})).code,'VERSION_CONFLICT');assert.equal((await h.call('a','savePlan',{version:v.version,plan:m.defaults()})).ok,true);});
test('unbound and unrelated users cannot access old shared data; invalid dates never write',async()=>{const h=harness();assert.equal((await h.call('a','add',{...entry,date:'2026-02-30'})).ok,false);assert.equal((await h.call('c','overview',{scope:'couple_pair'})).code,'SCOPE_CHANGED');await h.call('a','add',entry);h.records().couples.pair.status='dissolved';assert.equal((await h.call('a','overview',{scope:'couple_pair'})).code,'SCOPE_CHANGED');assert.equal((await h.call('','overview')).ok,false);});
test('navigation keeps five tabs and ordering is accessible from home',()=>{const config=require('../app.json');assert.deepEqual(config.tabBar.list.map(t=>t.text),['今天','位置','消息','储蓄','我们']);assert.match(fs.readFileSync(path.join(__dirname,'../pages/home/home.wxml'),'utf8'),/去点单/);assert.doesNotMatch(fs.readFileSync(path.join(__dirname,'../pages/category/index.js'),'utf8'),/getTabBar\(\)\.init/);});
function pageHarness(){
 let definition; const calls=[]; let resolveOverview;
 const pending=new Promise(r=>resolveOverview=r); const storage=new Map();
 const wx={showToast(){},getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,v),removeStorageSync:k=>storage.delete(k)};
 const cloudApi=(a,d)=>{calls.push({a,d});return pending;};
 const auth={requireSession:async()=>({user:{openid:'a'},couple:null}),getSelfOpenid:()=> 'a'};
 const draftContext={module:{exports:{}},require:n=>n==='./savings'?cloudApi:n==='./auth'?auth:m,wx};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../utils/savings-plan-draft.js'),'utf8'),draftContext);
 const sandbox={module:{exports:{}},require:n=>n.endsWith('savings-categories')?require('../utils/savings-categories'):n.endsWith('savings-model')?m:n.endsWith('savings-plan-draft')?draftContext.module.exports:n.endsWith('/savings')?cloudApi:n.endsWith('/auth')?auth:{getStoredThemeClass:()=>'',syncTheme:()=>''},wx};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../pages/savings/controller.js'),'utf8'),sandbox);definition=sandbox.module.exports('main');
 const page={...definition,data:JSON.parse(JSON.stringify(definition.data)),getTabBar:()=>null,setData(patch){for(const [key,value]of Object.entries(patch)){const parts=key.replace(/\[(\d+)\]/g,'.$1').split('.');let dest=this.data;parts.slice(0,-1).forEach(p=>dest=dest[p]);dest[parts.at(-1)]=value;}}};
 return{page,calls,resolveOverview};
}
test('calculator input only updates draft until confirmed',()=>{const {page,calls}=pageHarness();page.data.loading=false;page._scope='user_a';page.acceptOverview({scope:'user_a',version:0,plan:null});page.editPerson({currentTarget:{dataset:{person:0,key:'salary'}},detail:{value:'10000'}});assert.equal(calls.length,0);assert.equal(page.data.dirty,true);assert.equal(page.data.result.gross,0);assert.equal(page.data.progressRows.length,6);});
test('hidden page ignores late overview and never starts another list query',async()=>{const h=pageHarness();const show=h.page.onShow();await Promise.resolve();await Promise.resolve();h.page.onHide();h.resolveOverview({scope:'user_a',plan:null,months:Array.from({length:12},()=>({income:0,expense:0,categories:{}})),version:0});await show;assert.equal(h.page.data.overview,null);assert.equal(h.calls.filter(c=>c.a==='list').length,0);});
test('monthly salary target is unaffected by bonus amount and combined/separate choice',()=>{const p=m.defaults().people[0];Object.assign(p,{salary:'20000',bonusMonths:'0'});const original=m.calculatePerson(p,2026);p.bonusMonths='6';const separate=m.calculatePerson(p,2026);p.mode='combined';const combined=m.calculatePerson(p,2026);assert.equal(original.monthlyNet,separate.monthlyNet);assert.equal(original.monthlyNet,combined.monthlyNet);assert.ok(combined.net>original.net);assert.ok(combined.monthlyNet<combined.net/12);assert.deepEqual(m.defaults().personGenders,['male','female']);});
test('list filters month and type server-side; statistics covers all pages and both directions',async()=>{const h=harness();for(let i=0;i<45;i++)await h.call('a','add',{...entry,requestId:`entry_${String(i).padStart(8,'0')}`,amount:'10'});await h.call('b','add',{...entry,requestId:'income_001',type:'income',amount:'1000',category:'工资'});await h.call('a','add',{...entry,requestId:'othermonth_001',date:'2026-10-01',amount:'50'});const page=await h.call('a','list',{month:11,type:'expense'});assert.equal(page.data.entries.length,30);assert.ok(page.data.entries.every(r=>r.date.startsWith('2026-11')&&r.type==='expense'));const more=await h.call('a','list',{month:11,type:'expense',before:page.data.cursor});assert.equal(more.data.entries.length,15);const stats=await h.call('a','statistics',{month:11});assert.equal(stats.data.expense,45000);assert.equal(stats.data.income,100000);assert.equal(stats.data.rows.find(r=>r.type==='expense').count,45);assert.equal((await h.call('a','statistics')).data.expense,50000);await h.call('a','remove',{id:page.data.entries[0]._id,requestId:'delete_001'});assert.equal((await h.call('a','statistics',{month:11})).data.expense,44000);assert.equal((await h.call('c','statistics',{scope:'couple_pair'})).code,'SCOPE_CHANGED');assert.equal((await h.call('a','list',{month:13})).ok,false);});
test('statistics pagination retains every category beyond the group window',async()=>{const h=harness();for(let i=0;i<105;i++)h.records().savingsEntries['legacy_'+i]={owner:'couple_pair',year:2026,date:'2026-11-01',deleted:false,type:'income',amount:100,category:'分类'+i};const result=await h.call('a','statistics',{month:11});assert.equal(result.data.rows.length,1);assert.equal(result.data.rows[0].count,105);assert.equal(result.data.income,10500);});
test('new entry inherits current income/expense tab and selected month, with separate category sets',()=>{const {page}=pageHarness();page.data.loading=false;page.data.overview={};page.data.year=2026;page.data.month=2;page.data.entryType='income';page.openEntry();assert.equal(page.data.entry.type,'income');assert.equal(page.data.entry.date,'2026-02-01');assert.equal(page.data.entryEnd,'2100-12-31');assert.ok(page.data.categories.includes('奖金'));assert.ok(!page.data.categories.includes('饮食'));page.data.entryType='expense';page.openEntry();assert.equal(page.data.entry.type,'expense');assert.ok(page.data.categories.includes('饮食'));assert.ok(page.data.categories.includes('医疗'));});
test('both members can edit amount/category/date while preserving author and rejecting stale writes',async()=>{
 const h=harness();const added=await h.call('a','add',{...entry,category:'饮食',subcategory:'午饭'});const id=added.data.id;
 const update={...entry,id,entryVersion:1,requestId:'edit_000001',amount:'25.50',category:'交通',subcategory:'地铁',date:'2026-12-02'};
 assert.equal((await h.call('b','update',update)).ok,true);
 assert.equal((await h.call('b','update',update)).ok,true);
 const overview=(await h.call('a','overview')).data;
 assert.equal(overview.months[10].expense,0);assert.equal(overview.months[11].expense,2550);
 const saved=h.records().savingsEntries[id];assert.equal(saved.createdBy,'a');assert.equal(saved.updatedBy,'b');assert.equal(saved.version,2);assert.equal(saved.subcategory,'地铁');
 assert.equal((await h.call('a','update',{...update,requestId:'edit_000002'})).code,'ENTRY_CONFLICT');
 assert.equal((await h.call('a','remove',{id,entryVersion:1,requestId:'delete_001'})).code,'ENTRY_CONFLICT');
 assert.equal((await h.call('c','update',{...update,entryVersion:2})).code,'FORBIDDEN');
 assert.equal((await h.call('b','remove',{id,entryVersion:2,requestId:'delete_001'})).ok,true);
 assert.equal((await h.call('a','overview')).data.months[11].expense,0);
});
test('cross-year edits atomically move totals and retries stay idempotent',async()=>{
 const h=harness();const {data:{id}}=await h.call('a','add',{...entry,category:'生活',subcategory:'水费'});
 const update={...entry,id,entryVersion:1,requestId:'edit_crossyear',date:'2027-01-03',category:'租房',subcategory:'房租',amount:'3000'};
 assert.equal((await h.call('b','update',update)).ok,true);assert.equal((await h.call('b','update',update)).ok,true);
 assert.equal((await h.call('a','overview')).data.months[10].expense,0);
 assert.equal((await h.call('a','overview',{year:2027})).data.months[0].expense,300000);
 assert.equal((await h.call('a','statistics',{year:2027})).data.expense,300000);
});
test('history is per ledger, type and major category and survives deletes',async()=>{
 const h=harness();await h.call('a','add',{...entry,category:'饮食',subcategory:'咖啡'});await h.call('b','add',{...entry,requestId:'second_0001',category:'饮食',subcategory:'午饭'});
 await h.call('a','add',{...entry,requestId:'third_00001',type:'income',category:'礼金',subcategory:'生日'});
 const history=(await h.call('a','history')).data.history;
 assert.deepEqual([...history['expense_饮食']],['午饭','咖啡']);assert.deepEqual([...history['income_礼金']],['生日']);assert.equal(history['expense_礼金'],undefined);
 assert.equal(Object.keys((await h.call('c','history')).data.history).length,0);
 const id=Object.keys(h.records().savingsEntries)[0];await h.call('b','remove',{id,requestId:'delete_001'});
 assert.ok((await h.call('a','history',{year:2027})).data.history['expense_饮食'].includes('咖啡'));
 const previous=JSON.stringify(h.records().savingsYears);delete h.records().savingsCategories;
 assert.equal((await h.call('a','add',{...entry,requestId:'failed_0001',category:'生活',subcategory:'电费'})).ok,false);
 assert.equal(JSON.stringify(h.records().savingsYears),previous);
});
test('date-first cursors maintain contiguous day groups across pages',async()=>{
 const h=harness();for(let i=0;i<45;i++)await h.call('a','add',{...entry,requestId:`order_${String(i).padStart(8,'0')}`,date:i%2?'2026-11-01':'2026-11-10'});
 const first=(await h.call('a','list',{month:11,type:'expense'})).data;const second=(await h.call('a','list',{month:11,type:'expense',before:first.cursor})).data;
 const all=[...first.entries,...second.entries];assert.equal(new Set(all.map(e=>e._id)).size,45);
 assert.ok(all.slice(0,23).every(e=>e.date==='2026-11-10'));assert.ok(all.slice(23).every(e=>e.date==='2026-11-01'));
 const groups=require('../utils/savings-categories').groupEntries(all);assert.equal(groups.length,2);assert.equal(groups[0].entries.length,23);assert.equal(groups[1].entries.length,22);
});
test('subcategory suggestions remain scoped and editing another member uses the same editor',()=>{
 const {page}=pageHarness();page.data.entries=[{_id:'other-entry',year:2026,date:'2026-11-09',type:'expense',category:'饮食',subcategory:'午饭',amount:1200,version:1,createdBy:'b'}];page.data.busy=false;
 page._history={'expense_饮食':['午饭','咖啡'],'expense_交通':['地铁'],'income_礼金':['生日']};
 page.openExistingEntry({currentTarget:{dataset:{id:'other-entry'}}});assert.equal(page.data.editingEntry,true);assert.equal(page.data.entry.amount,'12.00');
 page.editEntry({currentTarget:{dataset:{key:'subcategory'}},detail:{value:'咖'}});assert.deepEqual([...page.data.subcategorySuggestions],['咖啡']);
 page.editEntry({currentTarget:{dataset:{key:'category'}},detail:{value:String(page.data.categories.indexOf('交通'))}});assert.equal(page.data.entry.subcategory,'');assert.deepEqual([...page.data.subcategorySuggestions],['地铁']);
 page.chooseSubcategory({currentTarget:{dataset:{value:'地铁'}}});assert.equal(page.data.entry.subcategory,'地铁');
});
test('frontend and backend category mappings stay identical',()=>{assert.equal(fs.readFileSync(path.join(__dirname,'../utils/savings-categories.js'),'utf8'),fs.readFileSync(path.join(__dirname,'../cloudfunctions/savingsApi/categories.js'),'utf8'));});
test('dismissing the entry sheet discards edits without submitting or changing the original row',()=>{
 const {page,calls}=pageHarness();page.data.entries=[{_id:'row',year:2026,date:'2026-11-09',type:'expense',category:'饮食',subcategory:'午饭',amount:1200,version:1,createdBy:'a'}];
 page.openExistingEntry({currentTarget:{dataset:{id:'row'}}});
 page.editEntry({currentTarget:{dataset:{key:'amount'}},detail:{value:'88'}});
 page.closeEntry();
 assert.equal(page.data.entryOpen,false);assert.equal(page.data.entry.amount,'');assert.equal(page.data.entries[0].amount,1200);assert.equal(calls.filter(c=>['add','update'].includes(c.a)).length,0);
 page.openExistingEntry({currentTarget:{dataset:{id:'row'}}});assert.equal(page.data.entry.amount,'12.00');
});
test('confirm submits once and closes only after successful save',async()=>{
 const h=pageHarness();const page=h.page;page._visible=true;page._generation=1;page._scope='user_a';page.data.loading=false;page.data.overview={};let reloads=0;page.load=async()=>{reloads++;};
 page.showEntryEditor({_id:'row',year:2026,date:'2026-11-09',type:'expense',category:'饮食',subcategory:'午饭',amount:'12.00',version:1},true);
 const saved=page.saveEntry();await page.saveEntry();assert.equal(page.data.entryOpen,true);assert.equal(h.calls.filter(c=>c.a==='update').length,1);
 h.resolveOverview({saved:true,history:{}});await saved;assert.equal(page.data.entryOpen,false);assert.equal(reloads,1);
});
