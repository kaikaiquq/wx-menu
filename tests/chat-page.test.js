const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../pages/chat/index.js'), 'utf8');
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const drain = () => new Promise((resolve) => setImmediate(resolve));
const cursor = { messageId: 'm1', lastMessageAt: '2026-09-24', updatedAt: '2026-09-24' };
const payload = { messages: [{ id: 'm1', text: '收到', fromOpenid: 'peer' }], readCursor: cursor };

const createPage = ({ chat = {}, auth = {}, cloud = {}, holdRender = false } = {}) => {
  const calls = { active: [], read: [], render: [], start: 0, unsubscribe: 0 };
  const state = { status: 'connected', total: 2, byId: { a: 2 } };
  let listener;
  let definition;
  const chatUnread = {
    start: () => { calls.start += 1; },
    subscribe: (fn) => {
      listener = fn;
      return () => { listener = null; calls.unsubscribe += 1; };
    },
    setActiveConversation: (id) => calls.active.push(id),
    getState: () => state,
    retry: () => {},
  };
  const chatApi = {
    listConversations: async () => ({ conversations: [{ id: 'a', title: '好友', unreadCount: 2 }] }),
    listMessages: async () => payload,
    markConversationRead: async (...args) => {
      calls.read.push(args);
      return { applied: true, unreadCount: 0 };
    },
    ...chat,
  };
  const modules = {
    '../../utils/auth': {
      getSelfOpenid: () => 'me',
      requireSession: async () => ({ user: { openid: 'me' } }),
      ...auth,
    },
    '../../utils/chat': chatApi,
    '../../utils/chat-unread': chatUnread,
    '../../utils/cloud': {
      resolveCloudFileUrl: async () => '',
      resolveCloudFileUrls: async () => ({}),
      uploadFileToCloud: async () => 'cloud://image',
      ...cloud,
    },
    '../../utils/theme': { getStoredThemeClass: () => '', syncTheme: () => '' },
    './emoji-data': { EMOJI_LIST: [] },
  };
  vm.runInNewContext(source, {
    require: (id) => modules[id],
    Page: (value) => { definition = value; },
    console: { warn: () => {} },
    setInterval: () => { throw new Error('消息页不得轮询'); },
    wx: {
      getStorageSync: () => '',
      removeStorageSync: () => {},
      nextTick: (fn) => fn(),
      showToast: () => {},
      showLoading: () => {},
      hideLoading: () => {},
    },
  });
  const page = {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    _visible: true,
    _viewGeneration: 1,
    _readCursors: {},
    getTabBar: () => null,
    setData(patch, callback) {
      Object.assign(this.data, patch);
      if (callback) {
        if (holdRender) calls.render.push(callback);
        else callback();
      }
    },
  };
  page.data.activeId = 'a';
  page.data.conversations = [{ id: 'a', title: '好友', unreadCount: 2 }];
  return { page, calls, state, emit: (event) => listener?.(event) };
};

test('页面复用全局推送，隐藏只注销页面订阅和当前会话', () => {
  const { page, calls } = createPage();
  page.startRealtime();
  assert.equal(calls.start, 1);
  assert.equal(calls.active.at(-1), 'a');
  page.stopRealtime();
  assert.equal(calls.unsubscribe, 1);
  assert.equal(calls.active.at(-1), '');
});

test('会话请求未返回时切页，不更新消息或确认已读', async () => {
  const response = deferred();
  const { page, calls } = createPage({ chat: { listMessages: () => response.promise } });
  const loading = page.loadMessages('a', true);
  page.stopRealtime();
  response.resolve(payload);
  await loading;
  assert.equal(page.data.messages.length, 0);
  assert.equal(calls.read.length, 0);
});

test('认证未返回时切页，不重新启动页面监听或拉取会话', async () => {
  const session = deferred();
  let listCalls = 0;
  const { page, calls } = createPage({
    auth: { requireSession: () => session.promise },
    chat: { listConversations: () => { listCalls += 1; return Promise.resolve({ conversations: [] }); } },
  });
  const showing = page.onShow();
  page.stopRealtime();
  session.resolve({ user: { openid: 'me' } });
  await showing;
  assert.equal(listCalls, 0);
  assert.equal(calls.start, 1);
});

test('只在消息渲染完成后提交已读，同一个游标不重复确认', async () => {
  const { page, calls } = createPage({ holdRender: true });
  await page.loadMessages('a', true);
  assert.equal(calls.read.length, 0);
  await calls.render.shift()();
  assert.equal(calls.read.length, 1);
  assert.equal(calls.read[0][0], 'a');
  assert.equal(calls.read[0][1], cursor);
  await page.loadMessages('a', true);
  await calls.render.shift()();
  assert.equal(calls.read.length, 1);
});

test('渲染期间隐藏页面或切换会话，不确认原会话已读', async () => {
  for (const transition of ['hide', 'switch']) {
    const { page, calls } = createPage({ holdRender: true });
    await page.loadMessages('a', true);
    if (transition === 'hide') page.stopRealtime();
    else page.data.activeId = 'b';
    await calls.render.shift()();
    assert.equal(calls.read.length, 0);
  }
});

test('没有一致游标的快照不确认已读', async () => {
  const { page, calls } = createPage({ chat: { listMessages: async () => ({ ...payload, readCursor: null }) } });
  await page.loadMessages('a', true);
  assert.equal(calls.read.length, 0);
  assert.equal(page.data.conversations[0].unreadCount, 2);
});

test('旧消息请求晚于新请求完成，不覆盖新消息或确认旧游标', async () => {
  const response = deferred();
  let count = 0;
  const { page, calls } = createPage({
    chat: { listMessages: () => (++count === 1 ? response.promise : Promise.resolve(payload)) },
  });
  const old = page.loadMessages('a', true);
  await page.loadMessages('a', true);
  response.resolve({ ...payload, messages: [{ id: 'old', text: '旧快照' }] });
  await old;
  assert.equal(page.data.messages[0].id, 'm1');
  assert.equal(calls.read.length, 1);
});

test('首次/重连快照检查消息，普通已读 state 信标不触发消息回拉循环', async () => {
  const { page } = createPage();
  let loads = 0;
  page.refreshConversations = async () => {};
  page.loadMessages = async () => { loads += 1; };
  await page.onChatSignal({ kind: 'state', initial: true });
  assert.equal(loads, 1);
  await page.onChatSignal({ kind: 'state' });
  assert.equal(loads, 1);
});

test('已读 state 推送只交给摘要处理，不触发额外的会话云函数', async () => {
  const { page, emit } = createPage();
  let refreshes = 0;
  page.refreshConversations = async () => { refreshes += 1; };
  page.loadMessages = async () => {};
  page.startRealtime();
  emit({ type: 'signal', kind: 'state' });
  await drain();
  assert.equal(refreshes, 0);
  emit({ type: 'signal', kind: 'state', initial: true });
  await drain();
  assert.equal(refreshes, 1);
});

test('消息同步失败保留手动重试入口，重试成功后清除提示', async () => {
  let failed = true;
  const { page } = createPage({
    chat: { listMessages: async () => {
      if (failed) throw new Error('network');
      return payload;
    } },
  });
  await page.loadMessages('a', true);
  assert.equal(page.data.connectionText, '消息同步失败，点击重试');
  page.updateConnectionStatus('connected');
  assert.equal(page.data.connectionText, '消息同步失败，点击重试');
  failed = false;
  page.retryConnection();
  await drain();
  assert.equal(page.data.connectionText, '');
  assert.equal(page.data.messages[0].id, 'm1');
});

test('多会话推送合并时仍刷新活动会话，并合并忙碌期间的后续通知', async () => {
  const response = deferred();
  const { page } = createPage();
  const loaded = [];
  page.refreshConversations = async () => {};
  page.loadMessages = async (id) => {
    loaded.push(id);
    if (loaded.length === 1) await response.promise;
  };
  const first = page.onChatSignal({ kind: 'message', conversationId: 'b' });
  await page.onChatSignal({ kind: 'message', conversationId: 'a' });
  await page.onChatSignal({ kind: 'message', conversationId: 'c' });
  response.resolve();
  await first;
  assert.deepEqual(loaded, ['a', 'a']);
});

test('好友面板遮挡时不确认消息，关闭面板后补同步当前会话', async () => {
  const { page, calls } = createPage();
  let loads = 0;
  page.data.showFriends = true;
  page.refreshConversations = async () => {};
  page.loadMessages = async () => { loads += 1; };
  await page.onChatSignal({ kind: 'message' });
  assert.equal(loads, 0);
  page.closeFriendsPanel();
  await drain();
  assert.equal(loads, 1);
  assert.equal(calls.active.at(-1), 'a');
});

test('摘要同步角标，旧会话列表不能覆盖全局未读数', async () => {
  const { page, state } = createPage();
  state.byId.a = 7;
  await page.refreshConversations(false, { skipMessages: true });
  assert.equal(page.data.conversations[0].unreadCount, 7);
  page.syncUnreadSummary({ a: 0 });
  assert.equal(page.data.conversations[0].unreadCount, 0);
});

test('旧已读确认返回时，不清除新推送的角标', async () => {
  const response = deferred();
  const { page } = createPage({ chat: { markConversationRead: () => response.promise } });
  await page.loadMessages('a', true);
  page.syncUnreadSummary({ a: 3 });
  response.resolve({ applied: true, unreadCount: 0 });
  await drain();
  assert.equal(page.data.conversations[0].unreadCount, 3);
});

test('发送文字期间切换会话，返回消息不插入新会话', async () => {
  const response = deferred();
  let target;
  const { page } = createPage({ chat: { sendMessage: (id) => { target = id; return response.promise; } } });
  page.data.draft = '发给 A';
  page.onChatSignal = async () => {};
  const sending = page.submitMessage();
  page.data.activeId = 'b';
  response.resolve({ message: payload.messages[0] });
  await sending;
  assert.equal(target, 'a');
  assert.equal(page.data.messages.length, 0);
  assert.equal(page.data.sending, false);
});

test('上传图片期间切换会话，图片仍发送到最初选择的会话', async () => {
  const upload = deferred();
  let target;
  const { page } = createPage({
    cloud: { uploadFileToCloud: () => upload.promise },
    chat: { sendImageMessage: async (id) => { target = id; return { message: payload.messages[0] }; } },
  });
  page.onChatSignal = async () => {};
  const sending = page.uploadAndSendImage('/tmp/a.jpg');
  page.data.activeId = 'b';
  upload.resolve('cloud://image');
  await sending;
  assert.equal(target, 'a');
  assert.equal(page.data.messages.length, 0);
});

test('发送响应晚于消息推送时，按消息 ID 去重', () => {
  const { page } = createPage();
  page.onChatSignal = async () => {};
  page.data.messages = [payload.messages[0]];
  page.showSentMessage('a', payload.messages[0], page._viewGeneration);
  assert.equal(page.data.messages.length, 1);
});
