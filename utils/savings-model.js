/** 中国大陆居民工资薪金年度估算；所有对外金额为分。纯计算，无网络和存储。 */
const MONEY_MAX = 100000000;
const amount = (v, name = '金额') => {
  if (!/^(?:\d+)(?:\.\d{1,2})?$/.test(String(v === '' ? 0 : v))) throw new Error(`${name}请填写非负数字，最多两位小数`);
  const n = Math.round(Number(v) * 100);
  if (!Number.isSafeInteger(n) || n > MONEY_MAX * 100) throw new Error(`${name}超出范围`);
  return n;
};
const numeric = (v, max, label) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max) throw new Error(`${label}须为 0–${max}`);
  return n;
};
const bands = [[3600000,.03,0],[14400000,.1,252000],[30000000,.2,1692000],[42000000,.25,3192000],[66000000,.3,5292000],[96000000,.35,8592000],[Infinity,.45,18192000]];
const tax = (income) => {
  const base = Math.max(0, income);
  const row = bands.find(([limit]) => base <= limit);
  return Math.round(base * row[1] - row[2]);
};
const bonusTax = (income) => {
  const row = bands.find(([limit]) => income <= limit);
  return Math.max(0, Math.round(income * row[1] - row[2] / 12));
};
const personDefaults = () => ({ salary:'', bonusMonths:'0', socialBase:'', housingBase:'', pensionRate:'8', medicalRate:'2', unemploymentRate:'0.5', medicalFixed:'0', housingRate:'7', employerHousingRate:'7', extraDeduction:'0', mode:'separate' });
const defaults = () => ({ people:[personDefaults(),personDefaults()], budgets:[], personGenders:['male','female'] });
const validatePlan = (plan, year) => {
  if (!plan || !Array.isArray(plan.people) || plan.people.length !== 2 || !Array.isArray(plan.budgets) || plan.budgets.length > 30) throw new Error('测算配置无效');
  plan.people.forEach((p) => calculatePerson(p, year));
  const names = new Set();
  plan.budgets.forEach((b) => {
    if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 20 || ['__proto__','constructor','prototype'].includes(b.name) || names.has(b.name)) throw new Error('预算名称不能为空、重复或超过20字');
    names.add(b.name);
    if (!['month','year'].includes(b.period)) throw new Error('预算周期无效');
    amount(b.amount, '预算');
  });
  return plan;
};
const calculatePerson = (p, year) => {
  if (!p || !['separate','combined'].includes(p.mode)) throw new Error('请选择计税方式');
  if (p.mode === 'separate' && year > 2027) throw new Error('单独计税现行政策截至2027年，请改用合并计税');
  const salary = amount(p.salary, '月薪');
  const socialBase = p.socialBase === '' ? salary : amount(p.socialBase, '社保基数');
  const housingBase = p.housingBase === '' ? salary : amount(p.housingBase, '公积金基数');
  const social = ['pensionRate','medicalRate','unemploymentRate'].reduce((n,key) => n + Math.round(socialBase * numeric(p[key],100,'社保比例') / 100), amount(p.medicalFixed,'医疗固定缴费'));
  const housing = Math.round(housingBase * numeric(p.housingRate,100,'个人公积金比例') / 100);
  const employerHousing = Math.round(housingBase * numeric(p.employerHousingRate,100,'单位公积金比例') / 100);
  if (social + housing > salary) throw new Error('个人五险一金不能超过月薪，请检查基数和比例');
  const bonus = Math.round(salary * numeric(p.bonusMonths,36,'年终奖月数'));
  const gross = salary * 12 + bonus;
  const deductions = (social + housing + amount(p.extraDeduction,'每月专项附加扣除')) * 12 + 6000000;
  const separateTax = tax(salary * 12 - deductions) + bonusTax(bonus);
  const combinedTax = tax(gross - deductions);
  const incomeTax = p.mode === 'separate' ? separateTax : combinedTax;
  const monthlyNet = salary - social - housing - Math.round(tax(salary * 12 - deductions) / 12);
  return { monthlyGross: salary, monthlyNet, gross, incomeTax, net:gross-(social+housing)*12-incomeTax, social:social*12, personalHousing:housing*12, employerHousing:employerHousing*12, housing:(housing+employerHousing)*12, separateTax, combinedTax };
};
const calculate = (plan, year) => {
  validatePlan(plan,year);
  const people = plan.people.map(p=>calculatePerson(p,year));
  const sum = (key) => people.reduce((n,p)=>n+p[key],0);
  const budget = plan.budgets.reduce((n,b)=>n+amount(b.amount)*(b.period==='month'?12:1),0);
  return { people, monthlyGross:sum('monthlyGross'), monthlyNet:sum('monthlyNet'), gross:sum('gross'), net:sum('net'), housing:sum('housing'), incomeTax:sum('incomeTax'), budget, target:sum('net')-budget };
};
const progress = (actual, target) => ({ percent:target>0 ? `${(actual/target*100).toFixed(1)}%` : '未设正目标', width:target>0 ? Math.min(100,Math.max(0,actual/target*100)) : 0 });
module.exports = { amount, tax, bonusTax, defaults, calculatePerson, calculate, validatePlan, progress };
