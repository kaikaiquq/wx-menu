const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../utils/location-sharing.js'), 'utf8');
const flush = async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); };
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const session = (self = 'a', couple = 'pair') => ({ user: { openid: self }, couple: { coupleId: couple, status: 'active', members: [{ openid: self }, { openid: 'b' }] } });
function harness() {
  let time = 1700000000000;
  const timers = new Map(); const storage = new Map(); const watches = []; const actions = []; const native = [];
  const handlers = new Set(); let network; let counter = 0; let timerId = 0;
  let granted; let privacyNeeded = false; let initialPoint = null;
  const state = { active: true, memberA: 'a', memberB: 'b', positions: {}, version: 1 };
  const overrides = {};
  const clone = (data) => JSON.parse(JSON.stringify(data));
  const envelope = () => ({ coupleId: 'pair', selfOpenid: 'a', partnerOpenid: 'b', state: clone(state) });
  const call = async (action, data = {}) => {
    actions.push({ action, data });
    if (overrides[action]) return overrides[action](data);
    if (action === 'ensure') return envelope();
    if (action === 'begin') {
      const sessionId = `token${++counter}`;
      state.version += 1;
      state.positions.a = { sharing: true, sessionId, updatedAt: time };
      return { ...envelope(), sessionId };
    }
    if (action === 'publish') { state.positions.a = { ...state.positions.a, ...data, updatedAt: time }; state.version += 1; return { accepted: true, updatedAt: time }; }
    if (action === 'end') {
      if (state.positions.a?.sessionId === data.sessionId) { delete state.positions.a; state.version += 1; return { ended: true }; }
      return { ended: false };
    }
    throw new Error(action);
  };
  const context = {
    module: { exports: {} }, console,
    Date: class extends Date { static now() { return time; } },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, at: time + delay, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    require(name) {
      assert.equal(name, './cloud');
      return {
        callCloud: (fn, action, data) => { assert.equal(fn, 'locationApi'); return call(action, data); },
        initCloud: async () => {},
        getCloud: () => ({ database: () => ({ collection: () => ({ doc: () => ({ watch(options) {
          const watch = { ...options, closed: false, close() { this.closed = true; } }; watches.push(watch); return watch;
        } }) }) }) }),
      };
    },
    wx: {
      getStorageSync: (key) => storage.get(key), setStorageSync: (key, value) => storage.set(key, value),
      getSetting: ({ success }) => success({ authSetting: { 'scope.userLocation': granted } }),
      getPrivacySetting: ({ success }) => success({ needAuthorization: privacyNeeded, privacyContractName: '隐私指引' }),
      authorize: ({ scope, success, fail }) => { native.push('authorize'); assert.equal(scope, 'scope.userLocation');
        if (overrides.authorize) return overrides.authorize({ success, fail }); granted = true; success({}); },
      startLocationUpdate: ({ type, success, fail }) => { native.push('start'); assert.equal(type, 'gcj02');
        if (overrides.start) return overrides.start({ success, fail }); success({}); },
      stopLocationUpdate: ({ success }) => { native.push('stop'); success({}); },
      getLocation: ({ type, success, fail }) => {
        native.push('firstPoint'); assert.equal(type, 'gcj02');
        if (overrides.firstPoint) return overrides.firstPoint({ success, fail });
        if (initialPoint) success(initialPoint); else fail({});
      },
      onLocationChange: (fn) => handlers.add(fn), offLocationChange: (fn) => handlers.delete(fn),
      onLocationChangeError() {}, offLocationChangeError() {},
      onNetworkStatusChange: (fn) => { network = fn; },
    },
  };
  vm.runInNewContext(source, context);
  const api = context.module.exports;
  return {
    api, actions, native, watches, timers, state, overrides, storage, handlers,
    setGranted: (value) => { granted = value; }, setPrivacy: (value) => { privacyNeeded = value; }, setInitial: (point) => { initialPoint = point; },
    point: (point) => handlers.forEach((fn) => fn(point)), network: (connected) => network({ isConnected: connected }),
    snapshot: (value = state, index = watches.length - 1) => watches[index].onChange({ docs: [clone(value)] }),
    advance: async (ms) => {
      time += ms;
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= time);
      for (const [id, timer] of due) { if (timers.delete(id)) timer.fn(); }
      await flush();
    },
    count: (action) => actions.filter((item) => item.action === action).length,
  };
}
const point = (latitude = 31) => ({ latitude, longitude: 121, accuracy: 10 });

 test('opening page watches partner without collecting; first auto entry requests location once', async () => {
  const h = harness(); await h.api.openPage(session()); h.snapshot();
  assert.equal(h.native.length, 0); assert.equal(h.watches.length, 1);
  await h.api.autoEnable(); await flush();
  assert.equal(h.api.getState().sharing, true);
  assert.equal(h.native.filter((v) => v === 'authorize').length, 1);
  assert.equal(h.native.filter((v) => v === 'start').length, 1);
  h.api.closePage(); await h.api.openPage(session()); await h.api.autoEnable();
  assert.equal(h.count('begin'), 1); assert.equal(h.watches.length, 1);
});

test('privacy confirmation blocks collection and cloud sharing until native consent succeeds', async () => {
  const h = harness(); h.setPrivacy(true); await h.api.openPage(session());
  await h.api.autoEnable();
  assert.equal(h.api.getState().permission, 'privacy'); assert.equal(h.count('begin'), 0); assert.equal(h.handlers.size, 0);
  h.setPrivacy(false); await h.api.enableSharing();
  assert.equal(h.api.getState().sharing, true); assert.equal(h.count('begin'), 1);
});

test('denied location does not repeatedly prompt and still shows authorized partner data', async () => {
  const h = harness(); h.setGranted(false); h.state.positions.b = { ...point(32), updatedAt: 1700000000000, sharing: true };
  await h.api.openPage(session()); h.snapshot(); await h.api.autoEnable();
  h.api.closePage(); await h.api.openPage(session()); await h.api.autoEnable();
  assert.equal(h.api.getState().permission, 'denied'); assert.equal(h.count('begin'), 0);
  assert.equal(h.api.getState().partner.latitude, 32); assert.equal(h.native.length, 0);
});

test('manual disable persists a couple-scoped opt-out so tab entry never silently restarts', async () => {
  const h = harness(); await h.api.openPage(session()); await h.api.autoEnable(); await h.api.disableSharing();
  h.api.closePage(); await h.api.openPage(session()); await h.api.autoEnable();
  assert.equal(h.api.getState().sharing, false); assert.equal(h.count('begin'), 1);
  assert.equal(h.handlers.size, 0); assert.equal(h.state.positions.a, undefined);
  await h.api.enableSharing(); assert.equal(h.count('begin'), 2);
});

test('uploads are native-event driven, coalesce movement and do not poll while idle', async () => {
  const h = harness(); await h.api.openPage(session()); h.snapshot(); await h.api.enableSharing();
  h.point(point()); await flush(); assert.equal(h.count('publish'), 1);
  h.point(point(31.001)); h.point(point(31.002)); await flush();
  assert.equal(h.count('publish'), 1);
  await h.advance(5000); assert.equal(h.count('publish'), 2);
  assert.equal(h.actions.filter((a) => a.action === 'publish').at(-1).data.latitude, 31.002);
  await h.advance(60000); assert.equal(h.count('publish'), 2);
  h.point(point(31.002)); await flush(); assert.equal(h.count('publish'), 3);
  assert.equal(h.count('ensure'), 1);
});

test('background stops GPS and watch; resume uses saved consent without a fresh begin', async () => {
  const h = harness(); h.setInitial(point()); await h.api.openPage(session()); h.snapshot(); await h.api.enableSharing();
  h.api.onAppHide(); await flush();
  assert.equal(h.handlers.size, 0); assert.equal(h.watches[0].closed, true);
  assert.equal(h.count('end'), 0); assert.equal(h.api.getState().status, 'paused');
  await h.api.onAppShow(); await flush();
  assert.equal(h.handlers.size, 1); assert.equal(h.count('begin'), 1); assert.equal(h.watches.length, 2);
});

test('late begin after leaving cannot turn on sharing and its server token is revoked', async () => {
  const h = harness(); await h.api.openPage(session());
  const begin = deferred(); h.overrides.begin = () => begin.promise;
  const enable = h.api.enableSharing(); await flush(); h.api.closePage();
  begin.resolve({ coupleId: 'pair', selfOpenid: 'a', sessionId: 'late', state: h.state }); await enable; await flush();
  assert.equal(h.api.getState().sharing, false); assert.equal(h.handlers.size, 0);
  assert.equal(h.actions.filter((a) => a.action === 'end').at(-1).data.sessionId, 'late');
});

test('stop and token revocation do not wait for a pending native GPS startup', async () => {
  const h = harness(); await h.api.openPage(session());
  let finishStart; h.overrides.start = ({ success }) => { finishStart = success; };
  const enable = h.api.enableSharing(); await flush();
  const stopping = h.api.disableSharing(); await flush();
  assert.equal(h.count('end'), 1); assert.equal(h.api.getState().sharing, false);
  finishStart({}); await enable; await stopping; await flush();
  assert.equal(h.handlers.size, 0); assert.equal(h.native.at(-1), 'stop');
});

test('late upload from previous foreground session cannot requeue old coordinates', async () => {
  const h = harness(); await h.api.openPage(session()); h.snapshot(); await h.api.enableSharing();
  const old = deferred(); h.overrides.publish = () => old.promise;
  h.point(point(31)); await flush();
  h.api.onAppHide(); await flush(); await h.api.onAppShow(); h.snapshot();
  delete h.overrides.publish;
  old.resolve({ accepted: false, retryAfterMs: 1 }); await flush(); await h.advance(5000);
  assert.equal(h.count('publish'), 1);
});

test('failed cloud revocation can be retried without restarting collection', async () => {
  const h = harness(); await h.api.openPage(session()); await h.api.enableSharing();
  h.overrides.end = async () => { throw new Error('offline'); };
  await h.api.disableSharing();
  assert.equal(h.api.getState().sharing, false); assert.match(h.api.getState().error, /清除失败/);
  delete h.overrides.end; await h.api.retry();
  assert.equal(h.state.positions.a, undefined); assert.equal(h.count('begin'), 1); assert.equal(h.handlers.size, 0);
});

test('revoked couple snapshot clears positions and stops GPS immediately', async () => {
  const h = harness(); await h.api.openPage(session()); h.snapshot(); await h.api.enableSharing(); h.point(point()); await flush();
  h.snapshot({ ...h.state, active: false, positions: {}, version: 999 }); await flush();
  assert.equal(h.api.getState().status, 'unbound'); assert.equal(h.api.getState().partner, null); assert.equal(h.api.getState().self, null);
  assert.equal(h.handlers.size, 0);
});

test('older watch snapshots cannot cancel a newly begun sharing token', async () => {
  const h = harness(); await h.api.openPage(session()); const initial = JSON.parse(JSON.stringify(h.state));
  await h.api.enableSharing(); h.snapshot(initial);
  assert.equal(h.api.getState().sharing, true); assert.equal(h.handlers.size, 1);
  h.state.positions.a.sessionId = 'new-device'; h.state.version += 1; h.snapshot(); await flush();
  assert.equal(h.api.getState().sharing, false); assert.equal(h.handlers.size, 0);
});

test('identity switch ignores old callbacks and never restores old couple positions', async () => {
  const h = harness(); await h.api.openPage(session()); h.api.syncSession(session('a', 'newPair'));
  h.snapshot();
  assert.equal(h.api.getState().coupleId, 'newPair'); assert.equal(h.api.getState().partner, null);
});

test('a begin response older than a replacement watch token cannot start GPS', async () => {
  const h = harness(); await h.api.openPage(session());
  const begin = deferred(); h.overrides.begin = () => begin.promise;
  const enabled = h.api.enableSharing(); await flush();
  h.state.version = 3; h.state.positions.a = { sessionId: 'another-device', sharing: true, updatedAt: 1700000000000 };
  h.snapshot();
  begin.resolve({ coupleId: 'pair', selfOpenid: 'a', sessionId: 'old-token', state: { ...h.state, version: 2, positions: { a: { sessionId: 'old-token', sharing: true } } } });
  await enabled;
  assert.equal(h.api.getState().sharing, false);
  assert.equal(h.handlers.size, 0);
  assert.equal(h.state.positions.a.sessionId, 'another-device');
});

test('failed auto authorization prompts once, then settings grants allow a subsequent tab entry', async () => {
  const h = harness(); await h.api.openPage(session());
  h.overrides.authorize = ({ fail }) => fail({ errMsg: 'authorize:fail auth deny' });
  await h.api.autoEnable(); await h.api.autoEnable();
  assert.equal(h.native.filter((v) => v === 'authorize').length, 1);
  delete h.overrides.authorize; h.setGranted(true);
  await h.api.autoEnable(); assert.equal(h.api.getState().sharing, true);
});

test('leaving privacy confirmation pending does not suppress it on a later tab entry', async () => {
  const h = harness(); h.setPrivacy(true); await h.api.openPage(session()); await h.api.autoEnable();
  h.api.closePage(); await h.api.openPage(session()); await h.api.autoEnable();
  assert.equal(h.api.getState().permission, 'privacy');
  assert.equal(h.native.length, 0); assert.equal(h.count('begin'), 0);
});

test('a late initial one-shot location cannot overwrite a newer live position', async () => {
  const h = harness(); let initial;
  h.overrides.firstPoint = ({ success }) => { initial = success; };
  await h.api.openPage(session()); await h.api.enableSharing();
  h.point(point(32)); await flush();
  initial(point(31)); await flush();
  assert.equal(h.api.getState().self.latitude, 32);
  assert.equal(h.count('publish'), 1);
});
