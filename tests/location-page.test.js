const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../pages/location/index.js'), 'utf8');
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const session = {
  user: { openid: 'self', gender: 'female' },
  couple: { coupleId: 'couple', members: [{ openid: 'self' }, { openid: 'partner', nickname: '小满' }] },
};
const point = (latitude, longitude) => ({ latitude, longitude, updatedAt: Date.now(), accuracy: 12 });

const createPage = ({ service = {}, auth = {}, initialState = {} } = {}) => {
  const calls = { open: [], close: 0, auto: 0, enable: 0, disable: 0, unsubscribe: 0, clearClock: 0, toasts: [], settings: 0, privacyContract: 0, refreshPermission: 0 };
  const state = {
    status: 'connected', sharing: false, starting: false, permission: 'unknown', error: '',
    coupleId: 'couple', selfOpenid: 'self', partnerOpenid: 'partner', self: null, partner: null,
    ...initialState,
  };
  let listener;
  let clock;
  let definition;
  const locationSharing = {
    getState: () => state,
    subscribe: (fn) => {
      listener = fn;
      return () => { calls.unsubscribe += 1; listener = null; };
    },
    openPage: async (value) => { calls.open.push(value); },
    closePage: () => { calls.close += 1; },
    autoEnable: async () => { calls.auto += 1; },
    enableSharing: async () => { calls.enable += 1; },
    disableSharing: async () => { calls.disable += 1; },
    retry: () => {},
    refreshPermission: () => { calls.refreshPermission += 1; },
    ...service,
  };
  const modules = {
    '../../utils/auth': { requireSession: async () => session, ...auth },
    '../../utils/location-sharing': locationSharing,
    '../../utils/theme': {
      getStoredThemeClass: () => '', syncTheme: () => '',
      getThemeColors: () => ({ primary: '#485f52', secondary: '#68726b' }),
    },
  };
  vm.runInNewContext(source, {
    require: (id) => modules[id],
    Page: (value) => { definition = value; },
    setInterval: (fn) => { clock = fn; return 1; },
    clearInterval: () => { clock = null; calls.clearClock += 1; },
    wx: {
      showToast: (value) => calls.toasts.push(value),
      openSetting: ({ success }) => { calls.settings += 1; return success(); },
      openPrivacyContract: () => { calls.privacyContract += 1; },
      switchTab: () => {},
    },
  });
  const page = {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    getTabBar: () => null,
    setData(patch) { Object.assign(this.data, patch); },
  };
  return { page, calls, state, emit: (patch) => { Object.assign(state, patch); listener?.(state); }, tick: () => clock?.() };
};

test('新增位置 Tab 位于点单和消息之间，消息角标依据路由识别', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../app.json'), 'utf8'));
  const items = require('../custom-tab-bar/data');
  assert.deepEqual(config.tabBar.list.map((item) => item.text), ['今天', '点单', '位置', '消息', '我们']);
  assert.deepEqual(items.map((item) => item.url.slice(1)), config.tabBar.list.map((item) => item.pagePath));
  const markup = fs.readFileSync(path.join(__dirname, '../custom-tab-bar/index.wxml'), 'utf8');
  assert.match(markup, /item\.url === '\/pages\/chat\/index'/);
  assert.ok(config.requiredPrivateInfos.includes('startLocationUpdate'));
  assert.ok(config.permission['scope.userLocation']);
  assert.equal(config.requiredBackgroundModes, undefined);
});

test('打开位置页建立连接后自动启动授权，初始视野优先 TA 并显示双方 marker', async () => {
  const { page, calls } = createPage({ initialState: { self: point(31, 121), partner: point(32, 122) } });
  await page.onShow();
  assert.equal(calls.open[0], session);
  assert.equal(calls.auto, 1);
  assert.equal(calls.enable, 0);
  assert.equal(page.data.latitude, 32);
  assert.equal(page.data.longitude, 122);
  assert.equal(page.data.markers.length, 2);
  assert.equal(page.data.markers[0].callout.content, '我');
  assert.equal(page.data.markers[1].callout.content, 'TA');
  assert.equal(page.data.partnerName, '小满');
});

test('没有共享位置时不渲染假地图，TA 尚未共享时可展示自己并继续等待 TA', async () => {
  const { page, emit } = createPage();
  await page.onShow();
  assert.equal(page.data.hasMap, false);
  assert.equal(page.data.markers.length, 0);
  emit({ self: point(31, 121) });
  assert.equal(page.data.latitude, 31);
  assert.equal(page.data.followMode, 'partner');
  assert.match(page.data.viewText, /等待 TA/);
  emit({ partner: point(32, 122) });
  assert.equal(page.data.latitude, 32);
  assert.match(page.data.viewText, /跟随 TA/);
});

test('拖动暂停跟随但继续更新 marker，点击看 TA 恢复跟随', async () => {
  const { page, emit } = createPage({ initialState: { self: point(31, 121), partner: point(32, 122) } });
  await page.onShow();
  page.onRegionChange({ detail: { causedBy: 'update' } });
  assert.equal(page.data.followMode, 'partner');
  page.onRegionChange({ detail: { causedBy: 'gesture' } });
  emit({ partner: point(33, 123) });
  assert.equal(page.data.followMode, 'free');
  assert.equal(page.data.latitude, 32);
  assert.equal(page.data.markers[1].latitude, 33);
  page.showPartner();
  assert.equal(page.data.followMode, 'partner');
  assert.equal(page.data.latitude, 33);
  page.showBoth();
  assert.equal(page.data.includePoints.length, 2);
});

test('看自己后再次进入 Tab 仍默认看 TA，隐藏清理页面监听但不停止共享', async () => {
  const { page, calls } = createPage({ initialState: { self: point(31, 121), partner: point(32, 122), sharing: true } });
  await page.onShow();
  page.showSelf();
  assert.equal(page.data.latitude, 31);
  page.onHide();
  page.onUnload();
  assert.equal(calls.close, 1);
  assert.equal(calls.disable, 0);
  assert.equal(calls.unsubscribe, 1);
  assert.equal(calls.clearClock, 1);
  await page.onShow();
  assert.equal(page.data.followMode, 'partner');
  assert.equal(page.data.latitude, 32);
});

test('身份请求未完成即离开，旧响应不得打开连接或发起自动授权', async () => {
  const pending = deferred();
  const { page, calls } = createPage({ auth: { requireSession: () => pending.promise } });
  const showing = page.onShow();
  page.onHide();
  pending.resolve(session);
  await showing;
  assert.equal(calls.open.length, 0);
  assert.equal(calls.auto, 0);
});

test('连接尚未完成即离开，关闭连接且不得恢复时钟或弹授权', async () => {
  const pending = deferred();
  const { page, calls } = createPage({ service: { openPage: () => pending.promise } });
  const showing = page.onShow();
  await new Promise((resolve) => setImmediate(resolve));
  page.onHide();
  pending.resolve();
  await showing;
  assert.equal(calls.close, 1);
  assert.equal(calls.auto, 0);
  assert.equal(page._clock, null);
});

test('未获得隐私同意时显示隐私入口，同意后显式继续定位', async () => {
  const { page, calls } = createPage({ initialState: { permission: 'privacy' } });
  await page.onShow();
  assert.equal(page.data.privacyRequired, true);
  assert.equal(calls.enable, 0);
  page.openPrivacyContract();
  await page.onPrivacyAgreed();
  assert.equal(calls.privacyContract, 1);
  assert.equal(calls.enable, 1);
});

test('拒绝定位仍能看 TA，设置返回后交给尊重停止偏好的自动授权流程', async () => {
  const { page, calls } = createPage({ initialState: { permission: 'denied', partner: point(32, 122) } });
  await page.onShow();
  assert.equal(page.data.permissionDenied, true);
  assert.equal(page.data.hasMap, true);
  assert.equal(page.data.hasSelf, false);
  await page.openLocationSettings();
  assert.equal(calls.settings, 1);
  assert.equal(calls.refreshPermission, 1);
  assert.equal(calls.auto, 2);
  assert.equal(calls.enable, 0);
});

test('自动授权尚未返回时离开，晚到结果不得恢复 UI 时钟', async () => {
  const pending = deferred();
  const entered = deferred();
  const { page, calls } = createPage({ service: { autoEnable: () => { entered.resolve(); return pending.promise; } } });
  const showing = page.onShow();
  await entered.promise;
  page.onHide();
  pending.resolve();
  await showing;
  assert.equal(page._clock, null);
  assert.equal(calls.close, 1);
  assert.equal(calls.unsubscribe, 1);
});

test('设置刷新权限期间离开页面，旧回调不得调用自动启用', async () => {
  const pending = deferred();
  const { page, calls } = createPage({ service: { refreshPermission: () => pending.promise } });
  await page.onShow();
  const settings = page.openLocationSettings();
  page.onHide();
  pending.resolve();
  await settings;
  assert.equal(calls.auto, 1);
});

test('超过 90 秒的位置标明上次位置，UI 时钟不调用云端或重复授权', async () => {
  const { page, calls, tick } = createPage({ initialState: { partner: { ...point(32, 122), updatedAt: Date.now() - 100000 } } });
  await page.onShow();
  assert.equal(page.data.partnerStale, true);
  assert.match(page.data.partnerUpdateText, /超过 90 秒未更新/);
  assert.match(page.data.markers[0].callout.content, /上次位置/);
  tick();
  tick();
  assert.equal(calls.open.length, 1);
  assert.equal(calls.auto, 1);
});

test('共享关闭时依然允许清除服务器旧位置，失败保留错误提示', async () => {
  const { page } = createPage({
    initialState: { self: point(31, 121), sharing: false },
    service: { disableSharing: async () => { throw new Error('网络不稳定，请重试清除'); } },
  });
  await page.onShow();
  assert.equal(page.data.hasSelf, true);
  await page.disableSharing();
  assert.match(page.data.errorText, /请重试清除/);
  assert.equal(page.data.actionPending, false);
});

test('解绑或无效坐标快照立即清空地图，禁止展示上一段关系的位置', async () => {
  const { page, emit } = createPage({ initialState: { partner: point(32, 122) } });
  await page.onShow();
  emit({ partner: point(120, 500) });
  assert.equal(page.data.hasMap, false);
  emit({ coupleId: '', partnerOpenid: '', partner: point(32, 122), self: point(31, 121) });
  assert.equal(page.data.hasPartner, false);
  assert.equal(page.data.markers.length, 0);
  assert.equal(page.data.hasMap, false);
});
