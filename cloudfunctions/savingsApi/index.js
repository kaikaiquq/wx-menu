const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const model = require('./model');
cloud.init({env:cloud.DYNAMIC_CURRENT_ENV});
const db = cloud.database();
const fail = (code,message) => { throw Object.assign(new Error(message),{code}); };
const optional = async (ref) => {
  try { const value=(await ref.get()).data; if(!value)return null; const clean={...value}; delete clean._id; return clean; }
  catch(e) { if (/document(?: with _id \S+)? (?:does )?not (?:exist|found)/i.test(e.message || '')) return null; throw e; }
};
const yearOf = (value) => { const y=Number(value); if (!Number.isInteger(y)||y<2020||y>2100) fail('INVALID','年份无效'); return y; };
const monthOf = (date,year) => {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date.slice(0,4)!==String(year) || new Date(`${date}T00:00:00Z`).toISOString().slice(0,10)!==date) fail('INVALID','日期无效');
  return Number(date.slice(5,7))-1;
};
const scope = async (tx,openid) => {
  const user = await optional(tx.collection('users').doc(openid));
  if (!user) fail('UNAUTHORIZED','请先登录');
  if (user.coupleId) {
    const couple = await optional(tx.collection('couples').doc(user.coupleId));
    if (couple?.status==='active' && couple.members?.length===2 && couple.members.includes(openid)) {
      const peer = await optional(tx.collection('users').doc(couple.members.find(id=>id!==openid)));
      if (peer?.coupleId!==user.coupleId) fail('SCOPE_CHANGED','绑定已变化，请刷新');
      return `couple_${user.coupleId}`;
    }
  }
  return `user_${openid}`;
};
const empty = () => ({version:0,plan:null,months:Array.from({length:12},()=>({income:0,expense:0,categories:{}}))});
exports.main = async (event={}) => {
  const {OPENID:openid}=cloud.getWXContext();
  if (!openid) return {ok:false,code:'UNAUTHORIZED',message:'请先登录'};
  try {
    const year=yearOf(event.year);
    // A single transaction keeps membership, entry and summary consistent. No client DB access.
    const data = await db.runTransaction(async tx => {
      const owner=await scope(tx,openid);
      if (event.scope && event.scope!==owner) fail('SCOPE_CHANGED','账本归属已变化，请重新进入');
      const ref=tx.collection('savingsYears').doc(`${owner}_${year}`);
      const current=await optional(ref) || empty();
      if (event.action==='overview') return {scope:owner,year,...current};
      if (event.action==='savePlan') {
        if (event.version!==current.version) fail('VERSION_CONFLICT','对方已更新数据，请刷新后重试');
        model.validatePlan(event.plan,year);
        const plan=JSON.parse(JSON.stringify(event.plan));
        // Bound document size and only retain fields defined by the calculator.
        const clean={people:plan.people.map(p=>Object.fromEntries(Object.keys(model.defaults().people[0]).map(k=>[k,String(p[k])]))),budgets:plan.budgets.map(b=>({name:b.name,amount:String(b.amount),period:b.period}))};
        if (JSON.stringify(clean).length>12000) fail('INVALID','配置过长');
        await ref.set({data:{...current,plan:clean,version:current.version+1,updatedAt:Date.now()}});
        return {saved:true};
      }
      if (!['add','remove','authorizeList'].includes(event.action)) fail('INVALID','操作无效');
      if (event.action==='authorizeList') return {scope:owner};
      if (typeof event.requestId!=='string'||!/^[a-zA-Z0-9_-]{8,80}$/.test(event.requestId)) fail('INVALID','请求标识无效');
      const id=event.requestId+'_'+crypto.createHash('sha256').update(`${owner}:${openid}:${event.requestId}`).digest('hex').slice(0,24);
      const entryRef=tx.collection('savingsEntries').doc(event.action==='remove'?String(event.id):id);
      const prior=await optional(entryRef);
      if (event.action==='add' && prior) return {saved:true,id};
      let entry;
      if (event.action==='add') {
        const cents=model.amount(event.amount);
        if (cents<=0 || !['income','expense'].includes(event.type)) fail('INVALID','请输入有效收支金额');
        const category=String(event.category||'其他').trim();
        if (!category || category.length>20 || ['__proto__','constructor','prototype'].includes(category)) fail('INVALID','分类无效');
        const date=String(event.date); monthOf(date,year);
        entry={owner,year,date,amount:cents,type:event.type,category,note:String(event.note||'').slice(0,100),createdBy:openid,createdAt:Date.now(),deleted:false};
      } else {
        if (!prior || prior.owner!==owner || prior.year!==year || prior.createdBy!==openid) fail('FORBIDDEN','只能删除本人在当前账本的记录');
        if (prior.deleted) return {removed:true};
        entry=prior;
      }
      const months=JSON.parse(JSON.stringify(current.months));
      const m=months[monthOf(entry.date,year)];
      const delta=entry.amount*(event.action==='add'?1:-1);
      m[entry.type]+=delta;
      if (entry.type==='expense') m.categories[entry.category]=(m.categories[entry.category]||0)+delta;
      await entryRef.set({data:{...entry,deleted:event.action==='remove'}});
      await ref.set({data:{...current,months,version:current.version+1,updatedAt:Date.now()}});
      return {saved:true,id};
    });
    return {ok:true,data};
  } catch(e) { console.error('savingsApi',e.code||e.errCode); return {ok:false,code:e.code||'SERVER_ERROR',message:e.code?e.message:'储蓄服务暂不可用，请检查集合与云函数部署'}; }
};
// Listing is read-only; authorize before and after the bounded query so an unbind cannot return old data.
const main=exports.main;
exports.main=async(event={})=>{
  if(event.action!=='list')return main(event);
  const auth=await main({...event,action:'authorizeList'}); if(!auth.ok)return auth;
  try {
    const where={owner:auth.data.scope,year:yearOf(event.year),deleted:false};
    if(event.before)where._id=db.command.lt(String(event.before));
    const {data}=await db.collection('savingsEntries').where(where).orderBy('_id','desc').limit(30).get();
    const checked=await main({...event,action:'authorizeList',scope:auth.data.scope}); if(!checked.ok)return checked;
    return {ok:true,data:{entries:data,cursor:data.length===30?data[data.length-1]._id:''}};
  }catch(e){return {ok:false,code:'SERVER_ERROR',message:'账目加载失败，请检查索引'};}
};
