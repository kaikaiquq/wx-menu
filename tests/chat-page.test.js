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
const AI_ID = 'ai-companion';

const createPage = ({ chat = {}, auth = {}, cloud = {}, ai = {}, holdRender = false, storedActiveId = '' } = {}) => {
  const calls = { active: [], read: [], render: [], start: 0, unsubscribe: 0, lists: 0, messageLists: [], humanSent: [], aiSent: [], aiRetries: [], aiSubscriptions: [], aiUnsubscribe: 0, toasts: [] };
  const state = { status: 'connected', total: 2, byId: { a: 2 } };
  let listener;
  let definition;
  const aiStates = new Map();
  const aiListeners = new Map();
  const aiState = (openid) => {
    if (!aiStates.has(openid)) aiStates.set(openid, { messages: [], sending: false, error: '' });
    return aiStates.get(openid);
  };
  const emitAI = (openid, patch) => {
    const snapshot = Object.assign(aiState(openid), patch);
    aiListeners.get(openid)?.forEach((fn) => fn(snapshot));
  };
  const aiChat = {
    AI_CONVERSATION_ID: AI_ID, AI_NAME: '小伴',
    getMessages: (openid) => aiState(openid).messages,
    getState: (openid) => aiState(openid),
    subscribe: (openid, fn) => {
      if (!aiListeners.has(openid)) aiListeners.set(openid, new Set());
      aiListeners.get(openid).add(fn);
      calls.aiSubscriptions.push({ openid, fn });
      return () => { calls.aiUnsubscribe += 1; aiListeners.get(openid).delete(fn); };
    },
    sendMessage: async (openid, text) => {
      calls.aiSent.push([openid, text]);
      if (ai.sendMessage) return ai.sendMessage(openid, text);
      const messages = [
        ...aiState(openid).messages,
        { id: 'ai-user', text, isMine: true, fromOpenid: openid, msgType: 'text', status: 'sent' },
        { id: 'ai-reply', text: '我在，慢慢说。', isMine: false, fromOpenid: AI_ID, msgType: 'text', status: 'sent' },
      ];
      emitAI(openid, { messages, sending: false, error: '' });
      return { messages, message: messages.at(-1) };
    },
    retry: async (openid) => {
      calls.aiRetries.push(openid);
      return ai.retry?.(openid);
    },
  };
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
    listConversations: async () => { calls.lists += 1; return { conversations: [{ id: 'a', title: '好友', unreadCount: 2 }] }; },
    listMessages: async (id) => { calls.messageLists.push(id); return payload; },
    sendMessage: async (...args) => { calls.humanSent.push(args); return { message: payload.messages[0] }; },
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
    '../../utils/ai-chat': aiChat,
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
      getStorageSync: (key) => key === 'couple.chat.activeId' ? storedActiveId : '',
      removeStorageSync: () => {},
      nextTick: (fn) => fn(),
      showToast: (value) => calls.toasts.push(value),
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
  page.data.myOpenid = 'me';
  page.data.conversations = [{ id: 'a', title: '好友', unreadCount: 2 }];
  return { page, calls, state, aiState, emitAI, emit: (event) => listener?.(event) };
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
  assert.equal(page.data.conversations.find((item) => item.id === 'a').unreadCount, 7);
  page.syncUnreadSummary({ a: 0 });
  assert.equal(page.data.conversations.find((item) => item.id === 'a').unreadCount, 0);
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

const selectAI = async (page) => {
  await page.refreshConversations(false, { skipMessages: true });
  await page.selectConversation({ currentTarget: { dataset: { id: AI_ID } } });
};

test('小伴固定在对象正下方，保留好友顺序并默认选中对象', async () => {
  const { page } = createPage({ chat: { listConversations: async () => ({ conversations: [
    { id: 'couple', title: '对象', isCouple: true },
    { id: 'friend-b', title: '乙' }, { id: 'friend-a', title: '甲' },
  ] }) } });
  page.data.activeId = '';
  await page.refreshConversations(true);
  assert.deepEqual(Array.from(page.data.conversations, (item) => item.id), ['couple', AI_ID, 'friend-b', 'friend-a']);
  assert.equal(page.data.conversations[1].title, '小伴');
  assert.equal(page.data.conversations[1].isAI, true);
  assert.equal(page.data.activeId, 'couple');
  assert.equal(page.data.isAIActive, false);
});

test('已登录且没有伴侣或好友仍可进入小伴，不调用真人消息或已读接口', async () => {
  const { page, calls } = createPage({ chat: { listConversations: async () => ({ conversations: [] }) } });
  page.data.activeId = '';
  await page.onShow();
  assert.equal(page.data.activeId, AI_ID);
  assert.equal(page.data.activeTitle, '小伴');
  assert.equal(page.data.isAIActive, true);
  assert.equal(calls.messageLists.length, 0);
  assert.equal(calls.read.length, 0);
  assert.ok(calls.active.every((id) => id !== AI_ID));
});

test('真人会话列表失败时仍提供小伴入口，错误不会伪装成AI错误', async () => {
  const { page, calls } = createPage({ chat: { listConversations: async () => { throw new Error('human offline'); } } });
  page.data.activeId = '';
  await page.onShow();
  assert.equal(page.data.conversations[0].id, AI_ID);
  assert.equal(page.data.activeId, AI_ID);
  assert.equal(page.data.aiError, '');
  assert.equal(page.data.connectionText, '');
  assert.equal(calls.toasts.length, 0);
});

test('小伴只接收在其会话输入的文字，不带入真人历史或未发送草稿', async () => {
  const { page, calls } = createPage();
  page.data.messages = [{ id: 'private', text: '真人历史', fromOpenid: 'peer' }];
  page.data.draft = '写给好友的草稿';
  await selectAI(page);
  assert.equal(page.data.draft, '');
  assert.equal(page.data.messages.length, 0);
  page.updateDraft({ detail: { value: '今天想吃什么？' } });
  await page.submitMessage();
  assert.deepEqual(calls.aiSent, [['me', '今天想吃什么？']]);
  assert.equal(calls.humanSent.length, 0);
  assert.equal(calls.messageLists.length, 0);
  assert.equal(calls.read.length, 0);
  assert.equal(page.data.messages.at(-1).fromNickname, '小伴');
  await page.selectConversation({ currentTarget: { dataset: { id: 'a' } } });
  assert.equal(page.data.draft, '写给好友的草稿');
});

test('AI选中时真人推送只刷新侧栏，不拉取AI消息、不改变AI错误且AI没有未读角标', async () => {
  const { page, calls, state, emit } = createPage();
  await selectAI(page);
  page.startRealtime();
  const listCount = calls.lists;
  emit({ type: 'status', status: 'error' });
  emit({ type: 'signal', kind: 'message', conversationId: 'a' });
  state.byId = { a: 7, [AI_ID]: 9 };
  emit({ type: 'summary', byId: { a: 7, [AI_ID]: 9 } });
  await drain();
  assert.equal(calls.lists, listCount + 1);
  assert.equal(calls.messageLists.length, 0);
  assert.equal(calls.read.length, 0);
  assert.equal(page.data.connectionText, '');
  assert.equal(page.data.aiError, '');
  assert.equal(page.data.conversations.find((item) => item.id === 'a').unreadCount, 7);
  assert.equal(page.data.conversations.find((item) => item.id === AI_ID).unreadCount, 0);
  assert.equal(calls.active.at(-1), '');
});

test('AI发送中展示思考状态，切换到真人后晚回复不污染消息或草稿', async () => {
  const pending = deferred();
  const { page, calls, emitAI } = createPage({ ai: { sendMessage: () => pending.promise } });
  await selectAI(page);
  page.data.draft = '向小伴提问';
  const sending = page.submitMessage();
  assert.equal(page.data.aiSending, true);
  assert.equal(page.data.draft, '');
  await page.selectConversation({ currentTarget: { dataset: { id: 'a' } } });
  page.data.draft = '真人新草稿';
  const messages = [{ id: 'ai-late', text: 'AI晚回复', isMine: false, fromOpenid: AI_ID }];
  emitAI('me', { messages, sending: false, error: '' });
  pending.resolve({ messages, message: messages[0] });
  await sending;
  assert.equal(page.data.messages[0].id, 'm1');
  assert.equal(page.data.draft, '真人新草稿');
  assert.equal(page.data.isAIActive, false);
  assert.equal(calls.aiUnsubscribe, 1);
});

test('真人发送晚响应到达AI页时不插入真人消息或触发AI上传', async () => {
  const pending = deferred();
  const { page, calls } = createPage({ chat: { sendMessage: () => pending.promise } });
  page.data.draft = '发给真人';
  const sending = page.submitMessage();
  await selectAI(page);
  const listCount = calls.lists;
  pending.resolve({ message: payload.messages[0] });
  await sending;
  assert.equal(page.data.messages.length, 0);
  assert.equal(page.data.isAIActive, true);
  assert.equal(calls.aiSent.length, 0);
  assert.equal(calls.lists, listCount + 1);
});

test('AI激活时真人新增会话进入侧栏，列表失败不覆盖AI状态', async () => {
  let failed = false;
  let conversations = [{ id: 'a', title: '好友甲' }];
  const { page, calls } = createPage({ chat: { listConversations: async () => {
    if (failed) throw new Error('human service unavailable');
    return { conversations };
  } } });
  await selectAI(page);
  page.data.draft = '正在给小伴写字';
  conversations = [...conversations, { id: 'new-friend', title: '新好友' }];
  await page.onChatSignal({ kind: 'message', conversationId: 'new-friend' });
  assert.ok(page.data.conversations.some((item) => item.id === 'new-friend'));
  assert.equal(page.data.activeId, AI_ID);
  assert.equal(page.data.draft, '正在给小伴写字');
  assert.equal(calls.messageLists.length, 0);
  assert.equal(calls.read.length, 0);
  failed = true;
  await page.onChatSignal({ kind: 'message', conversationId: 'new-friend' });
  assert.equal(page.data.aiError, '');
  assert.equal(page.data.connectionText, '');
  assert.equal(calls.toasts.length, 0);
});

test('真人发送期间切到AI，成功后回切不会恢复已经发送的草稿', async () => {
  const pending = deferred();
  const { page } = createPage({ chat: { sendMessage: () => pending.promise } });
  page.data.draft = '  发给真人  ';
  const sending = page.submitMessage();
  await selectAI(page);
  page.data.draft = '小伴的新草稿';
  pending.resolve({ message: payload.messages[0] });
  await sending;
  assert.equal(page.data.draft, '小伴的新草稿');
  await page.selectConversation({ currentTarget: { dataset: { id: 'a' } } });
  assert.equal(page.data.draft, '');
});

test('真人发送成功保留发送期间新输入的活动草稿及切走后缓存草稿', async () => {
  for (const leaveAgain of [false, true]) {
    const pending = deferred();
    const { page } = createPage({ chat: { sendMessage: () => pending.promise } });
    page.data.draft = '已发消息';
    const sending = page.submitMessage();
    await selectAI(page);
    await page.selectConversation({ currentTarget: { dataset: { id: 'a' } } });
    page.data.draft = '新写但没发';
    if (leaveAgain) await page.selectConversation({ currentTarget: { dataset: { id: AI_ID } } });
    pending.resolve({ message: payload.messages[0] });
    await sending;
    if (leaveAgain) await page.selectConversation({ currentTarget: { dataset: { id: 'a' } } });
    assert.equal(page.data.draft, '新写但没发');
  }
});

test('旧账号真人发送回调不清除新账号的同名草稿', async () => {
  const pending = deferred();
  let openid = 'me';
  const { page } = createPage({
    chat: { sendMessage: () => pending.promise },
    auth: { getSelfOpenid: () => openid, requireSession: async () => ({ user: { openid } }) },
  });
  page.data.draft = '相同的文字';
  const sending = page.submitMessage();
  await selectAI(page);
  openid = 'new-user';
  await page.onShow();
  page.data.draft = '相同的文字';
  page._drafts.a = '相同的文字';
  pending.resolve({ message: payload.messages[0] });
  await sending;
  assert.equal(page.data.draft, '相同的文字');
  assert.equal(page._drafts.a, '相同的文字');
});

test('AI隐藏时退订，后台完成只入本机记录，返回页面后恢复历史', async () => {
  const pending = deferred();
  const { page, calls, emitAI } = createPage({ ai: { sendMessage: () => pending.promise } });
  await selectAI(page);
  page.data.draft = '后台完成';
  const sending = page.submitMessage();
  const oldSubscription = calls.aiSubscriptions.at(-1).fn;
  page.onHide();
  const messages = [{ id: 'cached', text: '后台的回答', isMine: false, fromOpenid: AI_ID }];
  emitAI('me', { messages, sending: false, error: '' });
  oldSubscription({ messages, sending: false, error: '' });
  pending.resolve({ messages });
  await sending;
  assert.equal(page.data.messages.length, 0);
  assert.equal(calls.aiUnsubscribe, 1);
  await page.onShow();
  assert.equal(page.data.activeId, AI_ID);
  assert.equal(page.data.messages[0].id, 'cached');
  assert.equal(page.data.aiSending, false);
  assert.equal(calls.aiSent.length, 1);
});

test('账号切换后旧AI响应和旧订阅不得恢复原账号历史', async () => {
  const pending = deferred();
  let openid = 'me';
  const { page, calls, emitAI } = createPage({
    ai: { sendMessage: () => pending.promise },
    auth: { getSelfOpenid: () => openid, requireSession: async () => ({ user: { openid } }) },
  });
  await selectAI(page);
  page.data.draft = '旧账号提问';
  const sending = page.submitMessage();
  const oldSubscription = calls.aiSubscriptions.at(-1).fn;
  openid = 'new-user';
  await page.onShow();
  await page.selectConversation({ currentTarget: { dataset: { id: AI_ID } } });
  const messages = [{ id: 'old-account', text: '旧账号回答', fromOpenid: AI_ID, isMine: false }];
  emitAI('me', { messages, sending: false, error: '' });
  oldSubscription({ messages, sending: false, error: '' });
  pending.resolve({ messages });
  await sending;
  assert.equal(page.data.myOpenid, 'new-user');
  assert.equal(page.data.activeId, AI_ID);
  assert.equal(page.data.messages.length, 0);
  assert.equal(page.data.draft, '');
  assert.equal(page.data.aiSending, false);
});

test('通过好友入口恢复真人会话时先清空AI消息，等待真人响应期间不串屏', async () => {
  const pending = deferred();
  const { page } = createPage({ storedActiveId: 'a', chat: { listMessages: () => pending.promise } });
  page.data.activeId = AI_ID;
  page.data.isAIActive = true;
  page.data.messages = [{ id: 'ai-old', text: 'AI旧消息', fromOpenid: AI_ID }];
  page.data.draft = 'AI草稿';
  page._drafts = { a: '真人草稿' };
  const showing = page.onShow();
  await drain();
  assert.equal(page.data.activeId, 'a');
  assert.equal(page.data.isAIActive, false);
  assert.equal(page.data.messages.length, 0);
  assert.equal(page.data.draft, '真人草稿');
  pending.resolve(payload);
  await showing;
  assert.equal(page.data.messages[0].id, 'm1');
});

test('AI失败保留用户气泡，重试调用专用接口并清除失败提示', async () => {
  let context;
  const failedMessage = { id: 'failed', text: '需要重试的问题', fromOpenid: 'me', isMine: true, status: 'failed' };
  const reply = { id: 'reply', text: '重试后的回复', fromOpenid: AI_ID, isMine: false, status: 'sent' };
  context = createPage({ ai: {
    sendMessage: async () => {
      context.emitAI('me', { messages: [failedMessage], sending: false, error: '回复失败，请重试' });
      throw new Error('回复失败，请重试');
    },
    retry: async () => {
      context.emitAI('me', { messages: [{ ...failedMessage, status: 'sent' }, reply], sending: false, error: '' });
    },
  } });
  const { page, calls } = context;
  await selectAI(page);
  page.data.draft = failedMessage.text;
  await page.submitMessage();
  assert.equal(page.data.messages[0].status, 'failed');
  assert.equal(page.data.aiSending, false);
  assert.match(page.data.aiError, /回复失败/);
  await page.retryAIMessage();
  assert.deepEqual(calls.aiRetries, ['me']);
  assert.equal(calls.aiSent.length, 1);
  assert.equal(page.data.messages.length, 2);
  assert.equal(page.data.messages[0].status, 'sent');
  assert.equal(page.data.aiError, '');
});

test('AI模式禁止语音和图片调用但允许表情输入', async () => {
  const { page, calls } = createPage();
  await selectAI(page);
  page.toggleVoiceMode();
  page.openImagePicker();
  page.chooseAndSendImage(['album']);
  page.onVoiceTouchStart({ touches: [] });
  await page.uploadAndSendImage('/tmp/private.jpg');
  await page.uploadAndSendVoice('/tmp/private.mp3', 2);
  await page.playVoice({ currentTarget: { dataset: { file: 'cloud://private' } } });
  page.toggleEmojiPanel();
  page.insertEmoji({ currentTarget: { dataset: { emoji: '😊' } } });
  assert.equal(page.data.voiceMode, false);
  assert.equal(page.data.showEmoji, true);
  assert.equal(page.data.draft, '😊');
  assert.equal(calls.humanSent.length, 0);
});

test('AI界面标明身份、空态、思考中和重试，并隐藏语音图片入口', () => {
  const markup = fs.readFileSync(path.join(__dirname, '../pages/chat/index.wxml'), 'utf8');
  assert.match(markup, /AI 聊天伙伴 · 回复由 AI 生成/);
  assert.match(markup, /isAIActive && !messages.length/);
  assert.match(markup, /isAIActive && aiSending/);
  assert.match(markup, /bind:tap="retryAIMessage"/);
  assert.match(markup, /wx:if="\{\{!isAIActive\}\}"[^>]*catch:tap="toggleVoiceMode"/);
  assert.match(markup, /wx:if="\{\{!isAIActive\}\}"[^>]*catch:tap="openImagePicker"/);
});
