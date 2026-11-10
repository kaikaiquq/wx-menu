const {requireSession,getSelfOpenid}=require('../../utils/auth');
const {getStoredThemeClass,syncTheme}=require('../../utils/theme');
const api=require('../../utils/savings');
const model=require('../../utils/savings-model');
const draftMethods=require('../../utils/savings-plan-draft');
const {categoriesFor,normalizeCategory,groupEntries}=require('../../utils/savings-categories');
const money=n=>(n/100).toFixed(2);
const today=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const fields=[['salary','税前月薪（元）'],['bonusMonths','额外年终奖（月薪倍数）'],['socialBase','社保月基数（留空按月薪）'],['housingBase','公积金月基数（留空按月薪）'],['pensionRate','个人养老（%）'],['medicalRate','个人医疗（%）'],['unemploymentRate','个人失业（%）'],['medicalFixed','个人医疗固定缴费（元/月）'],['housingRate','个人公积金（%）'],['employerHousingRate','单位公积金（%）'],['extraDeduction','专项附加等扣除（元/月）']].map(([key,label])=>({key,label}));
module.exports = (view = 'main') => ({
 data:{view,isEditor:view==='income'||view==='budget',entryType:'expense',statsPeriod:'month',statistics:null,statRows:[],memberLabels:['—','—'],themeClass:getStoredThemeClass(),tab:0,year:new Date().getFullYear(),month:new Date().getMonth()+1,monthNames:Array.from({length:12},(_,i)=>`${i+1}月`),loading:true,error:'',plan:model.defaults(),fields,personOpen:0,dirty:false,savingPlan:false,busy:false,entries:[],entryGroups:[],subcategorySuggestions:[],entryError:'',cursor:'',overview:null,result:null,progressRows:[],budgetRows:[],categories:['其他'],entryOpen:false,entry:{type:'expense',amount:'',category:'其他',date:today(),note:''}},
 onLoad(options={}){const year=Number(options.year),month=Number(options.month);if(Number.isInteger(year)&&year>=2020&&year<=2100)this.setData({year});if(Number.isInteger(month)&&month>=1&&month<=12)this.setData({month});},
 async onShow(){this._unloaded=false;this._visible=true;const g=this._generation=(this._generation||0)+1;this.getTabBar()?.init?.();const session=await requireSession({requireCouple:false});if(!session||!this.current(g))return;const expected=session.couple?.status==='active'?`couple_${session.couple.coupleId}`:`user_${session.user.openid}`;this._expectedScope=expected;const members=session.couple?.members||[session.user];this._selfName=session.user.nickname||'我';this._partnerName=members.find(m=>m.publicUserId&&m.publicUserId!==session.user.publicUserId)?.nickname||'对方';const memberLabels=['male','female'].map(gender=>{const matches=members.filter(m=>m.gender===gender);return matches.length===1?(matches[0].nickname||'未设置昵称'):(matches.length?'待确认姓名':'待绑定');});this.setData({memberLabels});if(this._scope && this._scope!==expected){this.setData({overview:null,entries:[],entryGroups:[],plan:model.defaults(),dirty:false,result:null,entryOpen:false,statistics:null,statRows:[]});this._requestId=null;this._conflict=null;this._confirmedPlan=null;this._history={};}this.setData({themeClass:syncTheme(session.user.gender),scopeLabel:session.couple?.status==='active'?'双方共享账本 · 双方可见账目与薪资配置':'个人账本 · 当前仅自己可见'});await this.load();},
 current(g){return this._visible&&g===this._generation;},
 async onPullDownRefresh(){try{await this.load();}finally{wx.stopPullDownRefresh();}},
 async load(){await this.waitForPlanSaves();if(this._saveFlight)await this._saveFlight;const g=this._generation;const request=this._loadRequest=(this._loadRequest||0)+1;this.setData({loading:true,error:''});try{
   const overview=await api('overview',{year:this.data.year});if(!this.current(g)||request!==this._loadRequest)return;
   const changed=this._scope&&this._scope!==overview.scope;this._scope=overview.scope;
   if(changed){this._history={};this.setData({dirty:false,entries:[],entryGroups:[],entryOpen:false,statistics:null,statRows:[]});this._requestId=null;this._conflict=null;}
   if(this.data.isEditor){this.acceptOverview(overview);this.setData({legacyMapping:Boolean(overview.plan&&!overview.plan.personGenders)});}
   else {this._confirmedPlan=overview.plan||model.defaults();this.setData({overview,plan:this._confirmedPlan,dirty:false});this.recalculate();}
   if(this.data.view==='main'&&this.data.tab===0)await this.loadEntries(false);
   if(this.data.view==='statistics')await this.loadStatistics();
 }catch(e){if(this.current(g))this.setData({error:e.message||'加载失败'});}finally{if(this.current(g)&&request===this._loadRequest)this.setData({loading:false});}},
 async loadEntries(more){const g=this._generation;const year=this.data.year,month=this.data.month,type=this.data.entryType,scope=this._scope;const request=this._listRequest=(this._listRequest||0)+1;
 try{const data=await api('list',{year,month,type,scope,before:more?this.data.cursor:''});if(!this.current(g)||year!==this.data.year||month!==this.data.month||type!==this.data.entryType||scope!==this._scope||request!==this._listRequest)return;
 const rows=data.entries.map(e=>({...e,...normalizeCategory(e.type,e.category,e.subcategory),amountText:money(e.amount),mine:e.createdBy===getSelfOpenid(),recorderName:e.createdByName||(e.createdBy===getSelfOpenid()?this._selfName||'我':this._partnerName||'对方'),typeText:e.type==='income'?'收入':'支出'}));
 const entries=more?[...new Map([...this.data.entries,...rows].map(e=>[e._id,e])).values()]:rows;
 this.setData({entries,entryGroups:groupEntries(entries),cursor:data.cursor});
 }catch(e){if(this.current(g)&&request===this._listRequest)this.setData({error:e.message});}},
 more(){if(this.data.cursor&&!this._more){this._more=true;this.loadEntries(true).finally(()=>{this._more=false;});}},
 async changeYear(e){if(this.data.busy)return;const year=Number(e.detail.value.slice(0,4));if(year===this.data.year)return;const g=this._generation;if(!await this.flushPlan()||!this.current(g))return;this._generation++;this._requestId=null;this._conflict=null;this._confirmedPlan=null;this._history={};this.setData({year,dirty:false,entries:[],entryGroups:[],entryOpen:false,plan:model.defaults(),overview:null,result:null});await this.load();},
 changeMonth(e){this.setData({month:Number(e.detail.value)+1});this.recalculate();},
 editPerson(e){if(this.data.loading||!this.data.overview)return;const {person,key}=e.currentTarget.dataset;this.setData({[`plan.people[${person}].${key}`]:e.detail.value,dirty:true});this.changedPlan();},
 changeMode(e){if(this.data.loading||!this.data.overview)return;this.setData({[`plan.people[${e.currentTarget.dataset.person}].mode`]:Number(e.detail.value)?'combined':'separate',dirty:true});this.changedPlan();},
 addBudget(){if(this.data.loading||!this.data.overview)return;if(this.data.plan.budgets.length>=30)return;this.setData({'plan.budgets':[...this.data.plan.budgets,{name:'',amount:'',period:'month'}],dirty:true});this.changedPlan();},
 editBudget(e){if(this.data.loading||!this.data.overview)return;const {index,key}=e.currentTarget.dataset;this.setData({[`plan.budgets[${index}].${key}`]:key==='period'?(Number(e.detail.value)?'year':'month'):e.detail.value,dirty:true});this.changedPlan();},
 removeBudget(e){if(this.data.loading||!this.data.overview)return;this.setData({'plan.budgets':this.data.plan.budgets.filter((_,i)=>i!==Number(e.currentTarget.dataset.index)),dirty:true});this.changedPlan();},
 recalculate(){try{const confirmed=this._confirmedPlan||this.data.overview?.plan||model.defaults();const result=model.calculate(confirmed,this.data.year);const months=this.data.overview?.months||Array.from({length:12},()=>({income:0,expense:0,categories:{}}));const month=months[this.data.month-1];const annual=months.reduce((a,m)=>({income:a.income+m.income,expense:a.expense+m.expense}),{income:0,expense:0});
 const rows=[['本月收入',month.income,result.monthlyNet],['本月支出',month.expense,result.budget/12],['本月结余',month.income-month.expense,result.monthlyNet-result.budget/12],['全年累计收入',annual.income,result.net],['全年累计支出',annual.expense,result.budget],['全年累计结余',annual.income-annual.expense,result.target]].map(([label,actual,target])=>({label,actual:money(actual),target:money(target),...model.progress(actual,target)}));
 const budgetRows=confirmed.budgets.map(b=>{const target=model.amount(b.amount)*(b.period==='month'?12:1);const actual=months.reduce((n,m)=>n+(m.categories[b.name]||0),0);return {name:b.name,actual:money(actual),target:money(target),...model.progress(actual,target)};});
 this.setData({result:{...result,monthlyNetText:money(result.monthlyNet),monthlyGrossText:money(result.monthlyGross),grossText:money(result.gross),netText:money(result.net),housingText:money(result.housing),budgetText:money(result.budget),targetText:money(result.target),people:result.people.map(p=>({...p,grossText:money(p.gross),monthlyNetText:money(p.monthlyNet),netText:money(p.net),taxText:money(p.incomeTax),housingText:money(p.housing),personalHousingText:money(p.personalHousing),employerHousingText:money(p.employerHousing),separateText:money(p.separateTax),combinedText:money(p.combinedTax)}))},calcError:'',progressRows:rows,budgetRows,categories:categoriesFor(this.data.entryType,confirmed.budgets),ledgerTotalText:money(month[this.data.entryType]),annualIncome:money(annual.income),annualExpense:money(annual.expense),annualBalance:money(annual.income-annual.expense),monthlyIncome:money(month.income),monthlyExpense:money(month.expense),monthlyIncomeTarget:money(result.monthlyNet)});
 }catch(e){this.setData({calcError:e.message,result:null,progressRows:[],budgetRows:[]});}},
 openEntry(){
  if(!this.data.overview||this.data.loading||this.data.busy)return;
  const period=`${this.data.year}-${String(this.data.month).padStart(2,'0')}`;
  const categories=categoriesFor(this.data.entryType);
  this.showEntryEditor({type:this.data.entryType,amount:'',category:categories[0],subcategory:'',date:today().startsWith(period)?today():period+'-01',note:''});
 },
 openExistingEntry(event){
  if(this.data.busy)return;
  const row=this.data.entries.find(e=>e._id===event.currentTarget.dataset.id);
  if(!row)return;
  this.showEntryEditor({...row,amount:money(row.amount),version:row.version||0},true);
 },
 showEntryEditor(entry,editing=false){
  this._requestId=null;this._entryPanel=(this._entryPanel||0)+1;
  this.setData({editingEntry:editing,entryOpen:true,entryError:'',entryStart:'2020-01-01',entryEnd:'2100-12-31',categories:categoriesFor(entry.type),entry});
  this.updateSubcategorySuggestions();this.loadSubcategoryHistory();
 },
 closeEntry(){
  if(this.data.busy)return;
  this._entryPanel=(this._entryPanel||0)+1;
  this._requestId=null;
  this.setData({entryOpen:false,editingEntry:false,entryError:'',subcategorySuggestions:[],entry:{type:this.data.entryType,amount:'',category:'',subcategory:'',date:'',note:''}});
 },
 async loadSubcategoryHistory(){
  const generation=this._generation,panel=this._entryPanel,scope=this._scope;
  try{
   const data=await api('history',{year:this.data.year,scope});
   if(!this.current(generation)||panel!==this._entryPanel||scope!==this._scope)return;
   this._history=data.history||{};this.updateSubcategorySuggestions();
  }catch(_){ /* 历史候选非必需，加载失败时仍可手动输入。 */ }
 },
 updateSubcategorySuggestions(){
  const {type,category,subcategory}=this.data.entry;
  const query=String(subcategory||'').trim().toLowerCase();
  const history=this._history?.[`${type}_${category}`]||[];
  const savedHere=this.data.entries.filter(e=>e.type===type&&e.category===category).map(e=>e.subcategory).filter(Boolean);
  this.setData({subcategorySuggestions:[...new Set([...history,...savedHere])].filter(s=>!query||s.toLowerCase().includes(query)).slice(0,30)});
 },
 editEntry(event){
  if(this.data.busy)return;
  const key=event.currentTarget.dataset.key;
  if(!['amount','date','category','subcategory','note'].includes(key))return;
  let value=event.detail.value;
  if(key==='category'){value=this.data.categories[Number(value)];if(!value)return;this.setData({'entry.subcategory':''});}
  this._requestId=null;this.setData({[`entry.${key}`]:value,entryError:''});
  if(key==='category'||key==='subcategory')this.updateSubcategorySuggestions();
 },
 chooseSubcategory(event){if(this.data.busy)return;this._requestId=null;this.setData({'entry.subcategory':event.currentTarget.dataset.value,entryError:''});this.updateSubcategorySuggestions();},
 async saveEntry(){
  if(this.data.busy)return;
  const entry=this.data.entry;
  try{if(model.amount(entry.amount)<=0)throw new Error('金额须大于零');if(String(entry.subcategory||'').trim().length>30)throw new Error('小类最多30字');}
  catch(error){this.setData({entryError:error.message});return;}
  const generation=this._generation;
  this._requestId=this._requestId||`${Date.now().toString(36)}_${Math.random().toString(36).slice(2,12)}`;
  this.setData({busy:true,entryError:''});
  try{
   await api(this.data.editingEntry?'update':'add',{year:this.data.editingEntry?entry.year:this.data.year,scope:this._scope,requestId:this._requestId,...entry,id:entry._id,entryVersion:entry.version||0});
   if(!this.current(generation))return;
   this._requestId=null;
   const [year,month]=entry.date.split('-').map(Number);
   this.setData({entryOpen:false,year,month,entries:[],entryGroups:[],cursor:''});
   await this.load();
  }catch(error){if(this.current(generation))this.setData({entryError:error.message});}
  finally{if(!this._unloaded)this.setData({busy:false});}
 },
 confirm(content){return new Promise(resolve=>wx.showModal({title:'请确认',content,success:r=>resolve(r.confirm),fail:()=>resolve(false)}));},
 async removeEntry(e){if(this.data.busy)return;const g=this._generation;const row=this.data.entries.find(r=>r._id===e.currentTarget.dataset.id);if(!row)return;if(!await this.confirm('删除后将同步扣减统计，是否删除这笔账目？')||!this.current(g))return;this.setData({busy:true});try{await api('remove',{year:this.data.year,scope:this._scope,id:e.currentTarget.dataset.id,entryVersion:row.version||0,requestId:'delete_entry'});if(this.current(g))await this.load();}catch(error){if(this.current(g))this.setData({error:error.message});}finally{this.setData({busy:false});}},
 noop(){},
 ...draftMethods,
 async changeTab(event){const tab=Number(event.currentTarget.dataset.tab);if(tab===this.data.tab)return;this.setData({tab});if(tab===0&&this._scope)await this.loadEntries(false);},
 async changeMonth(event){this.setData({month:Number(event.detail.value)+1,entries:[],entryGroups:[],cursor:''});this.recalculate();if(this.data.view==='statistics')await this.loadStatistics();else if(this.data.view==='main')await this.loadEntries(false);},
 async changePeriod(event){if(this.data.busy)return;const parts=event.detail.value.split('-').map(Number);const year=parts[0],month=parts[1]||this.data.month;if(!Number.isInteger(year)||!Number.isInteger(month)||month<1||month>12)return;this._generation++;this.setData({year,month,entries:[],entryGroups:[],cursor:'',overview:null,statistics:null});await this.load();},
 async selectEntryType(event){const type=event.currentTarget.dataset.type;if(!['income','expense'].includes(type)||type===this.data.entryType)return;this.setData({entryType:type,entries:[],entryGroups:[],cursor:''});this.recalculate();if(this.data.view==='statistics')this.renderStatistics();else await this.loadEntries(false);},
 async goEditor(event){const name=event.currentTarget.dataset.page;if(!['income','budget','statistics'].includes(name)||!this.data.overview||this.data.loading)return;wx.navigateTo({url:`/pages/savings/${name}?year=${this.data.year}&month=${this.data.month}`});},
 async saveAndBack(){if(await this.savePlan()&&this._visible)wx.navigateBack();},
 async changeStatsPeriod(event){this.setData({statsPeriod:event.currentTarget.dataset.period,statistics:null,statRows:[]});await this.loadStatistics();},
 async loadStatistics(){if(!this._scope)return;const generation=this._generation;const request=this._statsRequest=(this._statsRequest||0)+1;const year=this.data.year,month=this.data.month,period=this.data.statsPeriod;this.setData({statsLoading:true,statsError:'',statistics:null,statRows:[]});try{const statistics=await api('statistics',{year,scope:this._scope,...(period==='month'?{month}:{})});if(!this.current(generation)||request!==this._statsRequest)return;this.setData({statistics});this.renderStatistics();}catch(error){if(this.current(generation)&&request===this._statsRequest)this.setData({statsError:error.message,statistics:null,statRows:[]});}finally{if(this.current(generation)&&request===this._statsRequest)this.setData({statsLoading:false});}},
 renderStatistics(){const s=this.data.statistics;if(!s){this.setData({statRows:[]});return;}const total=s[this.data.entryType];const rows=s.rows.filter(r=>r.type===this.data.entryType).sort((a,b)=>b.amount-a.amount).map(r=>({...r,amountText:money(r.amount),...model.progress(r.amount,total)}));this.setData({statRows:rows,statIncome:money(s.income),statExpense:money(s.expense),statBalance:money(s.income-s.expense),statTotal:money(total)});},
});
