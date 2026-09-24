const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// Invoke the actual cloud-function boundaries. A revisioned transactional store lets
// unbind/publish overlap while ensuring failed or conflicted writes never commit.
const createHarness = ({ missingLocations = false } = {}) => {
  let records = {
    users: {
      alice: { _id: 'alice', coupleId: 'pair' },
      bob: { _id: 'bob', coupleId: 'pair' },
      outsider: { _id: 'outsider', coupleId: null },
    },
    couples: { pair: { _id: 'pair', status: 'active', members: ['alice', 'bob'], version: 1 } },
    coupleConfigs: { pair: { _id: 'pair', version: 1, menuItems: [{ id: 'item' }] } },
    coupleCarts: { pair: { _id: 'pair', version: 1, items: [{ id: 'item' }] } },
    coupleInvites: {},
    orders: {},
    ...(!missingLocations ? { coupleLocations: {} } : {}),
  };
  let revision = 0;
  let clock = 1_700_000_000_000;
  let currentUser = 'alice';
  let failedRead = null;
  let failedWrite = '';
  let nextCommitGate = null;
  const writes = [];
  const clone = (value) => structuredClone(value);
  const missingDocument = () => Object.assign(new Error('document not exist'), { errCode: -1 });
  const resolve = (value) => {
    if (value?.__serverDate) return new Date(clock);
    if (Array.isArray(value)) return value.map(resolve);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolve(child)]));
    }
    return value;
  };
  const collection = (name, scope) => {
    const data = () => {
      const items = (scope?.records || records)[name];
      if (!items) throw Object.assign(new Error('collection not exists'), { errCode: -502005 });
      return items;
    };
    const write = (id, value, update) => {
      if (failedWrite === name) throw new Error('injected write failure');
      const items = data();
      if (update && !items[id]) throw missingDocument();
      const record = update ? clone(items[id]) : { _id: id };
      for (const [key, raw] of Object.entries(value)) {
        record[key] = raw?.__command === 'inc' ? (record[key] || 0) + raw.value : resolve(raw);
      }
      items[id] = record;
      if (scope) scope.writes.push({ name, id });
      else { revision += 1; writes.push({ name, id }); }
    };
    const query = (condition = {}, count = 100) => ({
      where: (value) => query(value, count),
      limit: (value) => query(condition, value),
      get: async () => ({ data: clone(Object.values(data()).filter((item) =>
        Object.entries(condition).every(([key, value]) => item[key] === value)).slice(0, count)) }),
    });
    return {
      ...query(),
      doc: (id) => ({
        get: async () => {
          if (failedRead?.name === name) throw failedRead.error;
          const item = data()[id];
          if (!item) throw missingDocument();
          return { data: clone(item) };
        },
        set: async ({ data: value }) => write(id, value, false),
        update: async ({ data: value }) => write(id, value, true),
        remove: async () => { delete data()[id]; revision += 1; },
      }),
    };
  };
  const db = {
    command: { inc: (value) => ({ __command: 'inc', value }) },
    serverDate: () => ({ __serverDate: true }),
    collection: (name) => collection(name),
    runTransaction: async (callback) => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const expectedRevision = revision;
        const scope = { records: clone(records), writes: [] };
        const result = await callback({ collection: (name) => collection(name, scope) });
        if (nextCommitGate) {
          const gate = nextCommitGate;
          nextCommitGate = null;
          gate.enter();
          await gate.promise;
        }
        if (revision !== expectedRevision) continue;
        records = scope.records;
        writes.push(...scope.writes);
        if (scope.writes.length) revision += 1;
        return result;
      }
      throw new Error('transaction conflicts exhausted');
    },
  };
  const cloud = { init() {}, database: () => db, getWXContext: () => ({ OPENID: currentUser }) };
  const load = (file) => {
    const sandbox = {
      exports: {}, require: (name) => name === 'wx-server-sdk' ? cloud : require(name),
      Date: class extends Date { static now() { return clock; } },
      console: { warn() {}, error() {} },
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, `../cloudfunctions/${file}/index.js`), 'utf8'), sandbox);
    return sandbox.exports.main;
  };
  const location = load('locationApi');
  const couple = load('coupleApi');
  const invoke = async (api, openid, action, event = {}) => {
    currentUser = openid;
    return JSON.parse(JSON.stringify(await api({ action, ...event })));
  };
  return {
    call: (openid, action, event) => invoke(location, openid, action, event),
    unbind: (openid) => invoke(couple, openid, 'unbindPartner'),
    records: () => records,
    advance: (milliseconds) => { clock += milliseconds; },
    failReads: (name, error) => { failedRead = { name, error }; },
    failWrites: (name) => { failedWrite = name; },
    pauseCommit: () => {
      let enter;
      let release;
      const entered = new Promise((resolve) => { enter = resolve; });
      const promise = new Promise((resolve) => { release = resolve; });
      nextCommitGate = { enter, promise };
      return { entered, release };
    },
    writes,
  };
};

const point = { latitude: 31.2304, longitude: 121.4737, accuracy: 15 };
const start = async (h, openid = 'alice') => (await h.call(openid, 'begin')).data.sessionId;

test('ensure initializes a member-only empty document and ignores client identity/target overrides', async () => {
  const h = createHarness();
  const result = await h.call('alice', 'ensure', { coupleId: 'other', selfOpenid: 'bob', positions: { alice: point } });
  assert.equal(result.ok, true);
  assert.equal(result.data.coupleId, 'pair');
  assert.equal(result.data.selfOpenid, 'alice');
  assert.equal(result.data.partnerOpenid, 'bob');
  assert.equal(result.data.state.active, true);
  assert.deepEqual(result.data.state.positions, {});
  assert.equal(result.data.state.memberA, 'alice');
  assert.equal(result.data.state.memberB, 'bob');
  assert.equal(Object.keys(h.records().coupleLocations).length, 1);
  const count = h.writes.length;
  assert.equal((await h.call('bob', 'ensure')).data.selfOpenid, 'bob');
  assert.equal(h.writes.length, count);
});

test('all actions require authenticated current two-sided active membership', async () => {
  for (const action of ['ensure', 'begin', 'publish', 'end']) {
    const h = createHarness();
    const input = { ...point, sessionId: 'spoofed', coupleId: 'pair' };
    assert.equal((await h.call('', action, input)).code, 'UNAUTHORIZED');
    assert.equal((await h.call('unknown', action, input)).code, 'UNAUTHORIZED');
    assert.equal((await h.call('outsider', action, input)).code, 'COUPLE_REQUIRED');
    h.records().users.outsider.coupleId = 'pair';
    assert.equal((await h.call('outsider', action, input)).code, 'COUPLE_CHANGED');
    h.records().users.bob.coupleId = 'other';
    assert.equal((await h.call('alice', action, input)).code, 'COUPLE_CHANGED');
    assert.equal(h.writes.length, 0);
  }
  for (const members of [['alice'], ['alice', 'alice'], ['alice', 'bob', 'outsider']]) {
    const h = createHarness();
    h.records().couples.pair.members = members;
    assert.equal((await h.call('alice', 'ensure')).code, 'COUPLE_CHANGED');
  }
});

test('begin stores no coordinate and publish uses trusted server time with a five-second minimum interval', async () => {
  const h = createHarness();
  const sessionId = await start(h);
  assert.match(sessionId, /^[0-9a-f]{48}$/);
  assert.equal(h.records().coupleLocations.pair.positions.alice.latitude, undefined);
  const first = await h.call('alice', 'publish', { ...point, sessionId, updatedAt: 123 });
  assert.deepEqual(first.data, { accepted: true, updatedAt: 1_700_000_000_000, retryAfterMs: 0 });
  h.advance(4999);
  const writes = h.writes.length;
  const early = await h.call('alice', 'publish', { ...point, latitude: 0, sessionId });
  assert.equal(early.data.accepted, false);
  assert.equal(early.data.retryAfterMs, 1);
  assert.equal(h.writes.length, writes);
  assert.equal(h.records().coupleLocations.pair.positions.alice.latitude, point.latitude);
  h.advance(1);
  assert.equal((await h.call('alice', 'publish', { ...point, latitude: 0, longitude: 0, accuracy: 0, sessionId })).data.accepted, true);
  assert.equal(h.records().coupleLocations.pair.positions.alice.latitude, 0);
});

test('coordinates must be finite numbers in range, and invalid coordinates never change the shared state', async () => {
  const h = createHarness();
  const sessionId = await start(h);
  const initialWrites = h.writes.length;
  for (const invalid of [
    { latitude: '31' }, { latitude: NaN }, { latitude: Infinity }, { latitude: 90.01 }, { latitude: -90.01 },
    { longitude: '121' }, { longitude: 180.01 }, { longitude: -180.01 }, { longitude: NaN },
    { accuracy: undefined }, { accuracy: -1 }, { accuracy: Infinity }, { accuracy: 1000001 },
  ]) {
    assert.equal((await h.call('alice', 'publish', { ...point, ...invalid, sessionId })).code, 'INVALID_COORDINATES');
  }
  assert.equal(h.writes.length, initialWrites);
});

test('new sessions invalidate old publishers and delayed stop requests cannot stop the new session', async () => {
  const h = createHarness();
  const oldSession = await start(h);
  await h.call('alice', 'publish', { ...point, sessionId: oldSession });
  const sessionId = await start(h);
  assert.notEqual(sessionId, oldSession);
  assert.equal(h.records().coupleLocations.pair.positions.alice.latitude, undefined);
  assert.equal((await h.call('alice', 'publish', { ...point, sessionId: oldSession })).code, 'SESSION_REPLACED');
  assert.equal((await h.call('alice', 'end', { sessionId: oldSession })).data.ended, false);
  assert.equal((await h.call('bob', 'publish', { ...point, sessionId })).code, 'SESSION_REPLACED');
  assert.equal((await h.call('alice', 'publish', { ...point, sessionId })).data.accepted, true);
});

test('explicit end removes only the caller coordinates and old publishes cannot recreate them', async () => {
  const h = createHarness();
  const aliceSession = await start(h);
  const bobSession = await start(h, 'bob');
  await h.call('alice', 'publish', { ...point, sessionId: aliceSession });
  await h.call('bob', 'publish', { ...point, latitude: 32, sessionId: bobSession });
  assert.equal((await h.call('alice', 'end', { sessionId: aliceSession })).data.ended, true);
  assert.equal(h.records().coupleLocations.pair.positions.alice, undefined);
  assert.equal(h.records().coupleLocations.pair.positions.bob.latitude, 32);
  assert.equal((await h.call('alice', 'publish', { ...point, sessionId: aliceSession })).code, 'SESSION_REPLACED');
  assert.equal((await h.call('alice', 'end', { sessionId: aliceSession })).data.ended, false);
});

test('revoked or mismatched location documents cannot resurrect previously stored coordinates', async () => {
  for (const active of [false, true]) {
    const h = createHarness();
    h.records().coupleLocations.pair = {
      _id: 'pair', active, memberA: 'former', memberB: 'bob', version: 3,
      positions: { former: { ...point, sharing: true, sessionId: 'old' } },
    };
    const result = await h.call('alice', 'ensure');
    assert.deepEqual(result.data.state.positions, {});
    assert.equal(result.data.state.version, 4);
  }
});

test('missing collection is explicit and general read/write failures reach the API boundary without partial writes', async () => {
  assert.equal((await createHarness({ missingLocations: true }).call('alice', 'ensure')).code, 'COLLECTION_REQUIRED');
  for (const reason of ['permission denied', 'request timeout']) {
    const h = createHarness();
    h.failReads('coupleLocations', Object.assign(new Error(`document.get:fail ${reason}`), { errCode: -1 }));
    assert.equal((await h.call('alice', 'ensure')).code, 'SERVER_ERROR');
    assert.equal(h.writes.length, 0);
  }
  const h = createHarness();
  const sessionId = await start(h);
  h.failWrites('coupleLocations');
  assert.equal((await h.call('alice', 'publish', { ...point, sessionId })).code, 'SERVER_ERROR');
  assert.equal(h.records().coupleLocations.pair.positions.alice.latitude, undefined);
});

test('unbind atomically removes all locations and read members along with the relationship', async () => {
  const h = createHarness();
  const sessionId = await start(h);
  await h.call('alice', 'publish', { ...point, sessionId });
  assert.equal((await h.unbind('bob')).ok, true);
  const state = h.records().coupleLocations.pair;
  assert.equal(state.active, false);
  assert.equal(state.memberA, '');
  assert.equal(state.memberB, '');
  assert.deepEqual(state.positions, {});
  assert.equal(h.records().couples.pair.status, 'dissolved');
  assert.equal(h.records().users.alice.coupleId, null);
  assert.equal(h.records().users.bob.coupleId, null);
  assert.equal((await h.call('alice', 'publish', { ...point, sessionId })).code, 'COUPLE_REQUIRED');
});

test('legacy unbind tolerates only absent location storage; read failure rolls back relationship changes', async () => {
  assert.equal((await createHarness({ missingLocations: true }).unbind('alice')).ok, true);
  assert.equal((await createHarness().unbind('alice')).ok, true);
  for (const reason of ['permission denied', 'request timeout']) {
    const h = createHarness();
    await start(h);
    h.failReads('coupleLocations', Object.assign(new Error(`document.get:fail ${reason}`), { errCode: -1 }));
    assert.equal((await h.unbind('alice')).code, 'SERVER_ERROR');
    assert.equal(h.records().couples.pair.status, 'active');
    assert.equal(h.records().users.alice.coupleId, 'pair');
    assert.equal(h.records().coupleLocations.pair.active, true);
  }
});

test('a publish staged before unbind retries current membership and cannot restore revoked coordinates', async () => {
  const h = createHarness();
  const sessionId = await start(h);
  const gate = h.pauseCommit();
  const pendingPublish = h.call('alice', 'publish', { ...point, sessionId });
  await gate.entered;
  assert.equal((await h.unbind('bob')).ok, true);
  gate.release();
  assert.equal((await pendingPublish).code, 'COUPLE_REQUIRED');
  assert.equal(h.records().coupleLocations.pair.active, false);
  assert.deepEqual(h.records().coupleLocations.pair.positions, {});
});

test('unbind staged before a publish retries and clears the newer committed coordinates', async () => {
  const h = createHarness();
  const sessionId = await start(h);
  const gate = h.pauseCommit();
  const pendingUnbind = h.unbind('bob');
  await gate.entered;
  assert.equal((await h.call('alice', 'publish', { ...point, sessionId })).data.accepted, true);
  gate.release();
  assert.equal((await pendingUnbind).ok, true);
  assert.equal(h.records().coupleLocations.pair.active, false);
  assert.deepEqual(h.records().coupleLocations.pair.positions, {});
});
