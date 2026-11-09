const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../utils/chat-unread.js'), 'utf8');
const flush = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
function setup() {
  const timers = new Map();
  const watches = [];
  const events = [];
  const toasts = [];
  const warnings = [];
  const storage = new Map();
  const app = { globalData: {} };
  let timerId = 0;
  let session = { user: { openid: 'a' } };
  let loggedOut = false;
  let network;
  let summary = { byId: {} };
  let summaryImpl = async () => summary;
  let ensureImpl = async () => {};
  let watchOpenImpl = () => {};
  let summaries = 0;
  let ensures = 0;
  const module = { exports: {} };
  const context = {
    module, console: { warn: (...args) => warnings.push(args) }, getApp: () => app, getCurrentPages: () => [],
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    wx: {
      getStorageSync: (key) => storage.get(key), setStorageSync: (key, value) => storage.set(key, value),
      removeStorageSync: (key) => storage.delete(key), onNetworkStatusChange: (fn) => { network = fn; },
      showToast: (options) => toasts.push(options),
    },
    require: (name) => {
      if (name === './auth') return { getSession: () => session, isLoggedOut: () => loggedOut };
      if (name === './chat') return {
        ensureChatSignal: () => { ensures += 1; return ensureImpl(); },
        getUnreadSummary: () => { summaries += 1; return summaryImpl(); },
      };
      if (name === './cloud') return {
        initCloud: async () => {},
        getCloud: () => ({ database: () => ({ collection: () => ({ doc: (id) => ({ watch: (handlers) => {
          let insideCallback = false;
          const record = { id, closed: false, closedInsideCallback: false, close() {
            this.closedInsideCallback ||= insideCallback;
            this.closed = true;
          } };
          for (const name of ['onChange', 'onError']) {
            record[name] = (value) => {
              insideCallback = true;
              try { return handlers[name](value); } finally { insideCallback = false; }
            };
          }
          watches.push(record);
          watchOpenImpl(record);
          return record;
        } }) }) }) }),
      };
      throw new Error(name);
    },
  };
  vm.runInNewContext(source, context);
  const api = module.exports;
  api.subscribe((event) => events.push(event));
  return {
    api, timers, watches, events, toasts, app, storage, warnings,
    get summaries() { return summaries; }, get ensures() { return ensures; },
    setSession: (openid) => { session = openid ? { user: { openid } } : null; },
    setLoggedOut: (value) => { loggedOut = value; },
    setSummary: (value) => { summary = { byId: value }; },
    setSummaryImpl: (fn) => { summaryImpl = fn; }, setEnsure: (fn) => { ensureImpl = fn; },
    setWatchOpen: (fn) => { watchOpenImpl = fn; },
    network: (isConnected) => network({ isConnected }),
    snapshot: (doc, index = watches.length - 1) => watches[index].onChange({ docs: [doc] }),
    runTimer: async (max = Infinity) => {
      const entry = [...timers.entries()].find(([, t]) => t.delay <= max);
      if (!entry) return false;
      timers.delete(entry[0]); entry[1].fn(); await flush(); return true;
    },
  };
}

test('start is idempotent; first snapshot restores unread without notification, no idle polling', async () => {
  const h = setup();
  await Promise.all([h.api.start(), h.api.start(), h.api.start()]);
  assert.equal(h.watches.length, 1);
  assert.equal(h.ensures, 1);
  h.setSummary({ old: 4 });
  h.snapshot({ bump: 4, messageVersion: 4 });
  await h.runTimer(100);
  assert.equal(h.api.getTotal(), 4);
  assert.equal(h.toasts.length, 0);
  assert.equal(h.summaries, 1);
  assert.equal(h.timers.size, 0);
  h.snapshot({ bump: 4, messageVersion: 4 });
  assert.equal(h.timers.size, 0);
});

test('bursts coalesce; other-page toast and badge update; active conversation stays quiet', async () => {
  const h = setup(); await h.api.start();
  h.snapshot({ bump: 0, messageVersion: 0 }); await h.runTimer(100);
  h.api.setActiveConversation('active');
  h.setSummary({ active: 2 });
  h.snapshot({ bump: 1, messageVersion: 1, conversationId: 'active' });
  h.snapshot({ bump: 2, messageVersion: 2, conversationId: 'active' });
  await h.runTimer(100);
  assert.equal(h.summaries, 2); assert.equal(h.toasts.length, 0);
  h.setSummary({ active: 2, other: 1 });
  h.snapshot({ bump: 3, messageVersion: 3, conversationId: 'other' }); await h.runTimer(100);
  assert.equal(h.toasts.length, 1); assert.equal(h.app.globalData.chatUnread, 3);
  h.setSummary({ active: 0, other: 1 });
  h.snapshot({ bump: 4, messageVersion: 3, kind: 'state' }); await h.runTimer(100);
  assert.equal(h.events.filter((e) => e.type === 'signal').at(-1).kind, 'state');
  assert.equal(h.toasts.length, 1);
});

test('in-flight summary queues a later change instead of dropping it', async () => {
  const h = setup(); await h.api.start();
  const pending = deferred(); h.setSummaryImpl(() => pending.promise);
  h.snapshot({ bump: 0, messageVersion: 0 }); await h.runTimer(100);
  h.snapshot({ bump: 1, messageVersion: 1 }); await h.runTimer(100);
  h.setSummaryImpl(async () => ({ byId: { c: 2 } }));
  pending.resolve({ byId: { c: 1 } }); await flush(); await h.runTimer(100);
  assert.equal(h.summaries, 2); assert.equal(h.api.getTotal(), 2);
});

test('hide closes watch and ignores in-flight response; resume resynchronizes', async () => {
  const h = setup(); await h.api.start();
  const pending = deferred(); h.setSummaryImpl(() => pending.promise);
  h.snapshot({ bump: 0, messageVersion: 0 }); await h.runTimer(100);
  h.api.onAppHide(); assert.equal(h.watches[0].closed, true);
  pending.resolve({ byId: { hidden: 9 } }); await flush();
  assert.equal(h.api.getTotal(), 0); assert.equal(h.timers.size, 0);
  h.setSummaryImpl(async () => ({ byId: { hidden: 9 } }));
  await h.api.onAppShow();
  assert.equal(h.watches.length, 2);
  h.snapshot({ bump: 9, messageVersion: 9 }); await h.runTimer(100);
  assert.equal(h.api.getTotal(), 9); assert.equal(h.toasts.length, 0);
});

test('logout during ensure cannot resurrect watcher; next user cannot inherit old unread', async () => {
  const h = setup(); const pending = deferred(); h.setEnsure(() => pending.promise);
  const start = h.api.start(); await flush();
  h.setLoggedOut(true); h.api.stop(); pending.resolve(); await start;
  assert.equal(h.watches.length, 0); assert.equal(h.api.getTotal(), 0);
  h.setEnsure(async () => {}); h.setLoggedOut(false); h.setSession('b'); await h.api.start();
  assert.equal(h.watches[0].id, 'b');
});

test('network recovery reconnects once; stale watch callbacks cannot close new connection', async () => {
  const h = setup(); await h.api.start(); h.network(false);
  assert.equal(h.api.getState().status, 'offline'); assert.equal(h.watches[0].closed, true);
  h.network(true); await flush();
  assert.equal(h.watches.length, 2);
  h.watches[0].onError(new Error('stale'));
  assert.equal(h.watches[1].closed, false);
  assert.equal(h.summaries, 0);
});

test('watch errors have bounded exponential reconnects, never message polling; permission failure needs retry', async () => {
  const h = setup(); await h.api.start();
  for (let i = 0; i < 6; i += 1) {
    h.watches.at(-1).onError(new Error('network broken'));
    assert.equal(await h.runTimer(0), true);
    if (i < 5) assert.equal(await h.runTimer(), true);
  }
  assert.equal(h.api.getState().status, 'error');
  assert.equal(h.timers.size, 0); assert.equal(h.summaries, 0);
  await h.api.start(); assert.equal(h.watches.length, 6);
  await h.api.retry(); assert.equal(h.watches.length, 7);
  h.watches.at(-1).onError(new Error('permission denied'));
  await h.runTimer(0);
  assert.equal(h.api.getState().status, 'error'); assert.equal(h.timers.size, 0);
});

test('an empty snapshot invalidates callbacks immediately but closes only after the SDK callback task', async () => {
  const h = setup(); await h.api.start();
  const old = h.watches[0];
  h.snapshot(undefined);
  assert.equal(h.api.getState().status, 'reconnecting');
  assert.equal(old.closed, false);
  assert.equal(old.closedInsideCallback, false);
  await flush();
  assert.equal(old.closed, false, 'SDK await continuations must run before close');
  old.onChange({ docs: [{ bump: 1, messageVersion: 1 }] });
  old.onError(new Error('late SDK error'));
  assert.equal(h.events.filter((event) => event.type === 'signal').length, 0);
  assert.equal(h.warnings.length, 1);
  assert.equal(h.warnings[0][1], 'watch-snapshot');
  assert.equal(h.warnings[0][2], 'CHAT_SIGNAL_UNAVAILABLE');
  assert.match(h.warnings[0][3], /no readable document/);
  await h.runTimer(0);
  assert.equal(old.closed, true);
  assert.equal(old.closedInsideCallback, false);
  await h.runTimer(2000);
  assert.equal(h.ensures, 2);
  assert.equal(h.watches.length, 2);
  h.snapshot({ bump: 2, messageVersion: 2 });
  h.setSummary({ recovered: 2 });
  await h.runTimer(100);
  assert.equal(h.api.getState().status, 'connected');
  assert.equal(h.api.getTotal(), 2);
});

test('synchronous empty snapshot during watch creation also defers closing the returned watcher', async () => {
  const h = setup();
  h.setWatchOpen((record) => record.onChange({ docs: [] }));
  await h.api.start();
  assert.equal(h.api.getState().status, 'reconnecting');
  assert.equal(h.watches[0].closed, false);
  await h.runTimer(0);
  assert.equal(h.watches[0].closed, true);
  assert.equal(h.watches[0].closedInsideCallback, false);
  h.setWatchOpen(() => {});
  await h.runTimer(2000);
  assert.equal(h.ensures, 2);
  assert.equal(h.watches.length, 2);
  assert.equal(h.watches[1].closed, false);
});

test('persistent unreadable signal snapshots re-ensure within the retry budget without summary polling', async () => {
  const h = setup(); await h.api.start();
  for (let attempt = 0; attempt < 6; attempt += 1) {
    h.snapshot(undefined);
    await h.runTimer(0);
    if (attempt < 5) await h.runTimer();
  }
  assert.equal(h.api.getState().status, 'error');
  assert.equal(h.ensures, 6);
  assert.equal(h.watches.length, 6);
  assert.equal(h.summaries, 0);
  assert.equal(h.timers.size, 0);
});

test('stopping from a signal listener invalidates the session without closing inside onChange', async () => {
  const h = setup(); await h.api.start();
  h.api.subscribe((event) => { if (event.type === 'signal') h.api.stop(); });
  h.snapshot({ bump: 1 });
  assert.equal(h.api.getState().status, 'stopped');
  assert.equal(h.watches[0].closed, false);
  assert.equal(h.watches[0].closedInsideCallback, false);
  await h.runTimer(0);
  assert.equal(h.watches[0].closed, true);
  assert.equal(h.timers.size, 0);
  assert.equal(h.summaries, 0);
});

test('a deferred close from the previous identity never closes its replacement watcher', async () => {
  const h = setup(); await h.api.start();
  h.snapshot(undefined);
  h.setSession('b'); await h.api.start();
  assert.equal(h.watches.length, 2);
  assert.equal(h.watches[1].id, 'b');
  await h.runTimer(0);
  assert.equal(h.watches[0].closed, true);
  assert.equal(h.watches[1].closed, false);
});

test('cached identity alone never starts a watch; account switch ignores previous requests', async () => {
  const h = setup(); h.setSession(null); await h.api.start(); assert.equal(h.watches.length, 0);
  h.setSession('a'); await h.api.start();
  const old = deferred(); h.setSummaryImpl(() => old.promise);
  h.snapshot({ bump: 1 }); await h.runTimer(100);
  h.setSession('b'); await h.api.start();
  old.resolve({ byId: { privateA: 7 } }); await flush();
  assert.equal(h.api.getTotal(), 0); assert.equal(h.watches.at(-1).id, 'b');
});

test('switching identity after terminal error can start a fresh connection', async () => {
  const h = setup(); await h.api.start();
  h.watches[0].onError(new Error('permission denied'));
  h.setSession('b'); await h.api.start();
  assert.equal(h.watches.length, 2);
  assert.equal(h.watches[1].id, 'b');
});

test('initial connection timeout retries with a bound, and background cancels retry timers', async () => {
  const h = setup(); await h.api.start();
  assert.equal(await h.runTimer(15000), true);
  assert.equal(h.api.getState().status, 'reconnecting');
  assert.equal(h.watches[0].closed, true);
  h.api.onAppHide();
  assert.equal(h.timers.size, 0); assert.equal(h.summaries, 0);
});

test('summary errors reconnect for catch-up rather than leaving a connected stale badge', async () => {
  const h = setup(); await h.api.start();
  h.setSummaryImpl(async () => { throw new Error('temporary network failure'); });
  h.snapshot({ bump: 0, messageVersion: 0 }); await h.runTimer(100);
  assert.equal(h.api.getState().status, 'reconnecting');
  assert.equal(h.watches[0].closed, true);
  h.setSummaryImpl(async () => ({ byId: { recovered: 3 } }));
  await h.runTimer();
  h.snapshot({ bump: 3, messageVersion: 3 }); await h.runTimer(100);
  assert.equal(h.api.getTotal(), 3);
  assert.equal(h.api.getState().status, 'connected');
  assert.equal(h.toasts.length, 0);
});

test('signal arriving during debounce keeps its notification even if an older summary returns first', async () => {
  const h = setup(); await h.api.start();
  h.snapshot({ bump: 0, messageVersion: 0 }); await h.runTimer(100);
  const pending = deferred(); h.setSummaryImpl(() => pending.promise);
  const oldRefresh = h.api.refresh('manual');
  h.snapshot({ bump: 1, messageVersion: 1, conversationId: 'other' });
  // The old response wins the race against the new signal's 100ms debounce timer.
  pending.resolve({ byId: {} }); await oldRefresh; await flush();
  h.setSummaryImpl(async () => ({ byId: { other: 1 } }));
  await h.runTimer(100);
  assert.equal(h.api.getTotal(), 1);
  assert.equal(h.toasts.length, 1);
});
