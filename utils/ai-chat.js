const { callCloud } = require('./cloud');

const AI_CONVERSATION_ID = 'ai-companion';
const AI_NAME = '小伴';
const STORAGE_PREFIX = 'couple.chat.ai.v1:';
const MAX_HISTORY = 60;
const MAX_INPUT = 2000;
const states = new Map();
let sequence = 0;

const ERROR_MESSAGES = {
  AI_NOT_CONFIGURED: '小伴还没有配置好，请稍后再来',
  UNAUTHORIZED: '请重新登录后再试',
  SESSION_CHANGED: '登录状态已更新，请重新进入聊天',
  INVALID_REQUEST: '消息格式有误，请修改后再试',
  AI_DAILY_LIMIT: '今天和小伴聊得很多啦，明天再来吧',
  AI_TOO_FREQUENT: '发得有点快，请稍等几秒再试',
  AI_BUSY: '小伴还在回复，请稍等',
  AI_TIMEOUT: '小伴回复超时了，可以点击重试',
  AI_RATE_LIMITED: '小伴暂时忙碌，请稍后重试',
  AI_AUTH_ERROR: '小伴的服务配置暂时不可用，请稍后再试',
  AI_REFUSED: '小伴暂时无法回答这条消息，换个话题试试吧',
  AI_EMPTY_RESPONSE: '小伴没有返回内容，可以点击重试',
};

const makeError = (code, message) => Object.assign(new Error(message), { code });
const isCurrentUser = (openid) => Boolean(openid && require('./auth').getSelfOpenid() === openid);
const assertCurrentUser = (openid) => {
  if (!isCurrentUser(openid)) throw makeError('SESSION_CHANGED', ERROR_MESSAGES.SESSION_CHANGED);
};
const copyMessages = (messages) => messages.map((message) => ({ ...message }));
const newId = () => `ai-${Date.now()}-${++sequence}`;
const interruptedText = '上次回复未完成，可以点击重试';

const normalizeHistory = (value, openid) => {
  if (!Array.isArray(value?.messages)) return [];
  const ids = new Set();
  return value.messages.slice(-MAX_HISTORY).filter((message) => {
    if (!message || typeof message.id !== 'string' || !/^ai-[a-zA-Z0-9-]+$/.test(message.id)
      || ids.has(message.id) || typeof message.text !== 'string' || !message.text.trim()
      || !Number.isFinite(message.createdAt) || typeof message.isMine !== 'boolean') return false;
    ids.add(message.id);
    return true;
  }).map((message) => ({
    id: message.id,
    text: message.text.slice(0, message.isMine ? MAX_INPUT : 8000),
    fromOpenid: message.isMine ? openid : AI_CONVERSATION_ID,
    isMine: message.isMine,
    createdAt: message.createdAt,
    msgType: 'text',
    status: message.isMine && ['sending', 'failed'].includes(message.status) ? 'failed' : 'sent',
  }));
};

const stateFor = (openid) => {
  if (!states.has(openid)) {
    let stored;
    try { stored = wx.getStorageSync(`${STORAGE_PREFIX}${openid}`); } catch (error) { /* no cache */ }
    const messages = normalizeHistory(stored, openid);
    const last = messages[messages.length - 1];
    states.set(openid, {
      messages,
      sending: false,
      error: last?.status === 'failed' ? interruptedText : '',
      listeners: new Set(),
    });
  }
  return states.get(openid);
};

const snapshot = (state) => ({
  messages: copyMessages(state.messages), sending: state.sending, error: state.error,
});

const publish = (openid, state) => {
  state.messages = state.messages.slice(-MAX_HISTORY);
  try {
    wx.setStorageSync(`${STORAGE_PREFIX}${openid}`, { messages: copyMessages(state.messages) });
  } catch (error) { /* Keep the current conversation usable when local storage is full. */ }
  if (!isCurrentUser(openid)) return;
  state.listeners.forEach((callback) => {
    try { callback(snapshot(state)); } catch (error) { /* One view must not break the request. */ }
  });
};

// Only this AI conversation goes upstream. Failed attempts are not conversation context.
const contextFor = (messages) => {
  const context = [];
  let length = 0;
  for (let i = messages.length - 1; i >= 0 && context.length < 20; i -= 1) {
    const message = messages[i];
    if (message.status === 'failed') continue;
    const content = message.text.slice(0, 4000);
    if (length + content.length > 20000) break;
    context.unshift({ role: message.isMine ? 'user' : 'assistant', content });
    length += content.length;
  }
  // Truncation must not leave an assistant reply without its preceding user turn.
  while (context.length && context[0].role !== 'user') context.shift();
  return context;
};

const requestReply = async (openid, state, userMessage) => {
  state.sending = true;
  state.error = '';
  userMessage.status = 'sending';
  publish(openid, state);
  try {
    assertCurrentUser(openid);
    const result = await callCloud('aiChatApi', 'reply', { messages: contextFor(state.messages) });
    if (typeof result?.text !== 'string' || !result.text.trim()) {
      throw makeError('AI_EMPTY_RESPONSE', ERROR_MESSAGES.AI_EMPTY_RESPONSE);
    }
    userMessage.status = 'sent';
    const message = {
      id: newId(), text: result.text.trim().slice(0, 8000), fromOpenid: AI_CONVERSATION_ID,
      isMine: false, createdAt: Date.now(), msgType: 'text', status: 'sent',
    };
    state.messages.push(message);
    return { messages: copyMessages(state.messages.slice(-MAX_HISTORY)), message: { ...message } };
  } catch (error) {
    userMessage.status = 'failed';
    // Never display or persist raw upstream errors, headers, or credentials.
    const code = Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, error?.code) ? error.code : 'AI_UNAVAILABLE';
    state.error = ERROR_MESSAGES[code] || '小伴暂时无法回复，请稍后重试';
    throw makeError(code, state.error);
  } finally {
    state.sending = false;
    publish(openid, state);
  }
};

const getMessages = (openid) => isCurrentUser(openid) ? copyMessages(stateFor(openid).messages) : [];
const getState = (openid) => {
  if (!isCurrentUser(openid)) return { sending: false, error: '' };
  const state = stateFor(openid);
  return { sending: state.sending, error: state.error };
};
const subscribe = (openid, callback) => {
  if (!isCurrentUser(openid) || typeof callback !== 'function') return () => {};
  const state = stateFor(openid);
  state.listeners.add(callback);
  return () => state.listeners.delete(callback);
};

const sendMessage = async (openid, input) => {
  assertCurrentUser(openid);
  const text = typeof input === 'string' ? input.trim() : '';
  if (!text || text.length > MAX_INPUT) throw makeError('INVALID_REQUEST', `请输入 1～${MAX_INPUT} 字的消息`);
  const state = stateFor(openid);
  if (state.sending) throw makeError('AI_BUSY', ERROR_MESSAGES.AI_BUSY);
  const message = {
    id: newId(), text, fromOpenid: openid, isMine: true,
    createdAt: Date.now(), msgType: 'text', status: 'sending',
  };
  state.messages.push(message);
  return requestReply(openid, state, message);
};

const retry = async (openid) => {
  assertCurrentUser(openid);
  const state = stateFor(openid);
  if (state.sending) throw makeError('AI_BUSY', ERROR_MESSAGES.AI_BUSY);
  const message = state.messages[state.messages.length - 1];
  if (!message?.isMine || message.status !== 'failed') {
    throw makeError('INVALID_REQUEST', '没有需要重试的消息');
  }
  return requestReply(openid, state, message);
};

module.exports = { AI_CONVERSATION_ID, AI_NAME, getMessages, getState, retry, sendMessage, subscribe };
