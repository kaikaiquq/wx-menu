const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// Exercise the exported cloud-function boundary with an in-memory transactional database.
// Overlapping transactions retry against the committed snapshot; failed writes never commit.
const createHarness = ({ conversations, messages = [], signals = [], missingSignals = false } = {}) => {
  let records = {
    users: Object.fromEntries(['alice', 'bob', 'carol', 'outsider'].map((id) => [id, { _id: id, nickname: id }])),
    conversations: Object.fromEntries((conversations || [{
      _id: 'room', memberOpenids: ['alice', 'bob'], type: 'direct', unreadBy: {},
    }]).map((item) => [item._id, item])),
    messages: Object.fromEntries(messages.map((item) => [item._id, item])),
    ...(!missingSignals ? { chatSignals: Object.fromEntries(signals.map((item) => [item._id, item])) } : {}),
  };
  let revision = 0;
  let currentUser = 'alice';
  let clock = 1_700_000_000_000;
  let failedCollection = '';
  let failedRead = null;
  const writes = [];
  const clone = (value) => structuredClone(value);
  const missing = () => Object.assign(new Error('document not exist'), { errCode: -1 });
  const resolve = (value) => {
    if (value?.__serverDate) return new Date(++clock);
    if (Array.isArray(value)) return value.map(resolve);
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolve(child)]));
    }
    return value;
  };

  const collection = (name, scope) => {
    const source = () => scope?.records || records;
    const data = () => {
      if (!source()[name]) throw Object.assign(new Error('collection not exists'), { errCode: -502005 });
      return source()[name];
    };
    const write = (id, value, update) => {
      if (name === failedCollection) throw new Error('injected signal write failure');
      const items = data();
      if (update && !items[id]) throw missing();
      const next = update ? clone(items[id]) : { _id: id };
      Object.entries(value).forEach(([field, raw]) => {
        const parts = field.split('.');
        const leaf = parts.pop();
        let target = next;
        parts.forEach((part) => { target[part] ||= {}; target = target[part]; });
        target[leaf] = raw?.__command === 'inc' ? (target[leaf] || 0) + raw.value : resolve(raw);
      });
      items[id] = next;
      if (scope) scope.writes.push({ name, id });
      else { writes.push({ name, id }); revision += 1; }
    };
    const query = (condition = {}, order = [], limit = 100) => ({
      where: (value) => query(value, order, limit),
      orderBy: (field, direction) => query(condition, [...order, { field, direction }], limit),
      limit: (value) => query(condition, order, value),
      get: async () => {
        let list = Object.values(data()).filter((record) => Object.entries(condition).every(([key, value]) => {
          if (value?.__command === 'gt') return record[key] > value.value;
          return Array.isArray(record[key]) ? record[key].includes(value) : record[key] === value;
        }));
        list.sort((left, right) => {
          for (const { field, direction } of order) {
            const a = left[field]; const b = right[field];
            if (a > b) return direction === 'desc' ? -1 : 1;
            if (a < b) return direction === 'desc' ? 1 : -1;
          }
          return 0;
        });
        return { data: clone(list.slice(0, limit)) };
      },
    });
    return {
      ...query(),
      doc: (id) => ({
        get: async () => {
          if (failedRead?.name === name) throw failedRead.error;
          const item = data()[id];
          if (!item) throw missing();
          return { data: clone(item) };
        },
        set: async ({ data: value }) => { write(id, value, false); return { _id: id }; },
        update: async ({ data: value }) => { write(id, value, true); return { stats: { updated: 1 } }; },
      }),
    };
  };
  const db = {
    command: { inc: (value) => ({ __command: 'inc', value }), gt: (value) => ({ __command: 'gt', value }) },
    serverDate: () => ({ __serverDate: true }),
    collection: (name) => collection(name),
    runTransaction: async (callback) => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const expectedRevision = revision;
        const scope = { records: clone(records), writes: [] };
        const result = await callback({ collection: (name) => collection(name, scope) });
        if (expectedRevision !== revision) continue;
        records = scope.records;
        writes.push(...scope.writes);
        if (scope.writes.length) revision += 1;
        return result;
      }
      throw new Error('transaction conflicts exhausted');
    },
  };
  const cloud = {
    init() {}, database: () => db, getWXContext: () => ({ OPENID: currentUser }),
    getTempFileURL: async () => ({ fileList: [] }),
  };
  const sandbox = {
    exports: {}, require: (name) => name === 'wx-server-sdk' ? cloud : require(name),
    console: { warn() {}, error() {} },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../cloudfunctions/chatApi/index.js'), 'utf8'), sandbox);
  return {
    call: async (openid, action, event = {}) => {
      currentUser = openid;
      // JSON matches the cloud boundary and removes VM-specific prototypes.
      return JSON.parse(JSON.stringify(await sandbox.exports.main({ action, ...event })));
    },
    failWrites: (name) => { failedCollection = name; },
    failReads: (name, error) => { failedRead = { name, error }; },
    records: () => records,
    writes,
  };
};

test('sending atomically writes one message, recipient unread counters and versioned signals', async () => {
  const h = createHarness({
    conversations: [{ _id: 'room', memberOpenids: ['alice', 'bob', 'carol'], type: 'group', unreadBy: { bob: 2 } }],
    signals: [{ _id: 'bob', bump: 7 }],
  });
  const result = await h.call('alice', 'sendMessage', { conversationId: 'room', text: 'hello' });
  assert.equal(result.ok, true);
  const id = result.data.message.id;
  const stored = h.records();
  assert.equal(stored.messages[id].text, 'hello');
  assert.deepEqual(stored.conversations.room.unreadBy, { bob: 3, carol: 1 });
  assert.equal(stored.conversations.room.lastMessageId, id);
  assert.equal(stored.chatSignals.bob.messageId, id);
  assert.equal(stored.chatSignals.bob.bump, 8);
  assert.equal(stored.chatSignals.bob.messageVersion, 8);
  assert.equal(stored.chatSignals.carol.messageVersion, 1);
  assert.equal(stored.chatSignals.alice, undefined);
});

test('a signal write failure rolls back the message and unread increment and reaches the API error boundary', async () => {
  const h = createHarness();
  h.failWrites('chatSignals');
  const result = await h.call('alice', 'sendMessage', { conversationId: 'room', text: 'hello' });
  assert.equal(result.ok, false);
  assert.equal(Object.keys(h.records().messages).length, 0);
  assert.deepEqual(h.records().conversations.room.unreadBy, {});
  assert.equal(h.writes.length, 0);
});

test('concurrent sends retain both messages, counters and signal increments', async () => {
  const h = createHarness();
  const results = await Promise.all([
    h.call('alice', 'sendMessage', { conversationId: 'room', text: 'one' }),
    h.call('alice', 'sendMessage', { conversationId: 'room', text: 'two' }),
  ]);
  assert.ok(results.every((item) => item.ok));
  assert.equal(Object.keys(h.records().messages).length, 2);
  assert.equal(h.records().conversations.room.unreadBy.bob, 2);
  assert.equal(h.records().chatSignals.bob.bump, 2);
  assert.equal(h.records().chatSignals.bob.messageVersion, 2);
});

test('signal initialization racing a first send never resets the message version', async () => {
  const h = createHarness();
  await Promise.all([
    h.call('alice', 'sendMessage', { conversationId: 'room', text: 'hello' }),
    h.call('bob', 'ensureChatSignal'),
  ]);
  assert.equal(h.records().chatSignals.bob.messageVersion, 1);
  assert.equal(h.records().chatSignals.bob.bump, 1);
  assert.equal(h.records().chatSignals.bob.kind, 'message');
  assert.equal((await h.call('bob', 'ensureChatSignal')).data.created, false);
});

test('message listing returns the latest bounded window beyond 100 records and never marks read', async () => {
  const messages = Array.from({ length: 150 }, (_, index) => ({
    _id: `message-${String(index).padStart(3, '0')}`, conversationId: 'room',
    fromOpenid: 'alice', text: String(index), createdAt: new Date(index * 1000),
  }));
  const h = createHarness({ messages, conversations: [{
    _id: 'room', memberOpenids: ['alice', 'bob'], lastMessageId: 'message-149', unreadBy: { bob: 150 },
  }] });
  const result = await h.call('bob', 'listMessages', { conversationId: 'room', limit: 40 });
  assert.equal(result.data.messages.length, 40);
  assert.equal(result.data.messages[0].text, '110');
  assert.equal(result.data.messages[39].text, '149');
  assert.equal(result.data.readCursor.messageId, 'message-149');
  assert.equal(h.records().conversations.room.unreadBy.bob, 150);
  assert.equal(h.writes.length, 0);
});

test('a stale displayed cursor cannot clear a later message; current acknowledgement produces only one state event', async () => {
  const h = createHarness();
  await h.call('alice', 'sendMessage', { conversationId: 'room', text: 'one' });
  const first = await h.call('bob', 'listMessages', { conversationId: 'room' });
  await h.call('alice', 'sendMessage', { conversationId: 'room', text: 'two' });
  const stale = await h.call('bob', 'markConversationRead', { conversationId: 'room', readCursor: first.data.readCursor });
  assert.deepEqual(stale.data, { applied: false, unreadCount: 2 });
  const latest = await h.call('bob', 'listMessages', { conversationId: 'room' });
  const event = { conversationId: 'room', readCursor: latest.data.readCursor };
  const applied = await h.call('bob', 'markConversationRead', event);
  assert.deepEqual(applied.data, { applied: true, unreadCount: 0 });
  assert.equal(h.records().chatSignals.bob.bump, 3);
  assert.equal(h.records().chatSignals.bob.messageVersion, 2);
  assert.equal(h.records().chatSignals.bob.kind, 'state');
  const writesBefore = h.writes.length;
  await h.call('bob', 'markConversationRead', event);
  assert.equal(h.writes.length, writesBefore);
});

test('legacy read cursors remain usable but become stale after the first new-format send', async () => {
  const initial = [{ _id: 'room', memberOpenids: ['alice', 'bob'], unreadBy: { bob: 2 },
    lastMessageAt: new Date(1000), updatedAt: new Date(1000) }];
  const h = createHarness({ conversations: initial, messages: [{
    _id: 'legacy-message', conversationId: 'room', fromOpenid: 'alice', text: 'old', createdAt: new Date(1000),
  }] });
  const legacy = await h.call('bob', 'listMessages', { conversationId: 'room' });
  assert.equal(legacy.data.readCursor.messageId, '');
  assert.equal((await h.call('bob', 'markConversationRead', { conversationId: 'room', readCursor: legacy.data.readCursor })).data.applied, true);
  await h.call('alice', 'sendMessage', { conversationId: 'room', text: 'new' });
  const stale = await h.call('bob', 'markConversationRead', { conversationId: 'room', readCursor: legacy.data.readCursor });
  assert.deepEqual(stale.data, { applied: false, unreadCount: 1 });
});

test('summary and conversation listing include all pages without signal initialization', async () => {
  const conversations = Array.from({ length: 205 }, (_, index) => ({
    _id: `room-${String(index).padStart(3, '0')}`, memberOpenids: ['alice', 'bob'], type: 'direct', unreadBy: { bob: 1 },
  }));
  const h = createHarness({ conversations, missingSignals: true });
  const summary = await h.call('bob', 'getUnreadSummary');
  assert.equal(summary.data.total, 205);
  assert.equal(Object.keys(summary.data.byId).length, 205);
  assert.equal((await h.call('bob', 'listConversations')).data.conversations.length, 205);
  assert.equal(h.writes.length, 0);
});

test('missing signal collection is explicit and unauthorized users cannot send or acknowledge', async () => {
  const h = createHarness({ missingSignals: true });
  assert.equal((await h.call('bob', 'ensureChatSignal')).code, 'COLLECTION_REQUIRED');
  assert.equal((await h.call('outsider', 'sendMessage', { conversationId: 'room', text: 'intrusion' })).code, 'FORBIDDEN');
  assert.equal((await h.call('outsider', 'markConversationRead', { conversationId: 'room', readCursor: { messageId: '' } })).code, 'FORBIDDEN');
  assert.equal((await h.call('', 'getUnreadSummary')).code, 'UNAUTHORIZED');
  assert.equal(h.writes.length, 0);
});

test('generic SDK error -1 on a signal read is never treated as a missing document', async () => {
  for (const reason of ['request timeout', 'permission denied']) {
    const h = createHarness({ signals: [{ _id: 'bob', bump: 9, messageVersion: 7 }] });
    h.failReads('chatSignals', Object.assign(new Error(`document.get:fail ${reason}`), { errCode: -1 }));
    assert.equal((await h.call('bob', 'ensureChatSignal')).ok, false);
    assert.equal((await h.call('alice', 'sendMessage', { conversationId: 'room', text: 'hello' })).ok, false);
    assert.equal(h.records().chatSignals.bob.bump, 9);
    assert.equal(h.records().chatSignals.bob.messageVersion, 7);
    assert.equal(Object.keys(h.records().messages).length, 0);
    assert.equal(h.writes.length, 0);
  }
});

test('a message window that omits the observed head cannot be acknowledged', async () => {
  for (const lastMessageId of ['missing-head', '']) {
    const h = createHarness({ conversations: [{
      _id: 'room', memberOpenids: ['alice', 'bob'], unreadBy: { bob: 1 }, lastMessageId,
    }] });
    const listed = await h.call('bob', 'listMessages', { conversationId: 'room' });
    assert.equal(listed.data.readCursor, null);
    assert.equal(h.records().conversations.room.unreadBy.bob, 1);
    assert.equal(h.writes.length, 0);
  }
});
