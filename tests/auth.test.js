const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../utils/auth.js'), 'utf8');
const sessionFor = (openid, nickname = openid) => ({
  user: { openid, nickname, profileCompleted: true },
  couple: null,
});

const setup = () => {
  const storage = new Map();
  const pending = [];
  const calls = { start: 0, stop: 0, relaunch: 0, toast: 0 };
  const modules = {
    './cloud': {
      callCloud(name, action, data, options) {
        return new Promise((resolve, reject) => {
          pending.push({ name, action, data, options, resolve, reject });
        });
      },
    },
    './chat-unread': {
      start() { calls.start += 1; },
      stop() { calls.stop += 1; },
    },
    './couple-config': { clearConfigCache() {} },
    './couple-wish': { clearCartCache() {} },
    './personal-config': { clearPersonalConfigCache() {} },
    './legacy-migration': { async migrateLegacyData() {} },
    './theme': { syncTheme() {} },
  };
  const context = {
    module: { exports: {} },
    require(name) {
      assert.ok(modules[name], `Unexpected dependency: ${name}`);
      return modules[name];
    },
    wx: {
      getStorageSync: (key) => storage.get(key),
      setStorageSync: (key, value) => storage.set(key, value),
      removeStorageSync: (key) => storage.delete(key),
      reLaunch() { calls.relaunch += 1; },
      showToast() { calls.toast += 1; },
    },
    console,
    setTimeout,
  };
  vm.runInNewContext(source, context, { filename: 'utils/auth.js' });
  return { auth: context.module.exports, storage, pending, calls };
};

test('ordinary bootstrap calls share one cloud request and start notifications once', async () => {
  const { auth, pending, calls } = setup();
  const first = auth.bootstrap();
  const second = auth.bootstrap();
  assert.equal(pending.length, 1);
  pending[0].resolve(sessionFor('alice'));
  assert.equal((await first).user.openid, 'alice');
  assert.equal((await second).user.openid, 'alice');
  assert.equal(calls.start, 1);
});

test('late bootstrap after logout cannot restore identity or restart notifications', async () => {
  const { auth, storage, pending, calls } = setup();
  storage.set('couple.menu.openid', 'alice');
  const request = auth.bootstrap();
  const rejected = assert.rejects(request, { code: 'LOGGED_OUT' });
  auth.logout();
  pending[0].resolve(sessionFor('alice'));
  await rejected;
  assert.equal(auth.getSession(), null);
  assert.equal(auth.getSelfOpenid(), '');
  assert.equal(storage.has('couple.menu.openid'), false);
  assert.equal(calls.start, 0);
  assert.equal(calls.stop, 1);
  assert.equal(calls.relaunch, 1);
});

test('overlapping forced refreshes return the newest profile regardless of response order', async () => {
  for (const newestFirst of [false, true]) {
    const { auth, pending, calls } = setup();
    const older = auth.bootstrap(true);
    const newer = auth.bootstrap(true);
    if (newestFirst) {
      pending[1].resolve(sessionFor('alice', 'new nickname'));
      await newer;
      pending[0].resolve(sessionFor('alice', 'old nickname'));
    } else {
      pending[0].resolve(sessionFor('alice', 'old nickname'));
      await Promise.resolve();
      pending[1].resolve(sessionFor('alice', 'new nickname'));
    }
    assert.equal((await older).user.nickname, 'new nickname');
    assert.equal((await newer).user.nickname, 'new nickname');
    assert.equal(auth.getSession().user.nickname, 'new nickname');
    assert.equal(calls.start, 1);
  }
});

test('an older request failure does not clear the newer in-flight request', async () => {
  const { auth, pending } = setup();
  const older = auth.bootstrap(true);
  const rejected = assert.rejects(older, /network failed/);
  const newer = auth.bootstrap(true);
  pending[0].reject(new Error('network failed'));
  await rejected;
  const shared = auth.bootstrap();
  assert.equal(pending.length, 2);
  pending[1].resolve(sessionFor('alice'));
  assert.equal((await newer).user.openid, 'alice');
  assert.equal((await shared).user.openid, 'alice');
});

test('logout and login isolate old responses from a new account', async () => {
  const { auth, pending, storage, calls } = setup();
  const oldRequest = auth.bootstrap();
  const rejected = assert.rejects(oldRequest, { code: 'SESSION_CHANGED' });
  auth.logout();
  const loginRequest = auth.login();
  assert.equal(pending[1].options.interactiveLogin, true);
  pending[1].resolve(sessionFor('bob'));
  await loginRequest;
  pending[0].resolve(sessionFor('alice'));
  await rejected;
  assert.equal(auth.getSession().user.openid, 'bob');
  assert.equal(auth.getSelfOpenid(), 'bob');
  assert.equal(storage.get('couple.menu.openid'), 'bob');
  assert.equal(calls.start, 1);
});

test('clearSession invalidates in-flight auth without showing a stale login error', async () => {
  const { auth, pending, storage, calls } = setup();
  storage.set('couple.menu.openid', 'alice');
  const guarded = auth.requireSession({ requireCouple: false });
  auth.clearSession();
  pending[0].resolve(sessionFor('alice'));
  assert.equal(await guarded, null);
  assert.equal(auth.getSelfOpenid(), '');
  assert.equal(calls.toast, 0);
  assert.equal(calls.relaunch, 0);
  assert.equal(calls.start, 0);
  assert.equal(calls.stop, 1);
});
