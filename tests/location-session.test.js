const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const clone = (value) => JSON.parse(JSON.stringify(value));

// Use the real bootstrap serializer so member fixtures cannot accidentally expose
// openid, which is intentionally available only on the current session user.
const bootstrapSession = async ({ openid = 'alice', bound = true } = {}) => {
  const records = {
    users: {
      alice: { _id: 'alice', publicUserId: 'public-alice', nickname: '小桃', gender: 'female', profileCompleted: true, coupleId: bound ? 'pair' : null },
      bob: { _id: 'bob', publicUserId: 'public-bob', nickname: '小满', gender: 'male', profileCompleted: true, coupleId: bound ? 'pair' : null },
    },
    couples: {
      pair: { _id: 'pair', members: ['alice', 'bob'], status: 'active', version: 1 },
    },
  };
  const cloud = {
    init() {},
    getWXContext: () => ({ OPENID: openid }),
    database: () => ({
      command: {},
      collection: (collection) => ({
        doc: (id) => ({
          get: async () => {
            assert.ok(records[collection]?.[id], `Unexpected database read: ${collection}/${id}`);
            return { data: clone(records[collection][id]) };
          },
        }),
      }),
    }),
  };
  const context = {
    exports: {}, console,
    require: (name) => {
      if (name === 'wx-server-sdk') return cloud;
      assert.equal(name, 'crypto');
      return require('node:crypto');
    },
  };
  vm.runInNewContext(source('cloudfunctions/authApi/index.js'), context, { filename: 'cloudfunctions/authApi/index.js' });
  const result = await context.exports.main({ action: 'bootstrap' });
  assert.equal(result.ok, true);
  assert.equal(result.data.user.openid, openid);
  if (bound) {
    assert.equal(result.data.couple.status, 'active');
    assert.ok(result.data.couple.members.every((member) => !Object.hasOwn(member, 'openid')));
  }
  return result.data;
};

const createLocationPage = (session, { ensureError, beginError } = {}) => {
  const actions = [];
  const storage = new Map();
  const timers = new Map();
  let timerId = 0;
  let definition;
  const selfOpenid = session.user.openid;
  const partnerOpenid = selfOpenid === 'alice' ? 'bob' : 'alice';
  const state = {
    active: true, memberA: 'alice', memberB: 'bob', version: 1,
    positions: { [partnerOpenid]: { latitude: 32, longitude: 122, accuracy: 8, updatedAt: Date.now(), sharing: true } },
  };
  const envelope = () => ({ coupleId: 'pair', selfOpenid, partnerOpenid, state: clone(state) });
  const cloud = {
    initCloud: async () => {},
    callCloud: async (name, action) => {
      assert.equal(name, 'locationApi');
      actions.push(action);
      if (action === 'ensure') {
        if (ensureError) throw ensureError;
        return envelope();
      }
      if (action === 'begin') {
        if (beginError) throw beginError;
        state.version += 1;
        state.positions[selfOpenid] = { sharing: true, sessionId: 'share-token', updatedAt: Date.now() };
        return { ...envelope(), sessionId: 'share-token' };
      }
      assert.equal(action, 'end');
      return { ended: true };
    },
    getCloud: () => ({ database: () => ({ collection: () => ({ doc: () => ({
      watch(options) {
        options.onChange({ docs: [clone(state)] });
        return { close() {} };
      },
    }) }) }) }),
  };
  const wx = {
    getStorageSync: (key) => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    getSetting: ({ success }) => success({ authSetting: { 'scope.userLocation': true } }),
    getPrivacySetting: ({ success }) => success({ needAuthorization: false }),
    startLocationUpdate: ({ success }) => success({}),
    stopLocationUpdate: ({ success }) => success({}),
    getLocation: ({ fail }) => fail({ errMsg: 'No local position in this test' }),
    onLocationChange() {}, offLocationChange() {},
    onLocationChangeError() {}, offLocationChangeError() {},
    onNetworkStatusChange() {},
  };
  const schedule = (callback) => {
    const id = ++timerId;
    timers.set(id, callback);
    return id;
  };
  const serviceContext = {
    module: { exports: {} }, console, wx,
    setTimeout: schedule, clearTimeout: (id) => timers.delete(id),
    require: (name) => {
      assert.equal(name, './cloud');
      return cloud;
    },
  };
  vm.runInNewContext(source('utils/location-sharing.js'), serviceContext, { filename: 'utils/location-sharing.js' });
  const locationSharing = serviceContext.module.exports;
  const modules = {
    '../../utils/auth': { requireSession: async () => session },
    '../../utils/location-sharing': locationSharing,
    '../../utils/theme': {
      getStoredThemeClass: () => '',
      syncTheme: (gender) => `theme-${gender}`,
      getThemeColors: () => ({ primary: '#485f52', secondary: '#68726b' }),
    },
  };
  vm.runInNewContext(source('pages/location/index.js'), {
    wx, console,
    Page: (value) => { definition = value; },
    setInterval: schedule, clearInterval: (id) => timers.delete(id),
    require: (name) => {
      assert.ok(modules[name], `Unexpected page dependency: ${name}`);
      return modules[name];
    },
  }, { filename: 'pages/location/index.js' });
  const page = {
    ...definition,
    data: clone(definition.data),
    getTabBar: () => null,
    setData(patch) { Object.assign(this.data, patch); },
  };
  return { page, locationSharing, actions, close() { page.onHide(); locationSharing.stop(); } };
};

for (const [code, message] of [
  ['NETWORK_ERROR', 'cloud.callFunction:fail network error'],
  ['COLLECTION_REQUIRED', '请先创建 coupleLocations 集合'],
]) {
  test(`真实 bootstrap 已绑定会话在位置连接失败 ${code} 时仍显示伴侣与服务错误`, async () => {
    const session = await bootstrapSession();
    const error = Object.assign(new Error(message), { code });
    const h = createLocationPage(session, { ensureError: error, beginError: error });
    try {
      await h.page.onShow();
      assert.equal(h.locationSharing.getState().partnerOpenid, '');
      assert.equal(h.page.data.hasPartner, true);
      assert.equal(h.page.data.partnerName, '小满');
      assert.notEqual(h.locationSharing.getState().status, 'unbound');
      assert.ok(h.actions.includes('ensure'));
      assert.ok(h.page.data.errorText);
      assert.doesNotMatch(h.page.data.errorText, /请先绑定|未绑定/);
      assert.equal(h.page.data.hasMap, false);
    } finally { h.close(); }
  });
}

test('真实 bootstrap 在位置连接成功但开启共享失败时仍显示正确伴侣', async () => {
  const session = await bootstrapSession();
  const h = createLocationPage(session, { beginError: new Error('cloud.callFunction:fail network error') });
  try {
    await h.page.onShow();
    assert.equal(h.page.data.hasPartner, true);
    assert.equal(h.page.data.partnerName, '小满');
    assert.equal(h.page.data.sharing, false);
    assert.equal(h.page.data.hasPartnerPoint, true);
    assert.ok(h.page.data.errorText);
    assert.doesNotMatch(h.page.data.errorText, /请先绑定|未绑定/);
  } finally { h.close(); }
});

for (const [openid, partnerName] of [['alice', '小满'], ['bob', '小桃']]) {
  test(`真实 bootstrap 的 ${openid} 可通过公共用户 ID 显示另一半并开启位置共享`, async () => {
    const session = await bootstrapSession({ openid });
    const h = createLocationPage(session);
    try {
      await h.page.onShow();
      assert.equal(h.page.data.hasPartner, true);
      assert.equal(h.page.data.partnerName, partnerName);
      assert.equal(h.page.data.sharing, true);
      assert.equal(h.page.data.hasPartnerPoint, true);
      assert.equal(h.page.data.errorText, '');
    } finally { h.close(); }
  });
}

test('真实 bootstrap 未绑定会话保持未绑定状态且不请求位置云函数', async () => {
  const session = await bootstrapSession({ bound: false });
  const h = createLocationPage(session);
  try {
    await h.page.onShow();
    assert.equal(h.page.data.hasPartner, false);
    assert.equal(h.page.data.hasMap, false);
    assert.equal(h.locationSharing.getState().status, 'unbound');
    assert.equal(h.actions.length, 0);
  } finally { h.close(); }
});
