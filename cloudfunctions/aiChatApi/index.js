const cloud = require('wx-server-sdk');
const https = require('https');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const DEFAULT_MODEL = 'gpt-5.6-luna';
const REQUEST_TIMEOUT_MS = 25_000;
const LEASE_MS = 35_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const NETWORK_PHASES = ['dns', 'tcp', 'tls', 'response_headers', 'response_body'];
const NETWORK_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED',
  'ECONNABORTED', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_SSL_WRONG_VERSION_NUMBER',
]);
const ERRORS = {
  INVALID_REQUEST: '消息格式不正确，请重新输入。',
  UNAUTHORIZED: '请先登录后再和小伴聊天。',
  AI_NOT_CONFIGURED: '小伴还未配置完成，请联系管理员。',
  AI_DAILY_LIMIT: '今天和小伴聊得很多啦，明天再来吧。',
  AI_TOO_FREQUENT: '发送得有点快，请稍等几秒再试。',
  AI_BUSY: '小伴正在回复上一条消息，请稍等。',
  AI_TIMEOUT: '小伴回复超时了，请稍后重试。',
  AI_RATE_LIMITED: '小伴现在有些忙，请稍后重试。',
  AI_AUTH_ERROR: '小伴的服务配置异常，请联系管理员。',
  AI_UNAVAILABLE: '小伴暂时无法回复，请稍后重试。',
  AI_REFUSED: '这条消息小伴暂时无法回答，换个话题试试吧。',
  AI_EMPTY_RESPONSE: '小伴没有生成回复，请稍后再试。',
  SERVER_ERROR: '服务暂时不可用，请稍后重试。',
};

class ChatError extends Error {
  constructor(code, details) {
    super(ERRORS[code]);
    this.code = code;
    if (details) this.details = details;
  }
}
const reject = (code) => { throw new ChatError(code); };
const safeDetails = (details) => {
  if (!details || !['network', 'http', 'response'].includes(details.stage)) return undefined;
  const result = { stage: details.stage };
  if (Number.isInteger(details.httpStatus) && details.httpStatus >= 100 && details.httpStatus <= 599) {
    result.httpStatus = details.httpStatus;
  }
  if (typeof details.networkCode === 'string' && NETWORK_CODES.has(details.networkCode)) {
    result.networkCode = details.networkCode;
  }
  if (NETWORK_PHASES.includes(details.networkPhase)) result.networkPhase = details.networkPhase;
  if (Number.isSafeInteger(details.elapsedMs) && details.elapsedMs >= 0) result.elapsedMs = details.elapsedMs;
  return result;
};
const networkDetails = (error) => {
  // Read only the code, never stringify a transport error or copy its properties.
  let networkCode;
  try { networkCode = error && error.code; } catch (_) { /* Ignore malformed error objects. */ }
  return safeDetails({ stage: 'network', networkCode });
};

const normalizeMessages = (event) => {
  if (!event || typeof event !== 'object' || event.action !== 'reply') reject('INVALID_REQUEST');
  // These settings belong exclusively to the server, even if a client supplies them.
  const forbidden = ['model', 'key', 'apiKey', 'api_key', 'OPENAI_API_KEY', 'system', 'instructions'];
  if (forbidden.some((key) => Object.prototype.hasOwnProperty.call(event, key))) reject('INVALID_REQUEST');
  const { messages } = event;
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 20) reject('INVALID_REQUEST');
  let length = 0;
  const normalized = messages.map((message) => {
    if (!message || typeof message !== 'object'
      || !['user', 'assistant'].includes(message.role)
      || typeof message.content !== 'string'
      || !message.content.trim() || message.content.length > 4000) reject('INVALID_REQUEST');
    length += message.content.length;
    return { role: message.role, content: message.content };
  });
  if (length > 20000 || normalized[normalized.length - 1].role !== 'user') reject('INVALID_REQUEST');
  return normalized;
};

const readConfiguration = () => {
  const apiKey = typeof process.env.OPENAI_API_KEY === 'string' ? process.env.OPENAI_API_KEY.trim() : '';
  const model = typeof process.env.OPENAI_MODEL === 'string' && process.env.OPENAI_MODEL.trim()
    ? process.env.OPENAI_MODEL.trim() : DEFAULT_MODEL;
  if (!apiKey || /[\r\n]/.test(apiKey) || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(model)) {
    reject('AI_NOT_CONFIGURED');
  }
  return { apiKey, model };
};

const readUser = async (reference) => {
  try {
    const result = await reference.get();
    if (!result || !result.data || !result.data._id) reject('UNAUTHORIZED');
    return result.data;
  } catch (error) {
    if (error instanceof ChatError) throw error;
    const message = String(error && (error.errMsg || error.message) || '');
    if (/document (?:does not |not )exist|document.*not found|cannot find document/i.test(message)) {
      reject('UNAUTHORIZED');
    }
    throw error;
  }
};

// China calendar days match the application's audience. Reservations count attempts,
// including provider failures; nothing about the messages is persisted.
const dayAt = (now) => new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
const reserveUsage = (openid, leaseId) => db.runTransaction(async (transaction) => {
  const reference = transaction.collection('users').doc(openid);
  const user = await readUser(reference);
  const now = Date.now();
  const usage = user.aiChatUsage || {};
  const day = dayAt(now);
  const count = usage.day === day && Number.isInteger(usage.count) && usage.count >= 0 ? usage.count : 0;
  if (Number.isFinite(usage.leaseUntil) && usage.leaseUntil > now) reject('AI_BUSY');
  if (Number.isFinite(usage.lastRequestAt) && now - usage.lastRequestAt < 3000) reject('AI_TOO_FREQUENT');
  if (count >= 100) reject('AI_DAILY_LIMIT');
  await reference.update({ data: { aiChatUsage: {
    day, count: count + 1, lastRequestAt: now, leaseId, leaseUntil: now + LEASE_MS,
  } } });
});

const releaseUsage = (openid, leaseId) => db.runTransaction(async (transaction) => {
  const reference = transaction.collection('users').doc(openid);
  const user = await readUser(reference);
  if (!user.aiChatUsage || user.aiChatUsage.leaseId !== leaseId) return;
  await reference.update({ data: { aiChatUsage: {
    ...user.aiChatUsage, leaseId: '', leaseUntil: 0,
  } } });
});

const callOpenAI = ({ apiKey, model }, messages) => new Promise((resolve, rejectPromise) => {
  const startedAt = Date.now();
  const body = JSON.stringify({
    model,
    instructions: '你是“小伴”，一位温暖、真诚、表达简洁的中文 AI 聊天助手。认真回应用户，可以陪聊、提供日常建议和协助思考。你只能看到本次提供的聊天内容，无法访问用户的伴侣、位置或应用数据；不要声称知道这些信息或已执行应用操作。',
    input: messages,
    max_output_tokens: 800,
    reasoning: { effort: 'none' },
    text: { format: { type: 'text' } },
    store: false,
  });
  let settled = false;
  let request;
  let timer;
  // Before a socket is assigned, do not mislabel an agent wait/request setup
  // failure as DNS. The phase is included only once there is transport evidence.
  let networkPhase;
  let httpStatus;
  let trackedSocket;
  const advancePhase = (phase) => {
    if (!settled && NETWORK_PHASES.indexOf(phase) > NETWORK_PHASES.indexOf(networkPhase)) networkPhase = phase;
  };
  // Event arguments can contain addresses/hostnames. Only lookup success matters.
  const socketEvents = {
    lookup: (error) => { if (!error) advancePhase('tcp'); },
    connect: () => advancePhase('tls'),
    secureConnect: () => advancePhase('response_headers'),
  };
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (trackedSocket) {
      Object.entries(socketEvents).forEach(([event, callback]) => trackedSocket.removeListener(event, callback));
    }
    if (error) rejectPromise(error);
    else resolve(value);
  };
  const fail = (code, details) => {
    if (settled) return;
    finish(new ChatError(code, safeDetails({
      ...details, networkPhase, elapsedMs: Math.max(0, Date.now() - startedAt), httpStatus,
    })));
  };
  timer = setTimeout(() => {
    fail('AI_TIMEOUT', { stage: 'network', networkCode: 'ETIMEDOUT' });
    if (request) request.destroy();
  }, REQUEST_TIMEOUT_MS);
  try {
    request = https.request({
      hostname: 'api.openai.com',
      port: 443,
      path: '/v1/responses',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (response) => {
      response.on('error', (error) => fail('AI_UNAVAILABLE', networkDetails(error)));
      response.on('aborted', () => fail('AI_UNAVAILABLE', { stage: 'network' }));
      if (settled) { response.resume(); return; }
      const status = response.statusCode || 0;
      httpStatus = status;
      advancePhase('response_body');
      if (status < 200 || status >= 300) {
        response.resume();
        fail(status === 429 ? 'AI_RATE_LIMITED' : status === 401 || status === 403 ? 'AI_AUTH_ERROR' : 'AI_UNAVAILABLE',
          { stage: 'http', httpStatus: status });
        request.destroy();
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          fail('AI_UNAVAILABLE', { stage: 'response' });
          request.destroy();
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.on('end', () => {
        if (settled) return;
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!result || result.error || result.status === 'failed' || result.status === 'cancelled') {
            fail('AI_UNAVAILABLE', { stage: 'response' });
            return;
          }
          const content = Array.isArray(result.output)
            ? result.output.flatMap((item) => Array.isArray(item && item.content) ? item.content : []) : [];
          if (content.some((item) => item && item.type === 'refusal')) { fail('AI_REFUSED', { stage: 'response' }); return; }
          const text = content.filter((item) => item && item.type === 'output_text' && typeof item.text === 'string')
            .map((item) => item.text).join('\n').trim();
          if (!text) { fail('AI_EMPTY_RESPONSE', { stage: 'response' }); return; }
          // Do not expose a credential even if an upstream/misconfigured proxy echoes it.
          if (text.includes(apiKey)) { fail('AI_UNAVAILABLE', { stage: 'response' }); return; }
          finish(null, text);
        } catch (_) { fail('AI_UNAVAILABLE', { stage: 'response' }); }
      });
    });
    request.once('socket', (socket) => {
      if (settled) return;
      trackedSocket = socket;
      // Reused HTTPS sockets emit no new lookup/connect/secureConnect events.
      if (request.reusedSocket || socket.authorized === true) advancePhase('response_headers');
      else if (socket.connecting === false) advancePhase('tls');
      else advancePhase('dns');
      Object.entries(socketEvents).forEach(([event, callback]) => socket.on(event, callback));
    });
    request.on('error', (error) => fail('AI_UNAVAILABLE', networkDetails(error)));
    request.end(body);
  } catch (error) { fail('AI_UNAVAILABLE', networkDetails(error)); }
});

exports.main = async (event = {}) => {
  let openid;
  let leaseId;
  let reserved = false;
  try {
    openid = cloud.getWXContext().OPENID;
    if (typeof openid !== 'string' || !openid) reject('UNAUTHORIZED');
    const messages = normalizeMessages(event);
    // Check the account before configuration, without consuming an attempt on a
    // deployment that has not yet received its server-side environment variables.
    await readUser(db.collection('users').doc(openid));
    const configuration = readConfiguration();
    leaseId = crypto.randomBytes(16).toString('hex');
    await reserveUsage(openid, leaseId);
    reserved = true;
    const text = await callOpenAI(configuration, messages);
    return { ok: true, data: { text, model: configuration.model } };
  } catch (error) {
    const code = error instanceof ChatError ? error.code : 'SERVER_ERROR';
    const details = error instanceof ChatError ? safeDetails(error.details) : undefined;
    return { ok: false, code, message: ERRORS[code], ...(details ? { details } : {}) };
  } finally {
    if (reserved) {
      // The bounded lease also recovers from process termination or cleanup failure.
      try { await releaseUsage(openid, leaseId); } catch (_) { /* No user data or provider errors are logged. */ }
    }
  }
};
