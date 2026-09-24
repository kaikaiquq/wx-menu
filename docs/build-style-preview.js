#!/usr/bin/env node
/* Static visual QA only. Reads the production WXML/WXSS; does not call wx or cloud APIs. */
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const escape = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const evaluate = (expression, data) => {
  try { return Function('data', 'with (data) { return (' + expression + '); }')(data); }
  catch { return undefined; }
};
const expression = (value, data) => {
  const match = /^{{([\s\S]*?)}}$/.exec(value || '');
  return match ? evaluate(match[1], data) : value;
};
const interpolate = (value, data) => (value || '').replace(/{{([\s\S]*?)}}/g, (_, code) => escape(evaluate(code, data)));

function parse(source) {
  const top = { children: [] };
  const stack = [top];
  const tags = /<!--[\s\S]*?-->|<\/?[\w-]+(?:\s+(?:[^<>"']|"[^"]*"|'[^']*')*)?\s*\/?>/g;
  let cursor = 0;
  let match;
  while ((match = tags.exec(source))) {
    if (match.index > cursor) stack[stack.length - 1].children.push(source.slice(cursor, match.index));
    const tag = match[0];
    cursor = tags.lastIndex;
    if (tag.startsWith('<!--')) continue;
    if (tag.startsWith('</')) { stack.pop(); continue; }
    const name = /^<([\w-]+)/.exec(tag)[1];
    const attrs = {};
    const body = tag.slice(name.length + 1).replace(/\/?\s*>$/, '');
    const attrRe = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g;
    let attr;
    while ((attr = attrRe.exec(body))) attrs[attr[1]] = attr[2] === undefined ? (attr[3] === undefined ? '' : attr[3]) : attr[2];
    const node = { name, attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!/\/\s*>$/.test(tag)) stack.push(node);
  }
  if (cursor < source.length) top.children.push(source.slice(cursor));
  return top.children;
}

function mapIllustration() {
  return '<div class="preview-map" role="img" aria-label="地图示意，非实时地图">' +
    '<svg viewBox="0 0 600 450" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><rect width="600" height="450" fill="var(--love-surface-muted)"/><path d="M-30 80L640 310M80-30L310 510M-40 330L640 70" stroke="var(--love-surface)" stroke-width="26" fill="none"/><path d="M420-40Q300 210 650 400" stroke="var(--love-soft-strong)" stroke-width="48" fill="none"/><path d="M-20 175L640 395M120-40L460 490" stroke="var(--love-border)" stroke-width="3" fill="none"/><circle cx="320" cy="190" r="19" fill="var(--love-primary)" stroke="var(--love-surface)" stroke-width="5"/><circle cx="180" cy="300" r="14" fill="var(--love-text-secondary)" stroke="var(--love-surface)" stroke-width="5"/><text x="320" y="150" text-anchor="middle" fill="var(--love-primary)" font-size="23" font-family="sans-serif">TA</text><text x="180" y="345" text-anchor="middle" fill="var(--love-text)" font-size="23" font-family="sans-serif">我</text></svg>' +
    '<span class="preview-map-label">地图示意 · 非实时位置</span></div>';
}

function renderNode(node, data, inLoop = false) {
  if (typeof node === 'string') return interpolate(node, data);
  const { attrs, name, children } = node;
  if (attrs['wx:for'] !== undefined && !inLoop) {
    const list = expression(attrs['wx:for'], data) || [];
    return Array.from(list).map((item, index) => renderNode(node, {
      ...data, [attrs['wx:for-item'] || 'item']: item, [attrs['wx:for-index'] || 'index']: index,
    }, true)).join('');
  }
  if (name === 'block') return renderNodes(children, data);
  const outputName = name === 'image' ? 'img' : name === 'map' ? 'div' : name;
  const attributes = Object.entries(attrs).filter(([key]) => !/^(wx:|bind|catch|capture-|open-type|mode|enhanced|scroll-into-view|scroll-with-animation|markers|include-points|latitude|longitude)/.test(key)).map(([key, value]) => {
    if (['disabled', 'checked', 'selected'].includes(key) && !expression(value, data)) return '';
    if (key === 'aria-role') key = 'role';
    if (key === 'placeholder-class') return '';
    return ` ${key}="${interpolate(value, data)}"`;
  }).join('');
  if (['input', 'img'].includes(outputName)) return `<${outputName}${attributes}>`;
  if (outputName === 'textarea') return `<textarea${attributes}>${escape(expression(attrs.value, data) || '')}</textarea>`;
  return `<${outputName}${attributes}>${name === 'map' ? mapIllustration() : renderNodes(children, data)}</${outputName}>`;
}

function renderNodes(nodes, data) {
  let branchMatched = false;
  return nodes.map((node) => {
    if (typeof node === 'string') return renderNode(node, data);
    const attrs = node.attrs;
    if (attrs['wx:if'] !== undefined) {
      branchMatched = Boolean(expression(attrs['wx:if'], data));
      if (!branchMatched) return '';
    } else if (attrs['wx:elif'] !== undefined) {
      if (branchMatched) return '';
      branchMatched = Boolean(expression(attrs['wx:elif'], data));
      if (!branchMatched) return '';
    } else if (attrs['wx:else'] !== undefined) {
      if (branchMatched) return '';
      branchMatched = true;
    } else branchMatched = false;
    return renderNode(node, data);
  }).join('');
}

function style(file, seen = new Set()) {
  if (seen.has(file)) return '';
  seen.add(file);
  return read(file).replace(/@import\s+['"]([^'"]+)['"]\s*;/g, (_, importPath) => style(path.join(path.dirname(file), importPath), seen))
    .replace(/(-?(?:\d*\.)?\d+)rpx\b/g, (_, number) => `${Number((Number(number) / 7.5).toFixed(6))}vw`)
    .replace(/(^|\n)([ \t]*)page(?=\s*[,>{])/g, '$1$2body');
}

const categories = [
  { id: 'dinner', name: '好好吃饭', subtitle: '烟火里的浪漫', avatarText: '食', avatarColor: '#84705f' },
  { id: 'date', name: '约会清单', subtitle: '留一点时间给你', avatarText: '约', avatarColor: '#61766a' },
  { id: 'movie', name: '一起看电影', subtitle: '两个人的好时光', avatarText: '映', avatarColor: '#657487' },
];
const items = [
  { id: 'a', name: '一起做一顿晚餐', description: '买点喜欢的食材，把普通日子过得认真一点。', cost: '一个拥抱', avatarText: '晚', avatarColor: '#84705f', badge: '今日推荐', quantity: 1 },
  { id: 'b', name: '周末的城市散步', description: '不赶路，也没有目的地。', cost: '牵手一整天', avatarText: '行', avatarColor: '#61766a', quantity: 2 },
  { id: 'c', name: '找一家安静的小店', description: '好好吃饭，慢慢聊天。', cost: '三个亲亲', avatarText: '食', avatarColor: '#657487', quantity: 1 },
];
const tabs = [
  { url: '/pages/home/home', text: '今天', icon: 'home' },
  { url: '/pages/category/index', text: '点单', icon: 'menu' },
  { url: '/pages/location/index', text: '位置', icon: 'location' },
  { url: '/pages/chat/index', text: '消息', icon: 'chat' },
  { url: '/pages/usercenter/index', text: '我们', icon: 'us' },
];
const pages = [
  { key: 'home', label: '今天', file: 'pages/home/home', tab: 0, data: {
    loading: false, dateText: '9月24日 · 星期四', wishCount: 3, showWishAlert: false,
    sharedMessage: '慢慢来，\n我们还有很多个明天。', categories, featuredItems: items.slice(0, 2), activeOrder: null, orderNotice: null, showResponseSheet: false,
  } },
  { key: 'category', label: '点单', file: 'pages/category/index', tab: 1, data: {
    loading: false, categories, wishCount: 3, activeCategory: 'dinner', activeCategoryName: '好好吃饭', visibleItems: items,
  } },
  { key: 'location', label: '位置', file: 'pages/location/index', tab: 2, data: {
    loading: false, hasMap: true, hasPartner: true, hasSelf: true, hasPartnerPoint: true, sharing: true,
    followMode: 'partner', partnerName: '小满', partnerStale: false, selfStale: false,
    partnerUpdateText: '刚刚更新 · 精度约 15 米', selfUpdateText: '刚刚更新 · 前台共享中', viewText: '正在查看 TA 的位置',
    connectionText: '', privacyRequired: false, permissionDenied: false, errorText: '', actionPending: false,
  } },
  { key: 'chat', label: '消息', file: 'pages/chat/index', tab: 3, data: {
    loading: false, showFriends: false, activeId: 'couple', activeTitle: '小满', avatarMap: {}, imageUrlMap: {}, myOpenid: 'me', voiceMode: false,
    draft: '', showEmoji: false, showVoiceOverlay: false, sending: false, connectionText: '',
    conversations: [{ id: 'couple', title: '小满', isCouple: true, unreadCount: 0, peer: {} }, { id: 'friend', title: '周小木', isCouple: false, unreadCount: 2, peer: {} }],
    messages: [
      { id: 'm1', fromOpenid: 'other', fromNickname: '小满', timeText: '17:42', isMine: false, msgType: 'text', text: '今天想早点回家，\n一起做晚饭吧。' },
      { id: 'm2', fromOpenid: 'me', fromNickname: '我', timeText: '17:43', isMine: true, msgType: 'text', text: '好呀，你想吃什么？' },
      { id: 'm3', fromOpenid: 'other', fromNickname: '小满', timeText: '17:43', isMine: false, msgType: 'text', text: '已经放进我们的心愿单了 ♡' },
      { id: 'm4', fromOpenid: 'me', fromNickname: '我', timeText: '17:44', isMine: true, msgType: 'voice', voiceDuration: 6 },
    ],
  } },
  { key: 'usercenter', label: '我们', file: 'pages/usercenter/index', tab: 4, data: {
    coupleStatus: 'active', displayMembers: [{ publicUserId: 'me', fallbackLabel: '我', nickname: '林间' }, { publicUserId: 'other', fallbackLabel: '满', nickname: '小满' }],
    profile: { anniversary: '2025-03-18', anniversaryText: '2025.03.18' }, coupleDays: 555, orderCount: 28,
    historyOrders: [{ id: 'done' }], latestOrder: { id: 'done', dateText: '09月21日 · 周日', status: '已完成', itemNames: '一起去看日落', note: '那天的晚霞，刚好和你一样好看。', responseText: '小满：下次还想和你一起去', items: [] },
    showWishDetail: false, showHistorySheet: false, showProfileEditor: false,
  } },
  { key: 'wish', label: '心愿单', file: 'pages/wish/index', tab: -1, data: { wishItems: items.slice(0, 2), totalCount: 3, note: '周五晚上，想和你一起。', submitting: false } },
];
const baseCss = 'html,body{margin:0;padding:0;}view,scroll-view,picker{display:block;}text{display:inline;}button,input,textarea{font:inherit;}button{cursor:pointer;border:0;}button::after{border:0;}input,textarea{min-width:0;}scroll-view[scroll-x]{overflow-x:auto;overflow-y:hidden;scrollbar-width:none;}scroll-view[scroll-y]{overflow-y:auto;overflow-x:hidden;scrollbar-width:none;}img{object-fit:cover;}view[role="button"]{cursor:pointer;}.preview-map{height:100%;position:relative;overflow:hidden;}.preview-map svg{height:100%;width:100%;display:block;}.preview-map-label{position:absolute;left:14px;top:12px;background:var(--love-surface);color:var(--love-text-secondary);padding:5px 8px;border-radius:4px;font-size:11px;}';
const tabTemplate = parse(read('custom-tab-bar/index.wxml'));
const outputPages = pages.map((page) => {
  const template = parse(read(`${page.file}.wxml`));
  const css = [baseCss, style('app.wxss'), style(`${page.file}.wxss`), page.tab >= 0 ? style('custom-tab-bar/index.wxss') : ''].join('\n');
  const frames = {};
  for (const gender of ['female', 'male']) {
    const themeClass = `theme-${gender}`;
    const body = renderNodes(template, { ...page.data, themeClass });
    const tab = page.tab >= 0 ? renderNodes(tabTemplate, { themeClass, active: page.tab, list: tabs, chatUnread: page.tab === 3 ? 0 : 2 }) : '';
    frames[gender] = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${page.label} · ${gender}</title><style>${css}</style></head><body class="${themeClass}">${body}${tab}</body></html>`;
  }
  return { key: page.key, label: page.label, frames };
});
const serialized = JSON.stringify(outputPages).replace(/<\/script/gi, '<\\/script');
const output = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>两人菜单 · 样式对照预览</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#e9e9e5;color:#262b28;font:14px/1.6 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif}header{padding:24px 32px;background:#fafaf7;border-bottom:1px solid #d9ddd5}h1{font-size:22px;letter-spacing:.04em;margin:0 0 6px;font-weight:600}p{margin:0;color:#60675e;font-size:13px}.controls{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin-top:18px}label{display:flex;align-items:center;gap:8px}select,button{font:inherit;background:white;border:1px solid #c9cfc5;border-radius:6px;padding:8px 14px;color:#293328;cursor:pointer}.toggle{display:flex;gap:6px;margin-left:auto}.toggle button[aria-pressed=true]{background:#354b3e;color:white;border-color:#354b3e}main{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:center;gap:36px;padding:28px 32px 48px}.phone{margin:0;flex-shrink:0;width:var(--phone-width,390px)}.caption{margin:0 0 12px;display:flex;justify-content:space-between;align-items:baseline}.caption strong{font-size:15px;font-weight:600}.caption span{font-size:12px;color:#6b7269}.screen{border:1px solid #c7ccc3;border-radius:18px;overflow:hidden;background:white;box-shadow:0 12px 32px #2831230d}.native-header{height:44px;display:flex;justify-content:center;align-items:center;font-size:13px;font-weight:600;position:relative}.native-header::after{content:'•••  ◯';position:absolute;right:12px;border:1px solid #0002;border-radius:18px;font-size:13px;padding:0 10px}.female .native-header{background:#f6f3ef;color:#302825}.male .native-header{background:#f0f3f5;color:#202e38}iframe{display:block;border:0;width:100%;height:var(--phone-height,720px)}.footnote{padding:0 32px 24px;color:#687064;font-size:12px;text-align:center}.single .phone{display:none}.single[data-gender=female] .phone.female,.single[data-gender=male] .phone.male{display:block}@media(max-width:700px){header{padding:20px}.toggle{margin-left:0}main{justify-content:flex-start;padding:24px 20px;gap:24px}}
</style></head><body>
<header><h1>两人菜单 · 视觉设计对照</h1><p>女生：暖白与莓棕，柔和圆角与宋体标题。男生：冷雾与深海墨，利落圆角与无衬线标题。</p><div class="controls"><label>页面 <select id="page">${pages.map((p) => `<option value="${p.key}">${p.label}</option>`).join('')}</select></label><label>视口 <select id="width"><option value="320">320 px · 小屏</option><option value="390" selected>390 px · 标准</option><option value="430">430 px · 大屏</option></select></label><div class="toggle"><button data-mode="both" aria-pressed="true">双主题</button><button data-mode="female" aria-pressed="false">女生</button><button data-mode="male" aria-pressed="false">男生</button></div></div></header>
<main id="compare"><figure class="phone female"><figcaption class="caption"><strong>女生 · 温柔留白</strong><span>暖白 / 莓棕 / 宋体</span></figcaption><div class="screen"><div class="native-header">两人菜单</div><iframe title="女生主题页面预览" id="female"></iframe></div></figure><figure class="phone male"><figcaption class="caption"><strong>男生 · 清晰从容</strong><span>冷雾 / 深海墨 / 无衬线</span></figcaption><div class="screen"><div class="native-header">两人菜单</div><iframe title="男生主题页面预览" id="male"></iframe></div></figure></main>
<div class="footnote">内容为本地示例数据，样式读取实际 WXML / WXSS。地图是静态示意；系统权限、微信原生控件与安全区需在微信开发者工具或真机复核。运行 node docs/build-style-preview.js 可按最新代码重新生成。</div>
<script>const pages=${serialized};const select=document.getElementById('page');const widths=document.getElementById('width');const compare=document.getElementById('compare');const params=new URLSearchParams(location.search);let mode=params.get('mode')||'both';if(pages.some(p=>p.key===params.get('page')))select.value=params.get('page');if(['320','390','430'].includes(params.get('width')))widths.value=params.get('width');function render(){const page=pages.find(p=>p.key===select.value);document.documentElement.style.setProperty('--phone-width',widths.value+'px');document.documentElement.style.setProperty('--phone-height',Math.round(Number(widths.value)*1.846)+'px');for(const gender of ['female','male'])document.getElementById(gender).srcdoc=page.frames[gender];compare.classList.toggle('single',mode!=='both');compare.dataset.gender=mode;document.querySelectorAll('[data-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mode===mode)));const query=new URLSearchParams({page:select.value,width:widths.value,mode});history.replaceState(null,'','?'+query.toString())}select.onchange=render;widths.onchange=render;document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>{mode=b.dataset.mode;render()});render();</script></body></html>`;
fs.writeFileSync(path.join(__dirname, 'style-preview.html'), output);
console.log(`Generated docs/style-preview.html: ${pages.length} pages × 2 themes, from current WXML/WXSS.`);
