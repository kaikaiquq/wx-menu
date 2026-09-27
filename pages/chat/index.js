const { getSelfOpenid, requireSession } = require('../../utils/auth');
const {
  acceptFriendRequest,
  getVoicePlaybackUrl,
  listConversations,
  listFriendRequests,
  listFriends,
  listMessages,
  markConversationRead,
  openDirectChat,
  rejectFriendRequest,
  removeFriend,
  sendFriendRequest,
  sendImageMessage,
  sendMessage,
  sendVoiceMessage,
} = require('../../utils/chat');
const { resolveCloudFileUrl, resolveCloudFileUrls, uploadFileToCloud } = require('../../utils/cloud');
const { getStoredThemeClass, getThemeColors, syncTheme } = require('../../utils/theme');
const chatUnread = require('../../utils/chat-unread');
const aiChat = require('../../utils/ai-chat');
const { EMOJI_LIST } = require('./emoji-data');
const { AI_CONVERSATION_ID, AI_NAME } = aiChat;

const withAIConversation = (list = []) => {
  const conversations = list.filter((item) => item.id !== AI_CONVERSATION_ID);
  const coupleIndex = conversations.findIndex((item) => item.isCouple);
  conversations.splice(coupleIndex + 1, 0, {
    id: AI_CONVERSATION_ID, title: AI_NAME, isAI: true, unreadCount: 0,
  });
  return conversations;
};

const CONNECTION_TEXT = {
  connecting: '正在连接消息服务…',
  reconnecting: '消息连接中断，正在重连…',
  offline: '网络已断开，联网后自动恢复',
  error: '消息连接失败，请点击重试',
};

const conversationFingerprint = (list = []) =>
  list
    .map(
      (item) =>
        `${item.id}|${item.title}|${item.lastMessageText || ''}|${item.isCouple ? 1 : 0}|${item.isAI ? 1 : 0}|${item.unreadCount || 0}`,
    )
    .join(';;');

const messageFingerprint = (list = []) =>
  list
    .map(
      (item) =>
        `${item.id}|${item.text}|${item.msgType || item.type || 'text'}|${item.voiceFileId || ''}|${item.imageFileId || ''}|${item.status || ''}`,
    )
    .join(';;');

const pad2 = (value) => String(value).padStart(2, '0');

const toDate = (value) => {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === 'object') {
    if (value.$date) return toDate(value.$date);
    if (typeof value.seconds === 'number') return new Date(value.seconds * 1000);
    if (typeof value._seconds === 'number') return new Date(value._seconds * 1000);
  }
  return null;
};

/** 聊天时间：今天 HH:mm / 昨天 HH:mm / MM-DD HH:mm / YYYY-MM-DD HH:mm */
const formatMessageTime = (value) => {
  const date = toDate(value);
  if (!date) return '';
  const now = new Date();
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfThatDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDiff = Math.round((startOfToday - startOfThatDay) / 86400000);
  if (dayDiff === 0) return time;
  if (dayDiff === 1) return `昨天 ${time}`;
  if (date.getFullYear() === now.getFullYear()) {
    return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${time}`;
  }
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${time}`;
};

const resolveMsgType = (item = {}) => {
  const raw = item.msgType || item.type || '';
  if (raw === 'voice' || raw === 'image') return raw;
  if (item.voiceFileId) return 'voice';
  if (item.imageFileId) return 'image';
  return 'text';
};

const decorateMessages = (messages = []) =>
  messages.map((item) => {
    const msgType = resolveMsgType(item);
    return {
      ...item,
      imageFileId: item.imageFileId || '',
      msgType,
      timeText: formatMessageTime(item.createdAt),
      type: msgType,
      voiceDuration: Number(item.voiceDuration || 0),
      voiceFileId: item.voiceFileId || '',
    };
  });

/** 只在本地缓存里补新头像，已有 openid 绝不覆盖，避免临时链刷新导致闪烁 */
const collectAvatarMap = (avatarMap = {}, people = []) => {
  const next = { ...avatarMap };
  let changed = false;
  people.forEach((person) => {
    const openid = person?.openid || person?.peer?.openid;
    const url = person?.avatarUrl || person?.peer?.avatarUrl;
    if (openid && url && !next[openid]) {
      next[openid] = url;
      changed = true;
    }
  });
  return changed ? next : null;
};

const collectPeopleFromConversations = (conversations = []) => {
  const people = [];
  conversations.forEach((item) => {
    if (item.peer) people.push(item.peer);
    (item.members || []).forEach((member) => people.push(member));
  });
  return people;
};

Page({
  data: {
    activeId: '',
    activeTitle: '消息',
    isAIActive: false,
    aiName: AI_NAME,
    aiSending: false,
    aiError: '',
    addId: '',
    avatarMap: {},
    conversations: [],
    connectionText: '',
    draft: '',
    emojiList: EMOJI_LIST,
    filteredFriends: [],
    friends: [],
    friendKeyword: '',
    imageUrlMap: {},
    incoming: [],
    inputFocus: false,
    loading: true,
    messages: [],
    myOpenid: '',
    myPublicUserId: '',
    playingVoiceId: '',
    recording: false,
    scrollIntoView: '',
    sending: false,
    showEmoji: false,
    showFriends: false,
    showVoiceOverlay: false,
    submittingFriend: false,
    themeClass: getStoredThemeClass(),
    voiceCancelReady: false,
    voiceMode: false,
  },

  conversationFp: '',
  messageFp: '',
  conversationAvatarsReady: false,
  friendAvatarsReady: false,
  unreadUnsubscribe: null,
  recorder: null,
  recorderStartedAt: 0,
  voiceTouching: false,
  audioCtx: null,

  async onShow() {
    this.stopAIConversation();
    this._visible = true;
    const generation = this._viewGeneration = (this._viewGeneration || 0) + 1;
    this.resetMessageScroll();
    this._readCursors = {};
    this._signalBusy = false;
    this._signalPending = false;
    this._signalNeedsMessages = false;
    this._initialLoading = true;
    this.getTabBar()?.init?.();
    chatUnread.start();
    const session = await requireSession({ requireCouple: false });
    if (!session || !this.isViewCurrent(generation)) return;
    const openid = session.user?.openid || getSelfOpenid();
    const accountChanged = Boolean(this.data.myOpenid && this.data.myOpenid !== openid);
    if (accountChanged) {
      this._drafts = {};
      this.conversationFp = this.messageFp = '';
      this.conversationAvatarsReady = this.friendAvatarsReady = false;
      this._conversationSyncError = this._messageSyncError = false;
      this.setData({
        activeId: '', activeTitle: '消息', isAIActive: false, aiSending: false, aiError: '',
        conversations: [], messages: [], draft: '', avatarMap: {}, imageUrlMap: {},
        friends: [], filteredFriends: [], incoming: [], showFriends: false, sending: false,
      });
    }
    const patch = {
      myOpenid: openid || '',
      myPublicUserId: session.user.publicUserId || '',
      themeClass: syncTheme(session.user.gender),
      conversations: withAIConversation(this.data.conversations),
    };
    // 自己头像：优先已有临时链，否则换链一次
    if (openid && !this.data.avatarMap[openid]) {
      let myAvatar = session.user.avatarUrl || '';
      if (!myAvatar && String(session.user.avatarFileId || '').startsWith('cloud://')) {
        myAvatar = (await resolveCloudFileUrl(session.user.avatarFileId)) || '';
      }
      if (myAvatar) {
        patch.avatarMap = { ...this.data.avatarMap, [openid]: myAvatar };
      }
    }
    if (!this.isViewCurrent(generation)) return;
    this.setData(patch);
    const preferredId = wx.getStorageSync('couple.chat.activeId') || '';
    if (preferredId) {
      if (preferredId !== this.data.activeId) {
        this.resetMessageScroll();
        this._drafts = { ...this._drafts, [this.data.activeId]: this.data.draft };
        this.messageFp = '';
        this.setData({ messages: [], draft: this._drafts[preferredId] || '', aiSending: false, aiError: '', voiceMode: false });
      }
      this.setData({ activeId: preferredId, isAIActive: preferredId === AI_CONVERSATION_ID });
      wx.removeStorageSync('couple.chat.activeId');
    }
    if (this.data.activeId === AI_CONVERSATION_ID) this.startAIConversation();

    // 先快速出会话列表（不换头像），再后台补头像；监听不阻塞首屏
    this.startRealtime();
    await this.refreshConversations(true, {
      includeAvatars: false,
      skipMessages: false,
    });
    if (!this.isViewCurrent(generation)) return;
    this._initialLoading = false;
    if (this._signalPending) this.onChatSignal({ kind: 'state' });
    if (!this.conversationAvatarsReady) {
      this.loadAvatarsInBackground();
    }
  },

  /** 首屏后再补头像，避免 getTempFileURL 卡住进页 */
  async loadAvatarsInBackground() {
    if (this._avatarLoading) return;
    const generation = this._viewGeneration;
    this._avatarLoading = true;
    try {
      const { conversations } = await listConversations({ includeAvatars: true });
      if (!this.isViewCurrent(generation)) return;
      const avatarMap = collectAvatarMap(
        this.data.avatarMap,
        collectPeopleFromConversations(conversations),
      );
      this.conversationAvatarsReady = true;
      if (avatarMap) this.setData({ avatarMap });
    } catch (error) {
      console.warn('loadAvatarsInBackground failed', error);
    } finally {
      this._avatarLoading = false;
    }
  },

  onHide() {
    this.stopRealtime();
    this.stopVoicePlayback();
    this.cancelRecording(true);
  },

  onUnload() {
    this.stopRealtime();
    this.stopVoicePlayback();
    this.cancelRecording(true);
  },

  isViewCurrent(generation) {
    return this._visible && this._viewGeneration === generation;
  },

  resetMessageScroll() {
    this._messageRenderVersion = (this._messageRenderVersion || 0) + 1;
    this._pendingMessageScroll = null;
    if (this.data.scrollIntoView) this.setData({ scrollIntoView: '' });
  },

  renderConversationMessages(patch, conversationId, generation, scrollToBottom, afterRender) {
    const openid = this.data.myOpenid || getSelfOpenid();
    const pending = this._pendingMessageScroll;
    const shouldScroll = scrollToBottom || Boolean(pending && pending.generation === generation &&
      pending.openid === openid && pending.conversationId === conversationId);
    const renderVersion = this._messageRenderVersion = (this._messageRenderVersion || 0) + 1;
    this._pendingMessageScroll = shouldScroll ? { generation, openid, conversationId } : null;
    const isCurrent = () => this.isViewCurrent(generation) && !this.data.showFriends &&
      this.data.activeId === conversationId && this.data.myOpenid === openid && getSelfOpenid() === openid &&
      this._messageRenderVersion === renderVersion;
    // 先提交消息与空锚点，等视图完成布局后再定位，重复的底部目标也能重新生效。
    this.setData({ ...patch, ...(shouldScroll ? { scrollIntoView: '' } : {}) }, () => {
      if (!isCurrent()) return;
      if (shouldScroll) {
        wx.nextTick(() => {
          if (!isCurrent()) return;
          this._pendingMessageScroll = null;
          this.setData({ scrollIntoView: 'message-bottom' });
        });
      }
      if (afterRender) return afterRender();
    });
  },

  syncActiveConversation() {
    chatUnread.setActiveConversation(this._visible && !this.data.showFriends && this.data.activeId !== AI_CONVERSATION_ID ? this.data.activeId : '');
  },

  updateConnectionStatus(status) {
    const connectionText = this.data.activeId === AI_CONVERSATION_ID ? '' : CONNECTION_TEXT[status] ||
      (this._conversationSyncError || this._messageSyncError ? '消息同步失败，点击重试' : '');
    if (connectionText !== this.data.connectionText) this.setData({ connectionText });
  },

  syncUnreadSummary(byId = {}) {
    const conversations = this.data.conversations.map((item) => ({
      ...item,
      unreadCount: item.isAI ? 0 : Math.max(0, Number(byId[item.id] || 0)),
    }));
    const nextFp = conversationFingerprint(conversations);
    if (nextFp === this.conversationFp) return;
    this.conversationFp = nextFp;
    this.setData({ conversations });
  },

  startRealtime() {
    if (this.unreadUnsubscribe) this.unreadUnsubscribe();
    // 全局 watch 负责连接；页面仅消费推送，不创建轮询或第二条连接。
    this.unreadUnsubscribe = chatUnread.subscribe((event) => {
      if (!event || !this._visible) return;
      if (event.type === 'signal' && (event.initial || event.kind === 'message')) this.onChatSignal(event);
      if (event.type === 'summary') this.syncUnreadSummary(event.byId);
      if (event.type === 'status') this.updateConnectionStatus(event.status);
    });
    this.updateConnectionStatus(chatUnread.getState().status);
    this.syncActiveConversation();
    chatUnread.start();
  },

  stopRealtime() {
    this.stopAIConversation();
    this._visible = false;
    this._viewGeneration = (this._viewGeneration || 0) + 1;
    this.resetMessageScroll();
    this._signalPending = false;
    this._signalNeedsMessages = false;
    chatUnread.setActiveConversation('');
    if (this.unreadUnsubscribe) {
      this.unreadUnsubscribe();
      this.unreadUnsubscribe = null;
    }
  },

  retryConnection() {
    if (this.data.activeId === AI_CONVERSATION_ID) return this.retryAIMessage();
    chatUnread.retry();
    this.onChatSignal({ kind: 'message' });
  },

  async onChatSignal(event = {}) {
    if (!this._visible) return;
    this._signalPending = true;
    this._signalNeedsMessages = this._signalNeedsMessages || event.initial || event.kind !== 'state';
    if (this._signalBusy || this._initialLoading) return;
    this._signalBusy = true;
    const generation = this._viewGeneration;
    try {
      while (this._signalPending && this.isViewCurrent(generation)) {
        const loadMessages = this._signalNeedsMessages;
        this._signalPending = false;
        this._signalNeedsMessages = false;
        const tasks = [this.refreshConversations(false, { includeAvatars: false, skipMessages: true })];
        // 信标可能合并多个会话的变化，始终检查当前会话，不能只信最后的 conversationId。
        if (loadMessages && this.data.activeId && this.data.activeId !== AI_CONVERSATION_ID && !this.data.showFriends) {
          tasks.push(this.loadMessages(this.data.activeId, true));
        }
        await Promise.all(tasks);
      }
    } finally {
      if (this.isViewCurrent(generation)) this._signalBusy = false;
    }
  },

  async refreshConversations(selectDefault, options = {}) {
    const generation = this._viewGeneration;
    const request = this._conversationRequest = (this._conversationRequest || 0) + 1;
    const includeAvatars = options.includeAvatars === true;
    try {
      const result = await listConversations({ includeAvatars });
      if (!this.isViewCurrent(generation) || request !== this._conversationRequest) return;
      this._conversationSyncError = false;
      this.updateConnectionStatus(chatUnread.getState().status);
      const byId = chatUnread.getState().byId || {};
      const humanConversations = result.conversations.map((item) => ({
        ...item,
        unreadCount: Math.max(0, Number(byId[item.id] || 0)),
      }));
      const conversations = withAIConversation(humanConversations);
      let activeId = this.data.activeId;
      if (!activeId || (selectDefault && !conversations.some((item) => item.id === activeId))) {
        activeId = humanConversations.find((item) => item.isCouple)?.id || humanConversations[0]?.id || AI_CONVERSATION_ID;
      }
      const activeChanged = activeId !== this.data.activeId;
      const active = conversations.find((item) => item.id === activeId);
      const nextFp = conversationFingerprint(conversations);
      const patch = {};
      if (activeChanged) {
        this.resetMessageScroll();
        this.stopAIConversation();
        this._drafts = { ...this._drafts, [this.data.activeId]: this.data.draft };
        this.messageFp = '';
        Object.assign(patch, { messages: [], draft: this._drafts[activeId] || '', aiSending: false, aiError: '', voiceMode: false });
      }
      if (this.data.loading) patch.loading = false;

      if (includeAvatars) {
        const avatarMap = collectAvatarMap(
          this.data.avatarMap,
          collectPeopleFromConversations(conversations),
        );
        if (avatarMap) patch.avatarMap = avatarMap;
        this.conversationAvatarsReady = true;
      }

      if (nextFp !== this.conversationFp) {
        this.conversationFp = nextFp;
        patch.conversations = conversations.map((item) => ({
          ...item,
          unreadCount: Math.max(0, Number(item.unreadCount || 0)),
          peer: item.peer
            ? {
                ...item.peer,
                avatarUrl: '',
              }
            : null,
          members: (item.members || []).map((member) => ({
            ...member,
            avatarUrl: '',
          })),
        }));
      }
      if (activeId !== this.data.activeId) patch.activeId = activeId;
      patch.isAIActive = activeId === AI_CONVERSATION_ID;
      if ((active?.title || '消息') !== this.data.activeTitle) {
        patch.activeTitle = active?.title || '消息';
      }
      if (Object.keys(patch).length) this.setData(patch);

      this.syncActiveConversation();
      this.updateConnectionStatus(chatUnread.getState().status);

      // 消息单独拉，不堵在同一条关键路径的头像逻辑里
      if ((!options.skipMessages || activeChanged) && activeId && !this.data.showFriends) {
        await this.loadMessages(activeId, !selectDefault);
      }
    } catch (error) {
      if (!this.isViewCurrent(generation) || request !== this._conversationRequest) return;
      this._conversationSyncError = true;
      this.updateConnectionStatus(chatUnread.getState().status);
      if (this.data.loading) this.setData({ loading: false });
      if (!this.data.activeId && this.data.myOpenid) {
        this.setData({ activeId: AI_CONVERSATION_ID, activeTitle: AI_NAME, isAIActive: true });
        this.syncActiveConversation();
        this.startAIConversation();
      }
      if (selectDefault && this.data.activeId !== AI_CONVERSATION_ID) wx.showToast({ title: error.message || '会话加载失败', icon: 'none' });
    }
  },

  async loadMessages(conversationId, silent) {
    if (!this._visible || this.data.showFriends) return;
    if (conversationId === AI_CONVERSATION_ID) {
      if (this.data.activeId === conversationId) this.startAIConversation();
      return;
    }
    const generation = this._viewGeneration;
    const request = this._messageRequest = (this._messageRequest || 0) + 1;
    const isCurrent = () => this.isViewCurrent(generation) && !this.data.showFriends &&
      this.data.activeId === conversationId && request === this._messageRequest;
    try {
      const { messages, readCursor } = await listMessages(conversationId, 40);
      if (!isCurrent()) return;
      this._messageSyncError = false;
      this.updateConnectionStatus(chatUnread.getState().status);
      const decorated = decorateMessages(messages);
      const nextFp = messageFingerprint(decorated);
      const lastMessage = decorated[decorated.length - 1];
      const previousLast = this.data.messages[this.data.messages.length - 1];
      const lastTime = toDate(lastMessage?.createdAt)?.getTime();
      const previousTime = toDate(previousLast?.createdAt)?.getTime();
      const hasNewTail = Boolean(lastMessage && !this.data.messages.some((item) => item.id === lastMessage.id) &&
        (!Number.isFinite(lastTime) || !Number.isFinite(previousTime) || lastTime >= previousTime));
      const shouldScroll = decorated.length > 0 && (!silent || hasNewTail);
      const acknowledge = async () => {
        if (!readCursor || !isCurrent()) return;
        const cursorKey = JSON.stringify(readCursor);
        this._readCursors = this._readCursors || {};
        if (this._readCursors[conversationId] === cursorKey) return;
        try {
          const result = await markConversationRead(conversationId, readCursor);
          if (!isCurrent() || !result.applied) return;
          this._readCursors[conversationId] = cursorKey;
          // 角标由全局摘要同步；旧已读响应不能覆盖稍后到达的新消息计数。
        } catch (error) {
          console.warn('mark conversation read failed', error?.message || error);
        }
      };
      // 仅在视图渲染完成且用户仍停留于本会话时提交已读游标。
      const patch = nextFp === this.messageFp ? {} : { messages: decorated };
      this.messageFp = nextFp;
      this.renderConversationMessages(patch, conversationId, generation, shouldScroll, acknowledge);
      this.resolveMessageImages(decorated);
    } catch (error) {
      if (!isCurrent()) return;
      this._messageSyncError = true;
      this.updateConnectionStatus(chatUnread.getState().status);
      if (!silent) wx.showToast({ title: error.message || '消息加载失败', icon: 'none' });
    }
  },

  async resolveMessageImages(messages = []) {
    const generation = this._viewGeneration;
    const ids = messages
      .filter((item) => (item.msgType === 'image' || item.type === 'image') && item.imageFileId)
      .map((item) => item.imageFileId)
      .filter((id) => id.startsWith('cloud://') && !this.data.imageUrlMap[id]);
    if (!ids.length) return;
    const map = await resolveCloudFileUrls(ids);
    if (!this.isViewCurrent(generation) || !Object.keys(map).length) return;
    this.setData({
      imageUrlMap: { ...this.data.imageUrlMap, ...map },
    });
  },

  isAIViewCurrent(generation, openid) {
    return this.isViewCurrent(generation) && !this.data.showFriends &&
      this.data.activeId === AI_CONVERSATION_ID && this.data.myOpenid === openid && getSelfOpenid() === openid;
  },

  stopAIConversation() {
    this._aiSubscriptionVersion = (this._aiSubscriptionVersion || 0) + 1;
    if (this._aiUnsubscribe) this._aiUnsubscribe();
    this._aiUnsubscribe = null;
  },

  renderAIState(state) {
    const messages = decorateMessages((state.messages || []).map((item) => ({
      ...item, msgType: 'text', type: 'text', fromNickname: item.isMine ? '我' : AI_NAME,
    })));
    this.messageFp = messageFingerprint(messages);
    this.setData({
      messages, isAIActive: true, activeTitle: AI_NAME, voiceMode: false,
      aiSending: Boolean(state.sending), aiError: state.error || '', connectionText: '',
    });
    const generation = this._viewGeneration;
    const openid = this.data.myOpenid;
    this.setData({ scrollIntoView: '' });
    wx.nextTick(() => {
      if (this.isAIViewCurrent(generation, openid)) {
        this.setData({ scrollIntoView: state.sending ? 'ai-thinking' : `msg-${Math.max(messages.length - 1, 0)}` });
      }
    });
  },

  startAIConversation() {
    this.stopAIConversation();
    const generation = this._viewGeneration;
    const openid = this.data.myOpenid;
    if (!openid || !this.isAIViewCurrent(generation, openid)) return;
    const subscriptionVersion = this._aiSubscriptionVersion;
    this._aiUnsubscribe = aiChat.subscribe(openid, (state) => {
      if (subscriptionVersion === this._aiSubscriptionVersion && this.isAIViewCurrent(generation, openid)) {
        this.renderAIState(state);
      }
    });
    this.renderAIState({ ...aiChat.getState(openid), messages: aiChat.getMessages(openid) });
  },

  async sendAIMessage(retry = false) {
    const generation = this._viewGeneration;
    const openid = this.data.myOpenid;
    if (!openid || !this.isAIViewCurrent(generation, openid) || this.data.aiSending || aiChat.getState(openid).sending) return;
    const text = String(this.data.draft || '').trim().slice(0, 500);
    if (!retry && !text) return;
    this.setData({ aiSending: true, aiError: '', showEmoji: false });
    if (!retry) {
      this._drafts = { ...this._drafts, [AI_CONVERSATION_ID]: '' };
      this.setData({ draft: '' });
    }
    let failure = '';
    try {
      if (retry) await aiChat.retry(openid);
      else await aiChat.sendMessage(openid, text);
    } catch (error) {
      failure = error.message || '小伴暂时没有回复，请重试';
    } finally {
      if (this.isAIViewCurrent(generation, openid)) {
        const state = aiChat.getState(openid);
        this.renderAIState({ ...state, error: state.error || failure, messages: aiChat.getMessages(openid) });
      }
    }
  },

  retryAIMessage() {
    return this.sendAIMessage(true);
  },

  selectConversation(event) {
    const id = event.currentTarget.dataset.id;
    const active = this.data.conversations.find((item) => item.id === id);
    if (!id || id === this.data.activeId) return;
    this.resetMessageScroll();
    this.stopVoicePlayback();
    this.cancelRecording(true);
    this.stopAIConversation();
    this._drafts = { ...this._drafts, [this.data.activeId]: this.data.draft };
    this._messageRequest = (this._messageRequest || 0) + 1;
    this.messageFp = '';
    this.setData({
      activeId: id,
      activeTitle: active?.title || '消息',
      isAIActive: id === AI_CONVERSATION_ID,
      aiSending: false,
      aiError: '',
      draft: this._drafts[id] || '',
      inputFocus: false,
      messages: [],
      voiceMode: false,
      showEmoji: false,
      showFriends: false,
    });
    this.syncActiveConversation();
    this.updateConnectionStatus(chatUnread.getState().status);
    return this.loadMessages(id, false);
  },

  updateDraft(event) {
    this.setData({ draft: event.detail.value });
  },

  onInputFocus() {
    // 点输入框：收起表情，只留键盘
    this.setData({
      inputFocus: true,
      showEmoji: false,
      voiceMode: false,
    });
  },

  onInputBlur() {
    this.setData({ inputFocus: false });
  },

  toggleVoiceMode() {
    if (this.data.activeId === AI_CONVERSATION_ID) return;
    const generation = this._viewGeneration;
    const conversationId = this.data.activeId;
    const voiceMode = !this.data.voiceMode;
    if (voiceMode) {
      // 进入语音模式前先申请权限，避免按住说话时异步授权导致 start/stop 竞态
      this.ensureRecordAuth().then((ok) => {
        if (!ok || !this.isViewCurrent(generation) || this.data.activeId !== conversationId) return;
        this.setData({
          voiceMode: true,
          showEmoji: false,
          inputFocus: false,
        });
      });
      return;
    }
    this.cancelRecording(true);
    this.setData({
      voiceMode: false,
      showEmoji: false,
      inputFocus: false,
    });
  },

  toggleEmojiPanel() {
    if (this.data.showEmoji) {
      // 表情已开 → 关掉，回到可输入状态但不强行弹键盘
      this.setData({ showEmoji: false });
      return;
    }
    // 输入/键盘模式 → 切到表情：先失焦收键盘，再出表情面板
    this.setData({
      inputFocus: false,
      voiceMode: false,
      showEmoji: true,
    });
  },

  insertEmoji(event) {
    const emoji = event.currentTarget.dataset.emoji || '';
    if (!emoji) return;
    const draft = `${this.data.draft || ''}${emoji}`.slice(0, 500);
    this.setData({ draft });
  },

  openImagePicker() {
    if (!this.data.activeId || this.data.activeId === AI_CONVERSATION_ID || this.data.sending) return;
    this.dismissComposerExtras();
    wx.showActionSheet({
      itemList: ['拍照', '从相册选择'],
      success: ({ tapIndex }) => {
        const sourceType = tapIndex === 0 ? ['camera'] : ['album'];
        this.chooseAndSendImage(sourceType);
      },
    });
  },

  chooseAndSendImage(sourceType) {
    if (this.data.activeId === AI_CONVERSATION_ID) return;
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType,
      sizeType: ['compressed'],
      success: async ({ tempFiles }) => {
        const file = tempFiles && tempFiles[0];
        if (!file?.tempFilePath) return;
        await this.uploadAndSendImage(file.tempFilePath);
      },
      fail: (error) => {
        if (String(error?.errMsg || '').includes('cancel')) return;
        wx.showToast({ title: '选择图片失败', icon: 'none' });
      },
    });
  },

  async uploadAndSendImage(tempFilePath) {
    if (!this.data.activeId || this.data.activeId === AI_CONVERSATION_ID || this.data.sending) return;
    const conversationId = this.data.activeId;
    const generation = this._viewGeneration;
    this.setData({ sending: true });
    wx.showLoading({ title: '发送图片中' });
    try {
      const extension = (tempFilePath.split('.').pop() || 'jpg').toLowerCase().split('?')[0];
      const safeExt = /^[a-z0-9]{1,5}$/.test(extension) ? extension : 'jpg';
      const cloudPath = `chat/image/${Date.now()}-${Math.random().toString(36).slice(2)}.${safeExt}`;
      const fileID = await uploadFileToCloud(tempFilePath, cloudPath);
      const { message } = await sendImageMessage(conversationId, { imageFileId: fileID });
      const decorated = decorateMessages([
        {
          ...message,
          imageFileId: message.imageFileId || fileID,
          msgType: 'image',
          type: 'image',
          imageUrl: tempFilePath,
        },
      ])[0];
      this.showSentMessage(conversationId, decorated, generation, {
        imageUrlMap: {
          ...this.data.imageUrlMap,
          [fileID]: tempFilePath,
        },
      });
      wx.hideLoading();
    } catch (error) {
      wx.hideLoading();
      this.setData({ sending: false });
      wx.showToast({ title: error.message || '图片发送失败', icon: 'none' });
    }
  },

  previewChatImage(event) {
    const messageId = event.currentTarget.dataset.id || '';
    const fileId = event.currentTarget.dataset.fileId || '';
    // 勿用 data-url 传临时 https：属性里的 & 会被截断，current 对不上 urls，预览会先落到错误图再滑过去
    const entries = this.data.messages
      .filter((item) => (item.msgType === 'image' || item.type === 'image') && item.imageFileId)
      .map((item) => ({
        id: item.id,
        fileId: item.imageFileId,
        url: item.imageUrl || this.data.imageUrlMap[item.imageFileId] || item.imageFileId,
      }))
      .filter((item) => item.url);
    if (!entries.length) return;

    let index = entries.findIndex((item) => messageId && item.id === messageId);
    if (index < 0) {
      index = entries.findIndex((item) => fileId && item.fileId === fileId);
    }
    if (index < 0) index = 0;

    const urls = entries.map((item) => item.url);
    wx.previewImage({
      current: urls[index],
      urls,
    });
  },

  /** 点空白：键盘和表情都收起 */
  dismissComposerExtras() {
    if (!this.data.showEmoji && !this.data.inputFocus) return;
    this.setData({
      showEmoji: false,
      inputFocus: false,
    });
  },

  hideVoiceOverlay() {
    if (!this.data.showVoiceOverlay && !this.data.voiceCancelReady && !this.data.recording) {
      return;
    }
    this.setData({
      showVoiceOverlay: false,
      voiceCancelReady: false,
      recording: false,
    });
  },

  ensureRecorder() {
    if (this.recorder) return this.recorder;
    const recorder = wx.getRecorderManager();
    recorder.onStart(() => {
      this._recorderState = 'recording';
      this.recorderStartedAt = Date.now();
      this.setData({
        recording: true,
        showVoiceOverlay: true,
      });
      // 手指已松开：开始后立刻停，避免 stop-when-idle 报错
      if (this._pendingStop || !this.voiceTouching) {
        this._pendingStop = false;
        this._recorderState = 'stopping';
        try {
          recorder.stop();
        } catch (error) {
          this._recorderState = 'idle';
          this.hideVoiceOverlay();
        }
      }
    });
    recorder.onStop(async (res) => {
      const cancelled = this._voiceCancelled;
      this._voiceCancelled = false;
      this.voiceTouching = false;
      this._pendingStop = false;
      this._recorderState = 'idle';
      this.hideVoiceOverlay();
      if (cancelled) return;

      const durationMs = Number(res.duration) || 0;
      if (durationMs < 800) {
        wx.showToast({ title: '说话时间太短', icon: 'none' });
        return;
      }
      if (!res.tempFilePath) {
        wx.showToast({ title: '录音失败', icon: 'none' });
        return;
      }
      await this.uploadAndSendVoice(
        res.tempFilePath,
        Math.max(1, Math.round(durationMs / 1000)),
      );
    });
    recorder.onError((error) => {
      const msg = String(error?.errMsg || error?.message || '');
      this.voiceTouching = false;
      this._pendingStop = false;
      this._recorderState = 'idle';
      this.hideVoiceOverlay();
      if (/recording or paused|is recording|not start/i.test(msg)) {
        console.warn('recorder benign error', msg);
        return;
      }
      wx.showToast({ title: '录音失败，请重试', icon: 'none' });
    });
    this.recorder = recorder;
    this._recorderState = 'idle';
    return recorder;
  },

  async ensureRecordAuth() {
    const setting = await new Promise((resolve) => {
      wx.getSetting({ success: resolve, fail: () => resolve({}) });
    });
    if (setting.authSetting && setting.authSetting['scope.record']) return true;
    try {
      await new Promise((resolve, reject) => {
        wx.authorize({
          scope: 'scope.record',
          success: resolve,
          fail: reject,
        });
      });
      return true;
    } catch (error) {
      wx.showModal({
        title: '需要麦克风权限',
        content: '请在设置中开启录音权限，才能发送语音消息',
        confirmText: '去设置',
        success: ({ confirm }) => {
          if (confirm) wx.openSetting({});
        },
      });
      return false;
    }
  },

  onVoiceTouchStart(event) {
    if (!this.data.activeId || this.data.activeId === AI_CONVERSATION_ID || this.data.sending) return;
    if (this._recorderState && this._recorderState !== 'idle') return;

    const touch = (event.touches && event.touches[0]) || {};
    this._touchStartY = Number(touch.clientY || 0);
    this.stopVoicePlayback();
    this._voiceCancelled = false;
    this._pendingStop = false;
    this.voiceTouching = true;
    this._recorderState = 'starting';
    this.setData({
      showVoiceOverlay: true,
      voiceCancelReady: false,
      recording: true,
    });
    try {
      this.ensureRecorder().start({
        duration: 60000,
        format: 'mp3',
        sampleRate: 16000,
        numberOfChannels: 1,
        encodeBitRate: 48000,
      });
    } catch (error) {
      this._recorderState = 'idle';
      this.voiceTouching = false;
      this.hideVoiceOverlay();
      console.warn('recorder start failed', error);
    }
  },

  onVoiceTouchMove(event) {
    if (!this.voiceTouching) return;
    const touch = (event.touches && event.touches[0]) || {};
    const currentY = Number(touch.clientY || 0);
    if (!this._touchStartY || !currentY) return;
    // 上滑超过约 80px 进入取消态
    const cancelReady = this._touchStartY - currentY > 80;
    if (cancelReady !== this.data.voiceCancelReady) {
      this.setData({ voiceCancelReady: cancelReady });
    }
  },

  onVoiceTouchEnd() {
    const shouldCancel = this.data.voiceCancelReady;
    // 尚未真正开始：标记待停止，等 onStart 里再 stop
    if (this._recorderState === 'starting') {
      this.voiceTouching = false;
      if (shouldCancel) {
        this._voiceCancelled = true;
        this._pendingStop = true;
        this.hideVoiceOverlay();
        wx.showToast({ title: '已取消', icon: 'none' });
        return;
      }
      this._pendingStop = true;
      return;
    }
    if (this._recorderState !== 'recording') {
      this.voiceTouching = false;
      this.hideVoiceOverlay();
      return;
    }

    this.voiceTouching = false;
    if (shouldCancel) {
      this._voiceCancelled = true;
      this._recorderState = 'stopping';
      this.hideVoiceOverlay();
      try {
        this.ensureRecorder().stop();
      } catch (error) {
        this._recorderState = 'idle';
      }
      wx.showToast({ title: '已取消', icon: 'none' });
      return;
    }

    this._recorderState = 'stopping';
    try {
      this.ensureRecorder().stop();
    } catch (error) {
      this._recorderState = 'idle';
      this.hideVoiceOverlay();
    }
  },

  onVoiceTouchCancel() {
    this.cancelRecording();
  },

  cancelRecording() {
    this._voiceCancelled = true;
    this.voiceTouching = false;
    this.setData({ voiceCancelReady: false });
    if (this._recorderState === 'starting') {
      this._pendingStop = true;
      this.hideVoiceOverlay();
      return;
    }
    if (this._recorderState === 'recording') {
      this._recorderState = 'stopping';
      try {
        this.ensureRecorder().stop();
      } catch (error) {
        this._recorderState = 'idle';
      }
    }
    this.hideVoiceOverlay();
  },

  async uploadAndSendVoice(tempFilePath, voiceDuration) {
    if (!this.data.activeId || this.data.activeId === AI_CONVERSATION_ID || this.data.sending) return;
    const conversationId = this.data.activeId;
    const generation = this._viewGeneration;
    const openid = this.data.myOpenid;
    const isSameAccount = () => Boolean(openid) && this.data.myOpenid === openid && getSelfOpenid() === openid;
    if (!isSameAccount()) return;
    this.setData({ sending: true });
    wx.showLoading({ title: '发送语音中' });
    try {
      const cloudPath = `chat/voice/${encodeURIComponent(conversationId)}/${encodeURIComponent(openid)}/${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`;
      const fileID = await uploadFileToCloud(tempFilePath, cloudPath);
      if (!isSameAccount()) return;
      const { message } = await sendVoiceMessage(conversationId, {
        voiceDuration,
        voiceFileId: fileID,
      });
      if (!isSameAccount()) return;
      const decorated = decorateMessages([
        {
          ...message,
          msgType: 'voice',
          type: 'voice',
          voiceDuration,
          voiceFileId: message.voiceFileId || fileID,
        },
      ])[0];
      this.showSentMessage(conversationId, decorated, generation);
    } catch (error) {
      if (!isSameAccount()) return;
      this.setData({ sending: false });
      wx.showToast({ title: error.message || '语音发送失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  stopVoicePlayback() {
    this._voicePlaybackRequest = (this._voicePlaybackRequest || 0) + 1;
    this._pendingVoiceId = '';
    const audio = this.audioCtx;
    this.audioCtx = null;
    if (audio) {
      try { audio.stop(); } catch (error) { /* Already stopped. */ }
      try { audio.destroy(); } catch (error) { /* Already released. */ }
    }
    if (this.data.playingVoiceId) this.setData({ playingVoiceId: '' });
  },

  async playVoice(event) {
    const conversationId = this.data.activeId;
    if (!conversationId || conversationId === AI_CONVERSATION_ID) return;
    const { id } = event.currentTarget.dataset;
    const message = this.data.messages.find((item) => item.id === id && resolveMsgType(item) === 'voice');
    if (!message?.voiceFileId) return;
    if (this.data.playingVoiceId === id || this._pendingVoiceId === id) {
      this.stopVoicePlayback();
      return;
    }
    this.stopVoicePlayback();
    const request = this._voicePlaybackRequest;
    const generation = this._viewGeneration;
    const openid = this.data.myOpenid;
    const isCurrent = () => this._voicePlaybackRequest === request && this.isViewCurrent(generation) &&
      this.data.activeId === conversationId && !this.data.showFriends &&
      Boolean(openid) && this.data.myOpenid === openid && getSelfOpenid() === openid;
    if (!isCurrent()) return;
    this._pendingVoiceId = id;
    try {
      // 由云函数核验会话成员并换取短期链接；客户端没有读取对方私有文件的权限。
      const { url } = await getVoicePlaybackUrl(conversationId, id);
      if (!isCurrent()) return;
      if (typeof url !== 'string' || !/^https:\/\//i.test(url)) throw new Error('Missing playback URL');
      const audio = wx.createInnerAudioContext();
      this.audioCtx = audio;
      const finish = (failed) => {
        if (this.audioCtx !== audio) return;
        const current = isCurrent();
        this.stopVoicePlayback();
        if (failed && current) wx.showToast({ title: '播放失败，请重试', icon: 'none' });
      };
      audio.onEnded(() => finish(false));
      audio.onError(() => finish(true));
      audio.src = url;
      this.setData({ playingVoiceId: id });
      audio.play();
    } catch (error) {
      if (!isCurrent()) return;
      this.stopVoicePlayback();
      wx.showToast({ title: '语音暂时无法播放，请重试', icon: 'none' });
    } finally {
      if (this._voicePlaybackRequest === request) this._pendingVoiceId = '';
    }
  },

  async submitMessage() {
    if (this.data.activeId === AI_CONVERSATION_ID) return this.sendAIMessage();
    const draft = this.data.draft || '';
    const text = draft.trim();
    if (!text || !this.data.activeId || this.data.sending || this.data.voiceMode) return;
    const conversationId = this.data.activeId;
    const generation = this._viewGeneration;
    const openid = this.data.myOpenid || getSelfOpenid();
    const isSameAccount = () => this.data.myOpenid === openid && getSelfOpenid() === openid;
    this.setData({ sending: true });
    try {
      const { message } = await sendMessage(conversationId, text);
      if (!isSameAccount()) return;
      // 切走时缓存的草稿也需清理；用户在发送期间新写的内容必须保留。
      if (this._drafts?.[conversationId] === draft) this._drafts[conversationId] = '';
      const decorated = decorateMessages([message])[0];
      this.showSentMessage(conversationId, decorated, generation, this.data.draft === draft ? { draft: '' } : {});
    } catch (error) {
      if (!isSameAccount()) return;
      this.setData({ sending: false });
      wx.showToast({ title: error.message || '发送失败', icon: 'none' });
    }
  },

  showSentMessage(conversationId, message, generation, extraPatch = {}) {
    this.setData({ sending: false });
    if (!this.isViewCurrent(generation)) return;
    if (this.data.activeId === conversationId) {
      // 推送回拉可能先于发送响应到达，按 ID 去重，且不把 A 会话的消息插入 B。
      const messages = this.data.messages.some((item) => item.id === message.id)
        ? this.data.messages : [...this.data.messages, message];
      this._messageRequest = (this._messageRequest || 0) + 1;
      this.messageFp = messageFingerprint(messages);
      this.renderConversationMessages({ ...extraPatch, messages, showEmoji: false }, conversationId, generation, true);
    }
    this.onChatSignal({ kind: 'message' });
  },

  async openFriendsPanel() {
    this.stopAIConversation();
    this.setData({
      showFriends: true,
      showEmoji: false,
      inputFocus: false,
    });
    this.syncActiveConversation();
    await this.refreshFriendsPanel();
  },

  closeFriendsPanel() {
    if (!this.data.showFriends) return;
    this.setData({ showFriends: false });
    this.syncActiveConversation();
    if (this.data.activeId === AI_CONVERSATION_ID) this.startAIConversation();
    else this.onChatSignal({ kind: 'message' });
  },

  async refreshFriendsPanel() {
    try {
      const includeAvatars = !this.friendAvatarsReady;
      const [{ friends }, { incoming }] = await Promise.all([
        listFriends({ includeAvatars }),
        listFriendRequests(),
      ]);
      const patch = { friends, incoming };
      if (includeAvatars) {
        const people = [
          ...friends,
          ...incoming.map((item) => item.from).filter(Boolean),
        ];
        const avatarMap = collectAvatarMap(this.data.avatarMap, people);
        if (avatarMap) patch.avatarMap = avatarMap;
        this.friendAvatarsReady = true;
      }
      const keyword = (this.data.friendKeyword || '').trim().toLowerCase();
      const source = friends;
      patch.filteredFriends = keyword
        ? source.filter(
            (item) =>
              String(item.nickname || '').toLowerCase().includes(keyword) ||
              String(item.publicUserId || '').toLowerCase().includes(keyword),
          )
        : source;
      this.setData(patch);
    } catch (error) {
      wx.showToast({ title: error.message || '好友加载失败', icon: 'none' });
    }
  },

  updateFriendKeyword(event) {
    const friendKeyword = event.detail.value;
    const keyword = friendKeyword.trim().toLowerCase();
    const filteredFriends = keyword
      ? this.data.friends.filter(
          (item) =>
            String(item.nickname || '').toLowerCase().includes(keyword) ||
            String(item.publicUserId || '').toLowerCase().includes(keyword),
        )
      : this.data.friends;
    this.setData({ filteredFriends, friendKeyword });
  },

  updateAddId(event) {
    this.setData({ addId: event.detail.value.trim() });
  },

  copyMyId() {
    const id = this.data.myPublicUserId;
    if (!id) return;
    wx.setClipboardData({
      data: id,
      success: () => wx.showToast({ title: '已复制我的 ID', icon: 'none' }),
    });
  },

  async submitAddFriend() {
    const publicUserId = (this.data.addId || '').trim();
    if (!publicUserId || this.data.submittingFriend) return;
    this.setData({ submittingFriend: true });
    try {
      await sendFriendRequest(publicUserId);
      this.setData({ addId: '', submittingFriend: false });
      wx.showToast({ title: '已发送申请', icon: 'success' });
      this.refreshFriendsPanel();
    } catch (error) {
      this.setData({ submittingFriend: false });
      wx.showToast({ title: error.message || '添加失败', icon: 'none' });
    }
  },

  async acceptRequest(event) {
    try {
      await acceptFriendRequest(event.currentTarget.dataset.id);
      wx.showToast({ title: '已添加好友', icon: 'success' });
      this.refreshFriendsPanel();
    } catch (error) {
      wx.showToast({ title: error.message || '操作失败', icon: 'none' });
    }
  },

  async rejectRequest(event) {
    try {
      await rejectFriendRequest(event.currentTarget.dataset.id);
      this.refreshFriendsPanel();
    } catch (error) {
      wx.showToast({ title: error.message || '操作失败', icon: 'none' });
    }
  },

  async chatFriend(event) {
    const friendOpenid = event.currentTarget.dataset.openid;
    const generation = this._viewGeneration;
    try {
      const { conversationId } = await openDirectChat(friendOpenid);
      if (!this.isViewCurrent(generation)) return;
      this.resetMessageScroll();
      this.stopAIConversation();
      this._drafts = { ...this._drafts, [this.data.activeId]: this.data.draft };
      this.setData({
        activeId: conversationId, isAIActive: false, aiSending: false, aiError: '',
        messages: [], draft: this._drafts[conversationId] || '', showFriends: false,
      });
      this.syncActiveConversation();
      this.conversationFp = '';
      this.messageFp = '';
      await this.refreshConversations(true, { includeAvatars: !this.conversationAvatarsReady });
    } catch (error) {
      wx.showToast({ title: error.message || '打开失败', icon: 'none' });
    }
  },

  removeFriendConfirm(event) {
    const { openid, name } = event.currentTarget.dataset;
    wx.showModal({
      title: '删除好友？',
      content: `确定删除「${name || '好友'}」吗？`,
      confirmColor: getThemeColors().primary,
      success: async ({ confirm }) => {
        if (!confirm) return;
        try {
          await removeFriend(openid);
          this.refreshFriendsPanel();
        } catch (error) {
          wx.showToast({ title: error.message || '删除失败', icon: 'none' });
        }
      },
    });
  },

  openCreateGroup() {
    wx.navigateTo({ url: '/pages/chat/group' });
  },

  noop() {},
});
