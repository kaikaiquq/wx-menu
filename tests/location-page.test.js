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
  user: { openid: 'self', publicUserId: 'public-self', gender: 'female' },
  couple: {
    coupleId: 'couple', status: 'active',
    members: [{ publicUserId: 'public-self', nickname: '自己' }, { publicUserId: 'public-partner', nickname: '小满' }],
  },
};
const point = (latitude, longitude) => ({ latitude, longitude, updatedAt: Date.now(), accuracy: 12 });

const createPage = ({ service = {}, auth = {}, initialState = {}, deferRender = false } = {}) => {
  const calls = { auth: [], open: [], close: 0, auto: 0, enable: 0, disable: 0, retry: 0, unsubscribe: 0, clearClock: 0, toasts: [], settings: 0, privacyContract: 0, refreshPermission: 0, fits: [] };
  const renderCallbacks = [];
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
    retry: async () => { calls.retry += 1; },
    refreshPermission: () => { calls.refreshPermission += 1; },
    ...service,
  };
  const modules = {
    '../../utils/auth': {
      requireSession: async (options) => {
        calls.auth.push(options);
        return auth.requireSession ? auth.requireSession(options) : session;
      },
    },
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
      createMapContext: (id) => {
        assert.match(id, /^couple-map-\d+$/);
        return { includePoints: (options) => { calls.fits.push(options); } };
      },
    },
  });
  const page = {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    getTabBar: () => null,
    setData(patch, callback) {
      Object.assign(this.data, patch);
      if (callback) {
        if (deferRender) renderCallbacks.push(callback);
        else callback();
      }
    },
  };
  return {
    page, calls, state, emit: (patch) => { Object.assign(state, patch); listener?.(state); }, tick: () => clock?.(),
    flushRender: () => { renderCallbacks.splice(0).forEach((callback) => callback()); },
  };
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

test('真实 authApi 公开成员不带 openid，位置连接失败仍显示已绑定和正确伴侣', async () => {
  const { page, emit } = createPage({
    initialState: { status: 'connecting', partnerOpenid: '' },
  });
  await page.onShow();
  assert.equal(page.data.hasPartner, true);
  assert.equal(page.data.partnerName, '小满');
  emit({ status: 'error', error: '位置服务暂不可用', partnerOpenid: '' });
  assert.equal(page.data.hasPartner, true);
  assert.equal(page.data.errorText, '位置服务暂不可用');
  assert.equal(page.data.sessionUnavailable, false);
  assert.equal(page.data.hasMap, false);
});

test('兼容使用 openid 标识成员的会话', async () => {
  const { page } = createPage({
    auth: { requireSession: async () => ({
      user: { openid: 'self', gender: 'female' },
      couple: { coupleId: 'couple', status: 'active', members: [{ openid: 'self' }, { openid: 'partner', nickname: '小满' }] },
    }) },
    initialState: { partnerOpenid: '' },
  });
  await page.onShow();
  assert.equal(page.data.hasPartner, true);
  assert.equal(page.data.partnerName, '小满');
});

test('待绑定关系即使残留两个成员或位置身份，也不展示已绑定或旧位置', async () => {
  const { page } = createPage({
    auth: { requireSession: async () => ({ ...session, couple: { ...session.couple, status: 'pending' } }) },
    initialState: { partner: point(32, 122) },
  });
  await page.onShow();
  assert.equal(page.data.hasPartner, false);
  assert.equal(page.data.sessionUnavailable, false);
  assert.equal(page.data.hasMap, false);
});

test('身份请求失败展示待确认状态，重试强制刷新身份并恢复位置页', async () => {
  let attempts = 0;
  const { page, calls } = createPage({
    auth: { requireSession: async () => (++attempts === 1 ? null : session) },
  });
  await page.onShow();
  assert.equal(page.data.sessionUnavailable, true);
  assert.equal(page.data.loading, false);
  assert.match(page.data.errorText, /无法确认绑定状态/);
  assert.equal(calls.open.length, 0);
  await page.retryConnection();
  assert.equal(calls.auth.length, 2);
  assert.ok(calls.auth.every((options) => options.force === true && options.requireCouple === false));
  assert.equal(calls.retry, 0);
  assert.equal(calls.open.length, 1);
  assert.equal(page.data.sessionUnavailable, false);
  assert.equal(page.data.hasPartner, true);
});

test('关系或成员读取不完整时提示重试，不把 authApi 降级响应当作未绑定', async () => {
  const incompleteSessions = [
    { ...session, user: { ...session.user, coupleId: 'couple' }, couple: null },
    { ...session, couple: { ...session.couple, members: [session.couple.members[0]] } },
  ];
  for (const value of incompleteSessions) {
    const { page, calls } = createPage({ auth: { requireSession: async () => value } });
    await page.onShow();
    assert.equal(page.data.sessionUnavailable, true);
    assert.equal(page.data.hasPartner, false);
    assert.match(page.data.errorText, /无法确认绑定状态/);
    assert.equal(calls.open.length, 0);
  }
});

test('确定未绑定或只有邀请中的自己时正常展示绑定入口', async () => {
  const unboundSessions = [
    { ...session, couple: null },
    { ...session, couple: { ...session.couple, status: 'pending', members: [session.couple.members[0]] } },
  ];
  for (const value of unboundSessions) {
    const { page } = createPage({
      auth: { requireSession: async () => value },
      initialState: { coupleId: '', partnerOpenid: '' },
    });
    await page.onShow();
    assert.equal(page.data.sessionUnavailable, false);
    assert.equal(page.data.hasPartner, false);
    assert.equal(page.data.loading, false);
  }
});

test('已有有效身份时重试位置连接，不重复刷新会话', async () => {
  const { page, calls } = createPage();
  await page.onShow();
  await page.retryConnection();
  assert.equal(calls.retry, 1);
  assert.equal(calls.auth.length, 1);
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
  const { page, emit, calls } = createPage({ initialState: { self: point(31, 121), partner: point(32, 122) } });
  await page.onShow();
  page.onMapUpdated({ currentTarget: { id: `couple-map-${page.data.mapInstance}` } });
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
  assert.equal(calls.fits.length, 1);
  assert.equal(calls.fits[0].points.length, 2);
});

test('默认跟随和单点更新不向地图传空范围，双方显示等待地图就绪且只随坐标变化调整', async () => {
  const markup = fs.readFileSync(path.join(__dirname, '../pages/location/index.wxml'), 'utf8');
  assert.doesNotMatch(markup, /\binclude-points\s*=/);
  assert.match(markup, /bindupdated="onMapUpdated"/);
  const { page, calls, emit, tick } = createPage();
  await page.onShow();
  emit({ self: point(31, 121) });
  page.onMapUpdated({ currentTarget: { id: `couple-map-${page.data.mapInstance}` } });
  tick();
  assert.equal(calls.fits.length, 0);
  emit({ self: null });
  emit({ self: point(31, 121), partner: point(32, 122) });
  page.showBoth();
  assert.equal(calls.fits.length, 0);
  page.onMapUpdated({ currentTarget: { id: `couple-map-${page.data.mapInstance}` } });
  assert.equal(calls.fits.length, 1);
  page.onMapUpdated({ currentTarget: { id: `couple-map-${page.data.mapInstance}` } });
  tick();
  emit({ status: 'connecting' });
  assert.equal(calls.fits.length, 1);
  emit({ partner: point(33, 123) });
  assert.equal(calls.fits.length, 2);
  assert.equal(calls.fits[1].points[1].latitude, 33);
});

test('双方坐标重合、丢失或无效时回退有效中心，不调用退化范围', async () => {
  const { page, emit, calls } = createPage({ initialState: { self: point(31, 121), partner: point(31, 121) } });
  await page.onShow();
  page.onMapUpdated({ currentTarget: { id: `couple-map-${page.data.mapInstance}` } });
  page.showBoth();
  assert.equal(calls.fits.length, 0);
  assert.equal(page.data.markers.length, 2);
  assert.equal(page.data.latitude, 31);
  emit({ partner: point(32, 122) });
  assert.equal(calls.fits.length, 1);
  emit({ partner: null, self: point(30, 120) });
  assert.equal(page.data.latitude, 30);
  assert.equal(page.data.longitude, 120);
  assert.equal(calls.fits.length, 1);
  emit({ partner: point(NaN, 122) });
  assert.equal(calls.fits.length, 1);
  emit({ self: null });
  page.onMapUpdated({ currentTarget: { id: `couple-map-${page.data.mapInstance}` } });
  assert.equal(page.data.hasMap, false);
  emit({ self: point(31, 121), partner: point(32, 122) });
  assert.equal(calls.fits.length, 1);
  page.onMapUpdated({ currentTarget: { id: `couple-map-${page.data.mapInstance}` } });
  assert.equal(calls.fits.length, 2);
});

test('渲染回调晚到时不打断手势或操作已隐藏的地图', async () => {
  const { page, calls, flushRender, emit } = createPage({
    initialState: { self: point(31, 121), partner: point(32, 122) }, deferRender: true,
  });
  await page.onShow();
  page.onMapUpdated({ currentTarget: { id: `couple-map-${page.data.mapInstance}` } });
  page.showBoth();
  page.onRegionChange({ detail: { causedBy: 'gesture' } });
  flushRender();
  page.onMapUpdated({ currentTarget: { id: `couple-map-${page.data.mapInstance}` } });
  assert.equal(calls.fits.length, 0);
  page.showBoth();
  emit({ partner: point(33, 123) });
  flushRender();
  assert.equal(calls.fits.length, 1);
  assert.equal(calls.fits[0].points[1].latitude, 33);
  emit({ partner: point(34, 124) });
  page.onHide();
  flushRender();
  page.onMapUpdated({ currentTarget: { id: `couple-map-${page.data.mapInstance}` } });
  assert.equal(calls.fits.length, 1);
});

test('地图范围失败不因 updated 或时钟反复调用，用户可主动重试', async () => {
  const { page, calls, tick } = createPage({ initialState: { self: point(31, 121), partner: point(32, 122) } });
  await page.onShow();
  page.onMapUpdated({ currentTarget: { id: `couple-map-${page.data.mapInstance}` } });
  page.showBoth();
  calls.fits[0].fail();
  assert.equal(calls.toasts.length, 1);
  page.onMapUpdated({ currentTarget: { id: `couple-map-${page.data.mapInstance}` } });
  tick();
  assert.equal(calls.fits.length, 1);
  page.showBoth();
  assert.equal(calls.fits.length, 2);
  page.onHide();
  calls.fits[1].fail();
  assert.equal(calls.toasts.length, 1);
});

test('相同坐标重试或地图重建后，旧范围请求的失败回调不再报错', async () => {
  const { page, emit, calls } = createPage({ initialState: { self: point(31, 121), partner: point(32, 122) } });
  await page.onShow();
  page.onMapUpdated({ currentTarget: { id: `couple-map-${page.data.mapInstance}` } });
  page.showBoth();
  page.showBoth();
  calls.fits[0].fail();
  assert.equal(calls.toasts.length, 0);
  const previousId = `couple-map-${page.data.mapInstance}`;
  emit({ self: null, partner: null });
  emit({ self: point(31, 121), partner: point(32, 122) });
  page.onMapUpdated({ currentTarget: { id: previousId } });
  assert.equal(calls.fits.length, 2);
  page.onMapUpdated({ currentTarget: { id: `couple-map-${page.data.mapInstance}` } });
  assert.equal(calls.fits.length, 3);
  calls.fits[1].fail();
  assert.equal(calls.toasts.length, 0);
});

test('新地图在本次渲染完成前不接受旧地图 updated，也不提前调整范围', async () => {
  const { page, emit, calls, flushRender } = createPage({
    initialState: { self: point(31, 121), partner: point(32, 122) }, deferRender: true,
  });
  await page.onShow();
  flushRender();
  page.onMapUpdated({ currentTarget: { id: `couple-map-${page.data.mapInstance}` } });
  page.showBoth();
  flushRender();
  assert.equal(calls.fits.length, 1);
  const previousId = `couple-map-${page.data.mapInstance}`;
  emit({ self: null, partner: null });
  emit({ self: point(31, 121), partner: point(32, 122) });
  page.onMapUpdated({ currentTarget: { id: previousId } });
  assert.equal(calls.fits.length, 1);
  page.onMapUpdated({ currentTarget: { id: `couple-map-${page.data.mapInstance}` } });
  assert.equal(calls.fits.length, 1);
  flushRender();
  assert.equal(calls.fits.length, 2);
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

test('位置身份被撤销后重试重新获取绑定，清理旧监听后恢复连接', async () => {
  let state;
  const context = createPage({
    service: { openPage: async () => { state.coupleId = 'couple'; } },
    initialState: { partner: point(32, 122) },
  });
  ({ state } = context);
  const { page, emit, calls } = context;
  await page.onShow();
  emit({ coupleId: '', partnerOpenid: '', self: null, partner: null, status: 'unbound' });
  assert.equal(page.data.hasPartner, false);
  assert.equal(page.data.hasMap, false);
  await page.retryConnection();
  assert.equal(calls.auth.length, 2);
  assert.equal(calls.retry, 0);
  assert.equal(calls.close, 1);
  assert.equal(calls.unsubscribe, 1);
  assert.equal(calls.clearClock, 1);
  assert.equal(page.data.hasPartner, true);
  assert.equal(page.data.hasMap, false);
});

test('位置状态属于其他情侣空间时不展示旧关系的坐标', async () => {
  const { page, emit } = createPage({ initialState: { partner: point(32, 122) } });
  await page.onShow();
  emit({ coupleId: 'other-couple' });
  assert.equal(page.data.hasPartner, false);
  assert.equal(page.data.hasMap, false);
  assert.equal(page.data.markers.length, 0);
});
