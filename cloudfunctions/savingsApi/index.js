const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const model = require('./model');
const {normalizeCategory}=require('./categories');
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
        const clean={personGenders:['male','female'],people:plan.people.map(p=>Object.fromEntries(Object.keys(model.defaults().people[0]).map(k=>[k,String(p[k])]))),budgets:plan.budgets.map(b=>({name:b.name,amount:String(b.amount),period:b.period}))};
        if (JSON.stringify(clean).length>12000) fail('INVALID','配置过长');
        await ref.set({data:{...current,plan:clean,version:current.version+1,updatedAt:Date.now()}});
        return {saved:true};
      }
      if (!['add','update','remove','history','authorizeList'].includes(event.action)) fail('INVALID','操作无效');
      if (event.action==='authorizeList') return {scope:owner,version:current.version};
      if (event.action==='history') {
        const history=await optional(tx.collection('savingsCategories').doc(owner));
        return {scope:owner,history:history?.history||{}};
      }
      if (typeof event.requestId!=='string'||!/^[a-zA-Z0-9_-]{8,80}$/.test(event.requestId)) fail('INVALID','请求标识无效');
      const id=event.requestId+'_'+crypto.createHash('sha256').update(`${owner}:${openid}:${event.requestId}`).digest('hex').slice(0,24);
      const editing = event.action === 'update';
      const removing = event.action === 'remove';
      const entryId = editing || removing ? String(event.id || '') : id;
      if (!entryId || entryId.length > 128 || entryId.includes('/')) fail('INVALID','记录标识无效');
      const entryRef = tx.collection('savingsEntries').doc(entryId);
      const prior = await optional(entryRef);
      if (event.action === 'add' && prior) return {saved:true,id:entryId};
      if (editing || removing) {
        // 当前账本双方可操作；作者不可由客户端改写。
        if (!prior || prior.owner !== owner) fail('FORBIDDEN','没有操作这笔记录的权限');
        if (editing && !prior.deleted && prior.updatedBy === openid && prior.lastMutationId === event.requestId) return {saved:true,id:entryId,year:prior.year};
        if (prior.year !== year) fail('ENTRY_CONFLICT','记录日期已变更，请刷新后重试');
        if (removing && prior.deleted) return {removed:true};
        if (prior.deleted) fail('ENTRY_DELETED','记录已被删除，请刷新');
        if ((editing || event.entryVersion !== undefined) && event.entryVersion !== (prior.version || 0)) fail('ENTRY_CONFLICT','这笔记录已被修改，请关闭编辑并刷新后重试');
      }
      let entry = prior;
      let destinationYear = year;
      if (!removing) {
        const cents = model.amount(event.amount);
        const type = editing ? prior.type : event.type;
        if (cents <= 0 || !['income','expense'].includes(type)) fail('INVALID','请输入有效收支金额');
        const rawCategory = String(event.category || '其他').trim();
        if (!rawCategory || rawCategory.length > 20 || ['__proto__','constructor','prototype'].includes(rawCategory)) fail('INVALID','分类无效');
        const subcategory = String(event.subcategory || '').trim();
        if (subcategory.length > 30) fail('INVALID','小类最多30字');
        const normalized = normalizeCategory(type, rawCategory, subcategory);
        const date = String(event.date);
        destinationYear = yearOf(date.slice(0,4));
        monthOf(date,destinationYear);
        const user = await optional(tx.collection('users').doc(openid));
        entry = {
          ...(prior || {}),owner,year:destinationYear,date,amount:cents,type,...normalized,
          note:String(event.note || '').slice(0,100),createdBy:prior?.createdBy || openid,
          createdByName:prior?.createdByName || (prior ? '' : String(user?.nickname || '')),
          createdAt:prior?.createdAt || Date.now(),deleted:false,
          version:(prior?.version || 0)+1,lastMutationId:event.requestId,updatedBy:openid,updatedAt:Date.now(),
        };
      }
      const targetRef = destinationYear === year ? ref : tx.collection('savingsYears').doc(`${owner}_${destinationYear}`);
      const target = destinationYear === year ? current : (await optional(targetRef) || empty());
      const historyRef = tx.collection('savingsCategories').doc(owner);
      const categoryState = !removing ? (await optional(historyRef) || {history:{}}) : null;
      const sourceMonths = JSON.parse(JSON.stringify(current.months));
      const targetMonths = destinationYear === year ? sourceMonths : JSON.parse(JSON.stringify(target.months));
      const apply = (months,row,sign) => {
        const bucket = months[monthOf(row.date,row.year)];
        bucket[row.type] += row.amount * sign;
        if (row.type === 'expense') bucket.categories[row.category] = (bucket.categories[row.category] || 0) + row.amount * sign;
      };
      if (editing || removing) apply(sourceMonths,prior,-1);
      if (!removing) apply(targetMonths,entry,1);
      await entryRef.set({data:removing ? {...prior,deleted:true,version:(prior.version||0)+1,updatedBy:openid,updatedAt:Date.now()} : entry});
      await ref.set({data:{...current,months:sourceMonths,version:current.version+1,updatedAt:Date.now()}});
      if (destinationYear !== year) await targetRef.set({data:{...target,months:targetMonths,version:target.version+1,updatedAt:Date.now()}});
      if (categoryState && entry.subcategory) {
        const history = {...categoryState.history};
        const historyKey = `${entry.type}_${entry.category}`;
        history[historyKey] = [entry.subcategory,...(history[historyKey] || []).filter(s=>s!==entry.subcategory)].slice(0,30);
        await historyRef.set({data:{history,updatedAt:Date.now()}});
      }
      return {saved:true,id:entryId,year:destinationYear};
    });
    return {ok:true,data};
  } catch(e) { console.error('savingsApi',e.code||e.errCode); return {ok:false,code:e.code||'SERVER_ERROR',message:e.code?e.message:'储蓄服务暂不可用，请检查集合与云函数部署'}; }
};
// Reads constrain owner and period on the server. Statistics aggregate all records,
// independent of the 30-row list window, including historical income categories.
const main = exports.main;
const readFilter = (event, owner) => {
  const year = yearOf(event.year);
  const where = {owner, year, deleted:false};
  if (event.type !== undefined) {
    if (!['income','expense'].includes(event.type)) fail('INVALID','收支类型无效');
    where.type = event.type;
  }
  if (event.month !== undefined && event.month !== '') {
    const month = Number(event.month);
    if (!Number.isInteger(month) || month < 1 || month > 12) fail('INVALID','月份无效');
    const prefix = `${year}-${String(month).padStart(2,'0')}`;
    const days = new Date(Date.UTC(year,month,0)).getUTCDate();
    where.date = db.command.gte(`${prefix}-01`).and(db.command.lte(`${prefix}-${days}`));
  }
  return where;
};
exports.main = async (event = {}) => {
  if (!['list','statistics'].includes(event.action)) return main(event);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const auth = await main({...event, action:'authorizeList'});
      if (!auth.ok) return auth;
      const where = readFilter(event,auth.data.scope);
      let result;
      if (event.action === 'list') {
        let filter = where;
        if (event.before) {
          if (typeof event.before === 'object' && typeof event.before.date === 'string' && typeof event.before.id === 'string') {
            filter = db.command.and([where,db.command.or([{date:db.command.lt(event.before.date)},{date:event.before.date,_id:db.command.lt(event.before.id)}])]);
          } else if (typeof event.before === 'string') filter = {...where,_id:db.command.lt(event.before)};
          else fail('INVALID','分页标识无效');
        }
        const {data} = await db.collection('savingsEntries').where(filter).orderBy('date','desc').orderBy('_id','desc').limit(30).get();
        const tail = data[data.length-1];
        result = {entries:data.map(row=>({...row,...normalizeCategory(row.type,row.category,row.subcategory)})),cursor:data.length===30?{date:tail.date,id:tail._id}:''};
      } else {
        const rows = [];
        const $ = db.command.aggregate;
        for (let skip = 0; ; skip += 100) {
          const {list} = await db.collection('savingsEntries').aggregate().match(where)
            .group({_id:{type:'$type',category:'$category'},amount:$.sum('$amount'),count:$.sum(1)})
            .sort({'_id.type':1,'_id.category':1}).skip(skip).limit(100).end();
          rows.push(...list.map(row => ({type:row._id.type,category:row._id.category,amount:row.amount,count:row.count})));
          if (list.length < 100) break;
        }
        const merged = new Map();
        rows.forEach(row=>{
          const category=normalizeCategory(row.type,row.category).category;
          const key=row.type+'_'+category;
          const item=merged.get(key)||{type:row.type,category,amount:0,count:0};
          item.amount+=row.amount;item.count+=row.count;merged.set(key,item);
        });
        const normalizedRows=[...merged.values()];
        result = {rows:normalizedRows,income:rows.filter(r=>r.type==='income').reduce((n,r)=>n+r.amount,0),expense:rows.filter(r=>r.type==='expense').reduce((n,r)=>n+r.amount,0)};
      }
      const checked = await main({...event,action:'authorizeList',scope:auth.data.scope});
      if (!checked.ok) return checked;
      if (event.action==='statistics' && checked.data.version!==auth.data.version) continue;
      return {ok:true,data:result};
    }
    return {ok:false,code:'DATA_CHANGED',message:'账本正在更新，请重试统计'};
  } catch (error) {
    return {ok:false,code:error.code||'SERVER_ERROR',message:error.code?error.message:'账目查询失败，请检查云函数及索引'};
  }
};
