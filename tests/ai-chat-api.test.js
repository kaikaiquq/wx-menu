const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const FAKE_SECRET = 'sk-test-only-never-a-real-key';
const message = (content = '你好') => ({ role: 'user', content });
const responseBody = (text = '你好，我是小伴。') => ({
  status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
});

// Exercise the actual function, including native HTTPS request framing and retries
// against a revisioned transaction store. No real credential or network is used.
const createHarness = ({ env = {}, user = 'alice', clock = Date.UTC(2026, 8, 27), hold = false } = {}) => {
  let now = clock;
  let currentUser = user;
  let records = { alice: { _id: 'alice', nickname: 'Alice', coupleId: 'pair' }, bob: { _id: 'bob' } };
  let revision = 0;
  let readError;
  let writeError;
  let nextReply = {};
  let commitGate;
  const requests = [];
  const writes = [];
  const timers = new Map();
  const logs = [];
  const collection = (name, scope) => {
    assert.equal(name, 'users', 'AI must not create another collection');
    return { doc: (id) => ({
      get: async () => {
        if (readError) throw readError;
        const value = (scope?.records || records)[id];
        if (!value) throw new Error('document does not exist');
        return { data: structuredClone(value) };
      },
      update: async ({ data }) => {
        if (writeError) throw writeError;
        assert.ok(scope, 'usage writes must be transactional');
        assert.deepEqual(Object.keys(data), ['aiChatUsage']);
        scope.records[id] = { ...scope.records[id], ...structuredClone(data) };
        scope.writes.push({ id, data: structuredClone(data) });
      },
    }) };
  };
  const db = {
    collection: (name) => collection(name),
    runTransaction: async (callback) => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const expectedRevision = revision;
        const scope = { records: structuredClone(records), writes: [] };
        const result = await callback({ collection: (name) => collection(name, scope) });
        if (commitGate) {
          const gate = commitGate;
          commitGate = null;
          gate.enter();
          await gate.wait;
        }
        if (revision !== expectedRevision) continue;
        records = scope.records;
        writes.push(...scope.writes);
        if (scope.writes.length) revision += 1;
        return result;
      }
      throw new Error('transaction retry exhausted');
    },
  };
  const respond = (record, reply = nextReply) => {
    if (reply.throwTransport) {
      record.request.emit('error', Object.assign(new Error(reply.throwTransport), { code: reply.networkCode, details: reply.details }));
      return;
    }
    const response = new EventEmitter();
    response.statusCode = reply.status || 200;
    response.resume = () => { record.resumed = true; };
    record.response = response;
    record.callback(response);
    if (reply.responseError) {
      response.emit('error', Object.assign(new Error(reply.responseError), { code: reply.networkCode, details: reply.details }));
      return;
    }
    if (reply.aborted) { response.emit('aborted'); return; }
    if (reply.holdBody) return;
    const body = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body || responseBody());
    // Split inside a multibyte character to test Buffer-based UTF-8 decoding.
    const bytes = Buffer.from(body);
    const split = Math.min(bytes.length, bytes.indexOf(Buffer.from('你')) + 1);
    response.emit('data', bytes.subarray(0, split));
    response.emit('data', bytes.subarray(split));
    response.emit('end');
  };
  const https = { request: (options, callback) => {
    if (nextReply.throwRequest) throw Object.assign(new Error(nextReply.throwRequest), { code: nextReply.networkCode, details: nextReply.details });
    const request = new EventEmitter();
    const record = { options, callback, request, destroyed: false };
    requests.push(record);
    request.destroy = () => { record.destroyed = true; request.emit('error', new Error(FAKE_SECRET)); };
    request.end = (body) => {
      record.body = JSON.parse(body);
      record.rawBody = body;
      if (!hold) queueMicrotask(() => respond(record));
    };
    return request;
  } };
  let timerId = 0;
  const sandbox = {
    exports: {},
    require: (name) => name === 'wx-server-sdk'
      ? { init() {}, database: () => db, getWXContext: () => ({ OPENID: currentUser }) }
      : name === 'https' ? https : require(name),
    process: { env: { OPENAI_API_KEY: FAKE_SECRET, ...env } },
    Buffer,
    Date: class extends Date { static now() { return now; } },
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    console: { log: (...args) => logs.push(args), warn: (...args) => logs.push(args), error: (...args) => logs.push(args) },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../cloudfunctions/aiChatApi/index.js'), 'utf8'), sandbox);
  return {
    call: async (event = { action: 'reply', messages: [message()] }, openid = 'alice') => {
      currentUser = openid;
      return JSON.parse(JSON.stringify(await sandbox.exports.main(event)));
    },
    reply: (value) => { nextReply = value; },
    respond: (index, reply) => respond(requests[index], reply),
    socket: (index, { reused = false, connecting = true, authorized = false } = {}) => {
      const socket = Object.assign(new EventEmitter(), { connecting, authorized });
      requests[index].request.reusedSocket = reused;
      requests[index].request.emit('socket', socket);
      return socket;
    },
    records: () => records,
    advance: (milliseconds) => { now += milliseconds; },
    day: () => new Date(now + 8 * 3600_000).toISOString().slice(0, 10),
    failRead: (error) => { readError = error; },
    failWrite: (error) => { writeError = error; },
    expireRequest: () => {
      const entry = [...timers.values()][0];
      assert.equal(entry.delay, 25000);
      entry.callback();
    },
    pauseCommit: () => {
      let enter;
      let release;
      const entered = new Promise((resolve) => { enter = resolve; });
      const wait = new Promise((resolve) => { release = resolve; });
      commitGate = { enter, wait };
      return { entered, release };
    },
    requests, writes, timers, logs,
  };
};

const waitForRequests = async (h, count) => {
  for (let i = 0; i < 50 && h.requests.length < count; i += 1) await Promise.resolve();
  assert.equal(h.requests.length, count);
};
const assertSanitized = (h, result) => {
  assert.equal(result.ok, false);
  assert.deepEqual(Object.keys(result).sort(), result.details ? ['code', 'details', 'message', 'ok'] : ['code', 'message', 'ok']);
  if (result.details) {
    assert.ok(['network', 'http', 'response'].includes(result.details.stage));
    assert.ok(Object.keys(result.details).every((key) => ['stage', 'httpStatus', 'networkCode', 'networkPhase', 'elapsedMs'].includes(key)));
    if (result.details.networkPhase !== undefined) {
      assert.ok(['dns', 'tcp', 'tls', 'response_headers', 'response_body'].includes(result.details.networkPhase));
    }
    assert.ok(Number.isSafeInteger(result.details.elapsedMs) && result.details.elapsedMs >= 0);
  }
  assert.equal(JSON.stringify(result).includes(FAKE_SECRET), false);
  assert.equal(JSON.stringify(h.logs).includes(FAKE_SECRET), false);
  assert.ok(result.message.length > 0);
};

test('reply sends a bounded stateless Responses request and saves only usage metadata', async () => {
  const h = createHarness();
  const messages = [message('请推荐一个约会话题'), { role: 'assistant', content: '聊聊想一起去的地方。' }, message('还有呢？')];
  h.reply({ body: { ...responseBody(), output: [
    { type: 'reasoning', summary: [{ text: 'private reasoning' }] },
    { type: 'message', content: [{ type: 'output_text', text: '你好，' }, { type: 'output_text', text: '聊聊喜欢的音乐吧。' }] },
  ] } });
  const result = await h.call({ action: 'reply', messages, openid: 'bob', userId: 'bob' });
  assert.deepEqual(result, { ok: true, data: { text: '你好，\n聊聊喜欢的音乐吧。', model: 'gpt-5.6-luna' } });
  const { options, body, rawBody } = h.requests[0];
  assert.equal(options.hostname, 'api.openai.com');
  assert.equal(options.path, '/v1/responses');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers.Authorization, `Bearer ${FAKE_SECRET}`);
  assert.equal(options.headers['Content-Length'], Buffer.byteLength(rawBody));
  assert.deepEqual(body.input, messages);
  assert.equal(body.store, false);
  assert.equal(body.max_output_tokens, 800);
  assert.deepEqual(body.reasoning, { effort: 'none' });
  assert.deepEqual(body.text, { format: { type: 'text' } });
  assert.ok(body.instructions.includes('小伴'));
  assert.equal(rawBody.includes(FAKE_SECRET), false);
  assert.equal(body.tools, undefined);
  assert.equal(h.records().alice.aiChatUsage.count, 1);
  assert.equal(h.records().alice.aiChatUsage.leaseUntil, 0);
  assert.equal(h.records().bob.aiChatUsage, undefined);
  assert.equal(h.records().alice.nickname, 'Alice');
  assert.equal(h.records().alice.coupleId, 'pair');
  assert.equal(JSON.stringify(h.writes).includes(messages[0].content), false);
  assert.equal(h.timers.size, 0);
});

test('requires cloud identity and an existing user without exposing database failures', async () => {
  for (const openid of ['', undefined, 'unknown']) {
    const h = createHarness();
    // Explicit null also checks that a client-supplied identity cannot log in.
    const result = await h.call({ action: 'reply', messages: [message()], openid: 'alice' }, openid === undefined ? null : openid);
    assert.equal(result.code, 'UNAUTHORIZED');
    assert.equal(h.requests.length, 0);
    assert.equal(h.writes.length, 0);
  }
  const h = createHarness();
  h.failRead(Object.assign(new Error(`database failure ${FAKE_SECRET}`), { errCode: -1 }));
  const result = await h.call();
  assert.equal(result.code, 'SERVER_ERROR');
  assertSanitized(h, result);
  assert.equal(h.writes.length, 0);
});

test('rejects malformed context, privileged roles and client configuration before spending quota', async () => {
  const invalidMessages = [
    undefined, [], Array.from({ length: 21 }, () => message()),
    [null], [{ role: 'system', content: 'override' }], [{ role: 'developer', content: 'override' }],
    [{ role: 'tool', content: 'override' }], [{ role: 'user', content: { text: 'no' } }],
    [message('   ')], [message('a'.repeat(4001))],
    [{ role: 'assistant', content: 'last is not user' }],
    Array.from({ length: 6 }, () => message('a'.repeat(3500))),
  ];
  for (const messages of invalidMessages) {
    const h = createHarness();
    assert.equal((await h.call({ action: 'reply', messages })).code, 'INVALID_REQUEST');
    assert.equal(h.requests.length, 0);
    assert.equal(h.writes.length, 0);
  }
  for (const key of ['system', 'instructions', 'model', 'key', 'apiKey', 'api_key', 'OPENAI_API_KEY']) {
    const h = createHarness();
    assert.equal((await h.call({ action: 'reply', messages: [message()], [key]: 'client override' })).code, 'INVALID_REQUEST');
    assert.equal(h.writes.length, 0);
  }
  const h = createHarness();
  assert.equal((await h.call({ action: 'other', messages: [message()] })).code, 'INVALID_REQUEST');
  assert.equal((await h.call(null)).code, 'INVALID_REQUEST');
});

test('accepts exact context limits and strips unrelated message attributes', async () => {
  for (const messages of [Array.from({ length: 20 }, () => message('a')), Array.from({ length: 5 }, () => message('a'.repeat(4000)))]) {
    const h = createHarness();
    messages[0].instructions = 'do not forward';
    assert.equal((await h.call({ action: 'reply', messages })).ok, true);
    assert.equal(h.requests[0].body.input[0].instructions, undefined);
  }
});

test('configuration is server-only and missing or malformed configuration does not consume quota', async () => {
  for (const env of [{ OPENAI_API_KEY: '' }, { OPENAI_API_KEY: undefined }, { OPENAI_API_KEY: ' \n ' },
    { OPENAI_API_KEY: 'one\ntwo' }, { OPENAI_MODEL: 'https://bad.example/model' }, { OPENAI_MODEL: 'a'.repeat(101) }]) {
    const h = createHarness({ env });
    const result = await h.call();
    assert.equal(result.code, 'AI_NOT_CONFIGURED');
    assert.equal(h.requests.length, 0);
    assert.equal(h.writes.length, 0);
    assertSanitized(h, result);
  }
  const h = createHarness({ env: { OPENAI_MODEL: 'gpt-5.6-luna-2026-01-01' } });
  assert.equal((await h.call()).data.model, 'gpt-5.6-luna-2026-01-01');
  assert.equal(h.requests[0].body.model, 'gpt-5.6-luna-2026-01-01');
});

test('provider HTTP errors are mapped without exposing response bodies or credentials', async () => {
  for (const [status, code] of [[401, 'AI_AUTH_ERROR'], [403, 'AI_AUTH_ERROR'], [429, 'AI_RATE_LIMITED'],
    [400, 'AI_UNAVAILABLE'], [404, 'AI_UNAVAILABLE'], [500, 'AI_UNAVAILABLE'], [302, 'AI_UNAVAILABLE']]) {
    const h = createHarness();
    h.reply({ status, body: { error: { message: `credential ${FAKE_SECRET}`, code: 'raw-provider-code' } } });
    const result = await h.call();
    assert.equal(result.code, code);
    assert.deepEqual(result.details, { stage: 'http', httpStatus: status, networkPhase: 'response_body', elapsedMs: 0 });
    assertSanitized(h, result);
    assert.equal(h.requests.length, 1, 'requests must not follow redirects or retry provider failures');
    assert.equal(h.records().alice.aiChatUsage.count, 1);
    assert.equal(h.records().alice.aiChatUsage.leaseUntil, 0);
    assert.equal(h.timers.size, 0);
  }
});

test('transport, stream, parse, refusal and empty-output errors remain sanitized', async () => {
  for (const [reply, code] of [
    [{ throwTransport: FAKE_SECRET }, 'AI_UNAVAILABLE'],
    [{ throwRequest: FAKE_SECRET }, 'AI_UNAVAILABLE'],
    [{ responseError: FAKE_SECRET }, 'AI_UNAVAILABLE'],
    [{ aborted: true }, 'AI_UNAVAILABLE'],
    [{ body: `not json ${FAKE_SECRET}` }, 'AI_UNAVAILABLE'],
    [{ body: { error: { message: FAKE_SECRET } } }, 'AI_UNAVAILABLE'],
    [{ body: { status: 'failed', output: responseBody().output } }, 'AI_UNAVAILABLE'],
    [{ body: { output: [{ content: [{ type: 'refusal', refusal: FAKE_SECRET }] }] } }, 'AI_REFUSED'],
    [{ body: { output: [] } }, 'AI_EMPTY_RESPONSE'],
    [{ body: { output: [{ content: [{ type: 'output_text', text: '  ' }] }] } }, 'AI_EMPTY_RESPONSE'],
    [{ body: { output: [{ content: [{ type: 'text', text: FAKE_SECRET }] }] } }, 'AI_EMPTY_RESPONSE'],
    [{ body: responseBody(FAKE_SECRET) }, 'AI_UNAVAILABLE'],
    [{ body: 'x'.repeat(1_000_001) }, 'AI_UNAVAILABLE'],
  ]) {
    const h = createHarness();
    h.reply(reply);
    const result = await h.call();
    assert.equal(result.code, code);
    const stage = reply.throwTransport || reply.throwRequest || reply.responseError || reply.aborted ? 'network' : 'response';
    const receivedHeaders = !reply.throwTransport && !reply.throwRequest;
    assert.deepEqual(result.details, { stage, elapsedMs: 0,
      ...(receivedHeaders ? { httpStatus: 200, networkPhase: 'response_body' } : {}) });
    assertSanitized(h, result);
    assert.equal(h.records().alice.aiChatUsage.leaseUntil, 0);
    assert.equal(h.timers.size, 0);
  }
});

test('a 25-second absolute timeout destroys the request and ignores late success', async () => {
  const h = createHarness({ hold: true });
  const pending = h.call();
  await waitForRequests(h, 1);
  h.advance(25000);
  h.expireRequest();
  const result = await pending;
  assert.equal(result.code, 'AI_TIMEOUT');
  assert.deepEqual(result.details, { stage: 'network', networkCode: 'ETIMEDOUT', elapsedMs: 25000 });
  assertSanitized(h, result);
  assert.equal(h.requests[0].destroyed, true);
  h.respond(0, { body: responseBody('late reply') });
  assert.equal(h.requests[0].resumed, true);
  assert.equal(h.records().alice.aiChatUsage.leaseUntil, 0);
  assert.equal(h.timers.size, 0);
});

test('failure diagnostics allow only known network codes and never copy malicious error properties', async () => {
  for (const field of ['throwTransport', 'throwRequest', 'responseError']) {
    for (const networkCode of ['ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'CERT_HAS_EXPIRED',
      FAKE_SECRET, `ENOTFOUND ${FAKE_SECRET}`, 404, { toString: () => FAKE_SECRET }, undefined]) {
      const h = createHarness();
      h.reply({ [field]: FAKE_SECRET, networkCode, details: {
        stage: 'http', httpStatus: 401, message: FAKE_SECRET,
        body: FAKE_SECRET, headers: { Authorization: FAKE_SECRET }, url: `https://${FAKE_SECRET}`,
        networkPhase: FAKE_SECRET, elapsedMs: FAKE_SECRET,
      } });
      const result = await h.call();
      assert.equal(result.code, 'AI_UNAVAILABLE');
      const allowed = ['ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'CERT_HAS_EXPIRED'].includes(networkCode);
      assert.deepEqual(result.details, { stage: 'network', ...(allowed ? { networkCode } : {}),
        elapsedMs: 0,
        ...(field === 'responseError' ? { httpStatus: 200, networkPhase: 'response_body' } : {}) });
      assertSanitized(h, result);
      assert.equal(h.logs.length, 0);
    }
  }
  const h = createHarness();
  h.failRead(Object.assign(new Error(FAKE_SECRET), { code: 'ENOTFOUND', details: { stage: 'network', networkCode: 'ENOTFOUND' } }));
  const result = await h.call();
  assert.equal(result.code, 'SERVER_ERROR');
  assert.equal(result.details, undefined, 'database errors are not misidentified as provider network failures');
  assertSanitized(h, result);
});

test('the absolute deadline identifies DNS, TCP, TLS, headers and body stalls without exposing socket data', async () => {
  const phases = ['dns', 'tcp', 'tls', 'response_headers', 'response_body'];
  for (const phase of phases) {
    const h = createHarness({ hold: true });
    const pending = h.call();
    await waitForRequests(h, 1);
    const socket = h.socket(0);
    const position = phases.indexOf(phase);
    // Socket arguments deliberately contain a secret in place of any real address.
    if (position >= 1) socket.emit('lookup', null, FAKE_SECRET, 4, FAKE_SECRET);
    if (position >= 2) socket.emit('connect');
    if (position >= 3) socket.emit('secureConnect');
    if (position >= 4) h.respond(0, { status: 200, holdBody: true });
    h.advance(25000);
    h.expireRequest();
    const result = await pending;
    assert.equal(result.code, 'AI_TIMEOUT');
    assert.deepEqual(result.details, {
      stage: 'network', networkCode: 'ETIMEDOUT', networkPhase: phase, elapsedMs: 25000,
      ...(phase === 'response_body' ? { httpStatus: 200 } : {}),
    });
    assertSanitized(h, result);
    assert.equal(h.requests[0].destroyed, true);
    assert.equal(socket.listenerCount('lookup'), 0);
    assert.equal(socket.listenerCount('connect'), 0);
    assert.equal(socket.listenerCount('secureConnect'), 0);
    const frozenResult = JSON.stringify(result);
    socket.emit('lookup', null, FAKE_SECRET, 6, FAKE_SECRET);
    socket.emit('connect');
    socket.emit('secureConnect');
    h.respond(0, { body: responseBody('late response') });
    h.requests[0].request.emit('error', Object.assign(new Error(FAKE_SECRET), { code: 'ECONNRESET' }));
    assert.equal(JSON.stringify(result), frozenResult, 'late events cannot overwrite the first failure');
    assert.equal(h.timers.size, 0);
    assert.equal(h.logs.length, 0);
  }
});

test('reused and already connected TLS sockets report their real phase without waiting for missing events', async () => {
  for (const [settings, phase] of [
    [{ reused: true, connecting: false }, 'response_headers'],
    [{ connecting: false, authorized: true }, 'response_headers'],
    [{ connecting: false, authorized: false }, 'tls'],
  ]) {
    const h = createHarness({ hold: true });
    const pending = h.call();
    await waitForRequests(h, 1);
    const socket = h.socket(0, settings);
    // A late lookup event must not regress a connected socket to TCP.
    socket.emit('lookup', null, FAKE_SECRET, 4, FAKE_SECRET);
    h.advance(617);
    h.respond(0, { throwTransport: FAKE_SECRET, networkCode: 'ECONNRESET' });
    const result = await pending;
    assert.deepEqual(result.details, { stage: 'network', networkPhase: phase, elapsedMs: 617, networkCode: 'ECONNRESET' });
    assertSanitized(h, result);
    assert.equal(socket.listenerCount('connect'), 0);
    assert.equal(h.timers.size, 0);
  }
});

test('DNS failure stays at DNS; stream errors preserve received HTTP status and total elapsed time', async () => {
  const dns = createHarness({ hold: true });
  const dnsPending = dns.call();
  await waitForRequests(dns, 1);
  const dnsSocket = dns.socket(0);
  dnsSocket.emit('lookup', Object.assign(new Error(FAKE_SECRET), { code: 'ENOTFOUND' }), FAKE_SECRET, 4, FAKE_SECRET);
  dns.advance(125);
  dns.respond(0, { throwTransport: FAKE_SECRET, networkCode: 'ENOTFOUND' });
  const dnsResult = await dnsPending;
  assert.deepEqual(dnsResult.details, { stage: 'network', networkPhase: 'dns', networkCode: 'ENOTFOUND', elapsedMs: 125 });
  assertSanitized(dns, dnsResult);

  const h = createHarness({ hold: true });
  const pending = h.call();
  await waitForRequests(h, 1);
  const socket = h.socket(0);
  h.advance(20);
  socket.emit('lookup', null, FAKE_SECRET, 4, FAKE_SECRET);
  h.advance(30);
  socket.emit('connect');
  h.advance(50);
  socket.emit('secureConnect');
  h.advance(300);
  h.respond(0, { status: 201, holdBody: true });
  h.requests[0].response.emit('data', Buffer.from(FAKE_SECRET));
  h.advance(100);
  h.requests[0].response.emit('error', Object.assign(new Error(FAKE_SECRET), { code: 'ECONNRESET' }));
  const result = await pending;
  assert.deepEqual(result.details, {
    stage: 'network', networkPhase: 'response_body', networkCode: 'ECONNRESET', httpStatus: 201, elapsedMs: 500,
  });
  assertSanitized(h, result);
  assert.equal(h.timers.size, 0);
});

test('successful requests remove socket diagnostics listeners and ignore late errors', async () => {
  const h = createHarness({ hold: true });
  const pending = h.call();
  await waitForRequests(h, 1);
  const socket = h.socket(0);
  socket.emit('lookup', null, FAKE_SECRET, 4, FAKE_SECRET);
  socket.emit('connect');
  socket.emit('secureConnect');
  h.respond(0);
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.details, undefined);
  for (const event of ['lookup', 'connect', 'secureConnect']) assert.equal(socket.listenerCount(event), 0);
  h.requests[0].request.emit('error', new Error(FAKE_SECRET));
  h.requests[0].response.emit('error', new Error(FAKE_SECRET));
  assert.equal(result.ok, true);
  assert.equal(h.logs.length, 0);
});

test('three-second throttle and daily quota cannot be overridden by client fields', async () => {
  const h = createHarness();
  assert.equal((await h.call()).ok, true);
  h.advance(2999);
  assert.equal((await h.call()).code, 'AI_TOO_FREQUENT');
  h.advance(1);
  assert.equal((await h.call()).ok, true);
  h.advance(3000);
  h.records().alice.aiChatUsage.count = 100;
  const result = await h.call({ action: 'reply', messages: [message()], aiChatUsage: { count: 0 } });
  assert.equal(result.code, 'AI_DAILY_LIMIT');
  assert.equal(h.requests.length, 2);
});

test('daily quota resets at China midnight while preserving the minimum interval', async () => {
  const h = createHarness({ clock: Date.UTC(2026, 8, 27, 15, 59, 59) });
  h.records().alice.aiChatUsage = { day: h.day(), count: 100, lastRequestAt: Date.UTC(2026, 8, 27, 15, 59, 59) };
  h.advance(1000);
  assert.equal(h.day(), '2026-09-28');
  assert.equal((await h.call()).code, 'AI_TOO_FREQUENT');
  h.advance(2000);
  assert.equal((await h.call()).ok, true);
  assert.equal(h.records().alice.aiChatUsage.count, 1);
  assert.equal(h.records().alice.aiChatUsage.day, '2026-09-28');
});

test('concurrent reservations serialize and permit only one last daily request', async () => {
  const h = createHarness({ hold: true });
  h.records().alice.aiChatUsage = { day: h.day(), count: 99, lastRequestAt: 0 };
  const gate = h.pauseCommit();
  const first = h.call();
  await gate.entered;
  const second = h.call();
  await waitForRequests(h, 1);
  gate.release();
  assert.equal((await first).code, 'AI_BUSY');
  assert.equal(h.records().alice.aiChatUsage.count, 100);
  h.respond(0);
  assert.equal((await second).ok, true);
  h.advance(3000);
  assert.equal((await h.call()).code, 'AI_DAILY_LIMIT');
  assert.equal(h.requests.length, 1);
});

test('single-flight lease spans slow requests and recovers after abandoned invocations', async () => {
  const h = createHarness({ hold: true });
  const first = h.call();
  await waitForRequests(h, 1);
  h.advance(3000);
  assert.equal((await h.call()).code, 'AI_BUSY');
  // Simulate a worker dying without running finally; the next worker can recover.
  h.advance(32000);
  const recovered = h.call();
  await waitForRequests(h, 2);
  const lease = h.records().alice.aiChatUsage.leaseId;
  h.respond(0);
  assert.equal((await first).ok, true);
  assert.equal(h.records().alice.aiChatUsage.leaseId, lease, 'old worker must not clear the new lease');
  h.respond(1);
  assert.equal((await recovered).ok, true);
  assert.equal(h.records().alice.aiChatUsage.count, 2);
  assert.equal(h.records().alice.aiChatUsage.leaseUntil, 0);
});

test('usage transaction failures fail closed without calling the provider', async () => {
  const h = createHarness();
  h.failWrite(new Error(`write failure ${FAKE_SECRET}`));
  const result = await h.call();
  assert.equal(result.code, 'SERVER_ERROR');
  assertSanitized(h, result);
  assert.equal(h.requests.length, 0);
  assert.equal(h.records().alice.aiChatUsage, undefined);
});
