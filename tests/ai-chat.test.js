const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../utils/ai-chat.js'), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
function setup(storage = new Map()) {
  let openid = 'alice';
  let impl = async () => ({ text: '你好，我是小伴', model: 'test-model' });
  const calls = [];
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module,
    wx: {
      getStorageSync: (key) => storage.get(key),
      setStorageSync: (key, value) => storage.set(key, plain(value)),
    },
    require: (name) => {
      if (name === './auth') return { getSelfOpenid: () => openid };
      if (name === './cloud') return { callCloud: (...args) => { calls.push(plain(args)); return impl(...args); } };
      throw new Error(name);
    },
  });
  return { api: module.exports, calls, storage, setImpl: (fn) => { impl = fn; }, setUser: (id) => { openid = id; } };
}

test('AI history is local to the current account; only AI context is sent', async () => {
  const h = setup();
  h.storage.set('couple.chat.activeId', 'private-partner-conversation');
  await h.api.sendMessage('alice', '你好');
  await h.api.sendMessage('alice', '继续聊吧');
  assert.deepEqual(h.calls[1], ['aiChatApi', 'reply', { messages: [
    { role: 'user', content: '你好' }, { role: 'assistant', content: '你好，我是小伴' },
    { role: 'user', content: '继续聊吧' },
  ] }]);
  h.setUser('bob');
  assert.equal(h.api.getMessages('alice').length, 0);
  assert.equal(h.api.getMessages('bob').length, 0);
  await assert.rejects(h.api.sendMessage('alice', '不应发送'), { code: 'SESSION_CHANGED' });
  await h.api.sendMessage('bob', '我是另一个人');
  assert.deepEqual(h.calls[2][2].messages, [{ role: 'user', content: '我是另一个人' }]);
  h.setUser('alice');
  assert.equal(h.api.getMessages('alice').length, 4);
});

test('one in-flight request per account; late completion stays with its account', async () => {
  const h = setup();
  const pending = deferred();
  const events = [];
  const unsubscribe = h.api.subscribe('alice', (event) => events.push(event));
  h.setImpl(() => pending.promise);
  const request = h.api.sendMessage('alice', '慢慢想');
  assert.equal(h.api.getState('alice').sending, true);
  await assert.rejects(h.api.sendMessage('alice', '重复'), { code: 'AI_BUSY' });
  await assert.rejects(h.api.retry('alice'), { code: 'AI_BUSY' });
  assert.equal(h.calls.length, 1);
  h.setUser('bob');
  pending.resolve({ text: '想好了' });
  await request;
  assert.equal(events.length, 1);
  assert.equal(h.api.getMessages('bob').length, 0);
  h.setUser('alice');
  assert.equal(h.api.getMessages('alice')[1].text, '想好了');
  assert.equal(h.api.getState('alice').sending, false);
  unsubscribe();
});

test('failure is sanitized; retry reuses the user bubble and preserves context', async () => {
  const h = setup();
  h.setImpl(async () => { throw new Error('secret upstream payload'); });
  await assert.rejects(h.api.sendMessage('alice', '问题'), { code: 'AI_UNAVAILABLE' });
  const failed = h.api.getMessages('alice')[0];
  assert.equal(failed.status, 'failed');
  assert.equal(JSON.stringify([...h.storage]).includes('secret upstream'), false);
  h.setImpl(async () => ({ text: '回答' }));
  const result = await h.api.retry('alice');
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].id, failed.id);
  assert.equal(result.messages[0].status, 'sent');
  assert.equal(h.api.getState('alice').error, '');
  assert.deepEqual(h.calls[0][2], h.calls[1][2]);
});

test('sending a new question keeps failed bubbles but excludes them from AI context', async () => {
  const h = setup();
  h.setImpl(async () => { throw { code: 'AI_TIMEOUT' }; });
  await assert.rejects(h.api.sendMessage('alice', '失败的问题'), { code: 'AI_TIMEOUT' });
  h.setImpl(async () => ({ text: '新回答' }));
  await h.api.sendMessage('alice', '新的问题');
  assert.deepEqual(h.calls[1][2].messages, [{ role: 'user', content: '新的问题' }]);
  assert.equal(h.api.getMessages('alice').length, 3);
  await assert.rejects(h.api.retry('alice'), { code: 'INVALID_REQUEST' });
});

test('restart recovers interrupted requests as retryable and validates cached data', async () => {
  const h = setup();
  const pending = deferred();
  h.setImpl(() => pending.promise);
  const request = h.api.sendMessage('alice', '未完成');
  const restored = setup(h.storage);
  assert.equal(restored.api.getMessages('alice')[0].status, 'failed');
  assert.equal(restored.api.getState('alice').sending, false);
  assert.ok(restored.api.getState('alice').error);
  await restored.api.retry('alice');
  assert.equal(restored.api.getMessages('alice').length, 2);
  pending.resolve({ text: '完成' });
  await request;
  const cache = h.storage.get('couple.chat.ai.v1:alice');
  cache.messages.push({ id: 'bad-id', text: 'invalid' }, cache.messages[0]);
  cache.messages[0].fromOpenid = 'forged-identity';
  const validated = setup(h.storage);
  assert.equal(validated.api.getMessages('alice').length, 2);
  assert.equal(validated.api.getMessages('alice')[0].fromOpenid, 'alice');
});

test('context and stored history are bounded; returned snapshots cannot mutate state', async () => {
  const h = setup();
  for (let i = 0; i < 35; i += 1) await h.api.sendMessage('alice', `第${i}问${'长'.repeat(1900)}`);
  assert.equal(h.api.getMessages('alice').length, 60);
  const context = h.calls[h.calls.length - 1][2].messages;
  assert.ok(context.length <= 20);
  assert.ok(context.reduce((sum, m) => sum + m.content.length, 0) <= 20000);
  assert.equal(context[0].role, 'user');
  assert.equal(context[context.length - 1].role, 'user');
  h.api.getMessages('alice')[0].text = 'mutated';
  assert.notEqual(h.api.getMessages('alice')[0].text, 'mutated');
});

test('invalid input and empty upstream output fail without leaking raw errors', async () => {
  const h = setup();
  for (const input of ['', '  ', null, 'x'.repeat(2001)]) {
    await assert.rejects(h.api.sendMessage('alice', input), { code: 'INVALID_REQUEST' });
  }
  assert.equal(h.calls.length, 0);
  h.setImpl(async () => ({ text: '  ' }));
  await assert.rejects(h.api.sendMessage('alice', '你好'), { code: 'AI_EMPTY_RESPONSE' });
  assert.equal(h.api.getMessages('alice')[0].status, 'failed');
  assert.equal(h.api.getState('alice').sending, false);
});
