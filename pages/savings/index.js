const {requireSession,getSelfOpenid}=require('../../utils/auth');
const {getStoredThemeClass,syncTheme}=require('../../utils/theme');
const api=require('../../utils/savings');
const model=require('../../utils/savings-model');
const draftMethods=require('../../utils/savings-plan-draft');
const money=n=>(n/100).toFixed(2);
const today=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const fields=[['salary','税前月薪（元）'],['bonusMonths','额外年终奖（月薪倍数）'],['socialBase','社保月基数（留空按月薪）'],['housingBase','公积金月基数（留空按月薪）'],['pensionRate','个人养老（%）'],['medicalRate','个人医疗（%）'],['unemploymentRate','个人失业（%）'],['medicalFixed','个人医疗固定缴费（元/月）'],['housingRate','个人公积金（%）'],['employerHousingRate','单位公积金（%）'],['extraDeduction','专项附加等扣除（元/月）']].map(([key,label])=>({key,label}));
Page({
 data:{themeClass:getStoredThemeClass(),tab:0,year:new Date().getFullYear(),month:new Date().getMonth()+1,monthNames:Array.from({length:12},(_,i)=>`${i+1}月`),loading:true,error:'',plan:model.defaults(),fields,personOpen:0,dirty:false,savingPlan:false,busy:false,entries:[],cursor:'',overview:null,result:null,progressRows:[],budgetRows:[],categories:['其他'],entryOpen:false,entry:{type:'expense',amount:'',category:'其他',date:today(),note:''}},
 async onShow(){this._unloaded=false;this._visible=true;const g=this._generation=(this._generation||0)+1;this.getTabBar()?.init?.();const session=await requireSession({requireCouple:false});if(!session||!this.current(g))return;const expected=session.couple?.status==='active'?`couple_${session.couple.coupleId}`:`user_${session.user.openid}`;if(this._scope && this._scope!==expected){this.setData({overview:null,entries:[],plan:model.defaults(),dirty:false,result:null,entryOpen:false});this._requestId=null;this._conflict=null;this._confirmedPlan=null;}this.setData({themeClass:syncTheme(session.user.gender),scopeLabel:session.couple?.status==='active'?'双方共享账本 · 双方可见账目与薪资配置':'个人账本 · 当前仅自己可见'});await this.load();},
 current(g){return this._visible&&g===this._generation;},
 async onPullDownRefresh(){try{await this.load();}finally{wx.stopPullDownRefresh();}},
 async load(){if(this._saveFlight)await this._saveFlight;const g=this._generation;const request=this._loadRequest=(this._loadRequest||0)+1;this.setData({loading:true,error:''});try{
   const overview=await api('overview',{year:this.data.year});if(!this.current(g)||request!==this._loadRequest)return;
   const changed=this._scope&&this._scope!==overview.scope;this._scope=overview.scope;
   if(changed){this.setData({dirty:false,entries:[],entryOpen:false});this._requestId=null;this._conflict=null;}
   this.acceptOverview(overview);
   await this.loadEntries(false);
 }catch(e){if(this.current(g))this.setData({error:e.message||'加载失败'});}finally{if(this.current(g)&&request===this._loadRequest)this.setData({loading:false});}},
 async loadEntries(more){const g=this._generation;const year=this.data.year,scope=this._scope;const request=this._listRequest=(this._listRequest||0)+1;
 try{const data=await api('list',{year,scope,before:more?this.data.cursor:''});if(!this.current(g)||year!==this.data.year||scope!==this._scope||request!==this._listRequest)return;
 const rows=data.entries.map(e=>({...e,amountText:money(e.amount),mine:e.createdBy===getSelfOpenid(),typeText:e.type==='income'?'收入':'支出'}));this.setData({entries:more?[...this.data.entries,...rows]:rows,cursor:data.cursor});
 }catch(e){if(this.current(g))this.setData({error:e.message});}},
 more(){if(this.data.cursor&&!this._more){this._more=true;this.loadEntries(true).finally(()=>{this._more=false;});}},
 async changeYear(e){if(this.data.busy)return;const year=Number(e.detail.value.slice(0,4));if(year===this.data.year)return;const g=this._generation;if(!await this.flushPlan()||!this.current(g))return;this._generation++;this._requestId=null;this._conflict=null;this._confirmedPlan=null;this.setData({year,dirty:false,entries:[],entryOpen:false,plan:model.defaults(),overview:null,result:null});await this.load();},
 changeMonth(e){this.setData({month:Number(e.detail.value)+1});this.recalculate();},
 editPerson(e){if(this.data.loading||!this.data.overview)return;const {person,key}=e.currentTarget.dataset;this.setData({[`plan.people[${person}].${key}`]:e.detail.value,dirty:true});this.changedPlan();},
 changeMode(e){if(this.data.loading||!this.data.overview)return;this.setData({[`plan.people[${e.currentTarget.dataset.person}].mode`]:Number(e.detail.value)?'combined':'separate',dirty:true});this.changedPlan();},
 addBudget(){if(this.data.loading||!this.data.overview)return;if(this.data.plan.budgets.length>=30)return;this.setData({'plan.budgets':[...this.data.plan.budgets,{name:'',amount:'',period:'month'}],dirty:true});this.changedPlan();},
 editBudget(e){if(this.data.loading||!this.data.overview)return;const {index,key}=e.currentTarget.dataset;this.setData({[`plan.budgets[${index}].${key}`]:key==='period'?(Number(e.detail.value)?'year':'month'):e.detail.value,dirty:true});this.changedPlan();},
 removeBudget(e){if(this.data.loading||!this.data.overview)return;this.setData({'plan.budgets':this.data.plan.budgets.filter((_,i)=>i!==Number(e.currentTarget.dataset.index)),dirty:true});this.changedPlan();},
 recalculate(){try{const confirmed=this._confirmedPlan||this.data.overview?.plan||model.defaults();const result=model.calculate(confirmed,this.data.year);const months=this.data.overview?.months||Array.from({length:12},()=>({income:0,expense:0,categories:{}}));const month=months[this.data.month-1];const annual=months.reduce((a,m)=>({income:a.income+m.income,expense:a.expense+m.expense}),{income:0,expense:0});
 const rows=[['本月收入',month.income,result.net/12],['本月支出',month.expense,result.budget/12],['本月结余',month.income-month.expense,result.target/12],['全年累计收入',annual.income,result.net],['全年累计支出',annual.expense,result.budget],['全年累计结余',annual.income-annual.expense,result.target]].map(([label,actual,target])=>({label,actual:money(actual),target:money(target),...model.progress(actual,target)}));
 const budgetRows=confirmed.budgets.map(b=>{const target=model.amount(b.amount)*(b.period==='month'?12:1);const actual=months.reduce((n,m)=>n+(m.categories[b.name]||0),0);return {name:b.name,actual:money(actual),target:money(target),...model.progress(actual,target)};});
 this.setData({result:{...result,grossText:money(result.gross),netText:money(result.net),housingText:money(result.housing),budgetText:money(result.budget),targetText:money(result.target),people:result.people.map(p=>({...p,grossText:money(p.gross),netText:money(p.net),taxText:money(p.incomeTax),housingText:money(p.housing),personalHousingText:money(p.personalHousing),employerHousingText:money(p.employerHousing),separateText:money(p.separateTax),combinedText:money(p.combinedTax)}))},calcError:'',progressRows:rows,budgetRows,categories:[...new Set([...confirmed.budgets.map(b=>b.name).filter(Boolean),'工资','奖金','其他'])]});
 }catch(e){this.setData({calcError:e.message,result:null,progressRows:[],budgetRows:[]});}},
 openEntry(){this._requestId=null;this.setData({entryOpen:true,entry:{type:'expense',amount:'',category:this.data.categories[0],date:this.data.year===new Date().getFullYear()?today():`${this.data.year}-01-01`,note:''}});},
 closeEntry(){if(!this.data.busy)this.setData({entryOpen:false});},
 editEntry(e){if(this.data.busy)return;const key=e.currentTarget.dataset.key;let value=e.detail.value;if(key==='type')value=Number(value)?'income':'expense';if(key==='category')value=this.data.categories[Number(value)];this._requestId=null;this.setData({[`entry.${key}`]:value});},
 async saveEntry(){if(this.data.busy)return;try{if(model.amount(this.data.entry.amount)<=0)throw new Error('金额须大于零');}catch(e){wx.showToast({title:e.message,icon:'none'});return;}const g=this._generation;this._requestId=this._requestId||`${Date.now().toString(36)}_${Math.random().toString(36).slice(2,12)}`;this.setData({busy:true});try{await api('add',{year:this.data.year,scope:this._scope,requestId:this._requestId,...this.data.entry});if(!this.current(g))return;this._requestId=null;this.setData({entryOpen:false});await this.load();}catch(e){if(this.current(g))this.setData({error:e.message});}finally{this.setData({busy:false});}},
 confirm(content){return new Promise(resolve=>wx.showModal({title:'请确认',content,success:r=>resolve(r.confirm),fail:()=>resolve(false)}));},
 async removeEntry(e){if(this.data.busy)return;const g=this._generation;if(!await this.confirm('删除后将同步扣减统计，是否删除这笔账目？')||!this.current(g))return;this.setData({busy:true});try{await api('remove',{year:this.data.year,scope:this._scope,id:e.currentTarget.dataset.id,requestId:'delete_entry'});if(this.current(g))await this.load();}catch(error){if(this.current(g))this.setData({error:error.message});}finally{this.setData({busy:false});}},
 noop(){},
 ...draftMethods,
});
