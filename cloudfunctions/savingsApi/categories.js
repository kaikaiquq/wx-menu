/** 稳定的大类；细分名称由用户输入，旧分类仅在读取/编辑时映射。 */
const EXPENSE = ['租房','零食','饮食','交通','生活','购物','旅游','礼金','医疗','教育','其他支出'];
const INCOME = ['工资','奖金','兼职','报销','投资','礼金','退款','其他收入'];
const ALIASES = {
  expense: {房租:'租房',房贷:'生活',餐饮:'饮食',早餐:'饮食',午餐:'饮食',晚餐:'饮食',买菜:'饮食',零食饮料:'零食',打车:'交通',水电燃气:'生活',通讯网络:'生活',日用百货:'生活',服饰美妆:'购物',医疗健康:'医疗',教育学习:'教育',娱乐:'生活',旅行:'旅游',人情礼物:'礼金',宠物:'生活',家居数码:'购物',保险:'生活'},
  income: {年终奖:'奖金',投资收益:'投资',其他:'其他收入'},
};
const categoriesFor = type => (type === 'income' ? INCOME : EXPENSE).slice();
const normalizeCategory = (type, category, subcategory = '') => {
  const major = categoriesFor(type).includes(category) ? category : (ALIASES[type]?.[category] || (type === 'income' ? '其他收入' : '其他支出'));
  return {category:major,subcategory:subcategory || (category && major !== category ? category : '')};
};
const groupEntries = entries => {
  const days = new Map();
  [...entries].sort((a,b)=>b.date.localeCompare(a.date)||b._id.localeCompare(a._id)).forEach(entry=>{
    if(!days.has(entry.date))days.set(entry.date,[]);
    days.get(entry.date).push(entry);
  });
  return [...days].map(([date,entries])=>({date,title:date.replace('-','年').replace('-','月')+'日',entries}));
};
module.exports = {categoriesFor,normalizeCategory,groupEntries};
