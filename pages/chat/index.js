const { getSelfOpenid, requireSession } = require('../../utils/auth');
const {
  acceptFriendRequest,
  listConversations,
  listFriendRequests,
  listFriends,
  listMessages,
  openDirectChat,
  rejectFriendRequest,
  removeFriend,
  sendFriendRequest,
  sendImageMessage,
  sendMessage,
  sendVoiceMessage,
} = require('../../utils/chat');
const { resolveCloudFileUrl, resolveCloudFileUrls, uploadFileToCloud } = require('../../utils/cloud');
const { getStoredThemeClass, syncTheme } = require('../../utils/theme');
const chatUnread = require('../../utils/chat-unread');
const { EMOJI_LIST } = require('./emoji-data');

const conversationFingerprint = (list = []) =>
  list
    .map(
      (item) =>
        `${item.id}|${item.title}|${item.lastMessageText || ''}|${item.isCouple ? 1 : 0}|${item.unreadCount || 0}`,
    )
    .join(';;');

const messageFingerprint = (list = []) =>
  list
    .map(
      (item) =>
        `${item.id}|${item.text}|${item.msgType || item.type || 'text'}|${item.voiceFileId || ''}|${item.imageFileId || ''}`,
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
    addId: '',
    avatarMap: {},
    conversations: [],
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

  pollTimer: null,
  signalWatcher: null,
  polling: false,
  conversationFp: '',
  messageFp: '',
  conversationAvatarsReady: false,
  friendAvatarsReady: false,
  signalWatchReady: false,
  usingWatch: false,
  unreadUnsubscribe: null,
  recorder: null,
  recorderStartedAt: 0,
  voiceTouching: false,
  audioCtx: null,

  async onShow() {
    this.getTabBar()?.init?.();
    chatUnread.start();
    const session = await requireSession({ requireCouple: false });
    if (!session) return;
    const openid = session.user?.openid || getSelfOpenid();
    const patch = {
      myOpenid: openid || '',
      myPublicUserId: session.user.publicUserId || '',
      themeClass: syncTheme(session.user.gender),
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
    this.setData(patch);
    const preferredId = wx.getStorageSync('couple.chat.activeId') || '';
    if (preferredId) {
      this.setData({ activeId: preferredId });
      wx.removeStorageSync('couple.chat.activeId');
    }

    // 先快速出会话列表（不换头像），再后台补头像；监听不阻塞首屏
    this.startRealtime(openid);
    await this.refreshConversations(true, {
      includeAvatars: false,
      skipMessages: false,
    });
    if (!this.conversationAvatarsReady) {
      this.loadAvatarsInBackground();
    }
  },

  /** 首屏后再补头像，避免 getTempFileURL 卡住进页 */
  async loadAvatarsInBackground() {
    if (this._avatarLoading) return;
    this._avatarLoading = true;
    try {
      const { conversations } = await listConversations({ includeAvatars: true });
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

  startRealtime(openid) {
    this.stopRealtime();
    // 复用全局信标；本页只订阅回调拉消息，离开页面不关全局 watch
    this.unreadUnsubscribe = chatUnread.subscribe((event) => {
      if (event?.type === 'signal') {
        this.onChatSignal(event.conversationId || '');
      }
    });
    this.usingWatch = true;
    chatUnread.start();
    // 全局兜底之外，页内再低频刷当前会话（仅消息页可见时）
    if (openid) {
      this.pollTimer = setInterval(() => {
        this.pollMessages();
      }, 30000);
    }
  },

  stopRealtime() {
    if (this.unreadUnsubscribe) {
      this.unreadUnsubscribe();
      this.unreadUnsubscribe = null;
    }
    this.stopSignalWatch();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.polling = false;
  },

  startSignalWatch() {
    // 已迁移到 utils/chat-unread 全局监听
    return false;
  },

  stopSignalWatch() {
    if (this.signalWatcher && this.signalWatcher.close) {
      try {
        this.signalWatcher.close();
      } catch (error) {
        // ignore
      }
    }
    this.signalWatcher = null;
    this.signalWatchReady = false;
  },

  async onChatSignal(conversationId) {
    if (this.data.showFriends) return;
    const tasks = [
      this.refreshConversations(false, { includeAvatars: false, skipMessages: true }),
    ];
    if (conversationId && conversationId === this.data.activeId) {
      tasks.unshift(this.loadMessages(this.data.activeId, true));
    } else if (this.data.activeId) {
      // 其他会话有新消息：只刷新左侧列表预览
    }
    await Promise.all(tasks);
  },

  async pollMessages() {
    if (this.polling || this.data.showFriends || !this.data.activeId) return;
    this.polling = true;
    try {
      await this.loadMessages(this.data.activeId, true);
    } finally {
      this.polling = false;
    }
  },

  async refreshConversations(selectDefault, options = {}) {
    const includeAvatars = options.includeAvatars === true;
    try {
      const { conversations } = await listConversations({ includeAvatars });
      let activeId = this.data.activeId;
      if (selectDefault) {
        if (!activeId || !conversations.some((item) => item.id === activeId)) {
          activeId = conversations.find((item) => item.isCouple)?.id || conversations[0]?.id || '';
        }
      }
      const active = conversations.find((item) => item.id === activeId);
      const nextFp = conversationFingerprint(conversations);
      const patch = {};
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
      if ((active?.title || '消息') !== this.data.activeTitle) {
        patch.activeTitle = active?.title || '消息';
      }
      if (Object.keys(patch).length) this.setData(patch);

      const listForBadge = patch.conversations || this.data.conversations;
      chatUnread.syncFromConversations(listForBadge);

      // 消息单独拉，不堵在同一条关键路径的头像逻辑里
      if (!options.skipMessages && activeId) {
        this.loadMessages(activeId, !selectDefault);
      }
    } catch (error) {
      if (this.data.loading) this.setData({ loading: false });
      if (selectDefault) wx.showToast({ title: error.message || '会话加载失败', icon: 'none' });
    }
  },

  clearLocalUnread(conversationId) {
    if (!conversationId) return;
    const conversations = this.data.conversations;
    const index = conversations.findIndex((item) => item.id === conversationId);
    if (index < 0 || !conversations[index].unreadCount) return;
    const nextList = conversations.map((item, i) => (i === index ? { ...item, unreadCount: 0 } : item));
    this.setData({
      [`conversations[${index}].unreadCount`]: 0,
    });
    this.conversationFp = conversationFingerprint(nextList);
    chatUnread.syncFromConversations(nextList);
  },

  async loadMessages(conversationId, silent) {
    try {
      const { messages } = await listMessages(conversationId, 40);
      if (this.data.activeId !== conversationId) return;
      const decorated = decorateMessages(messages);
      const nextFp = messageFingerprint(decorated);
      this.clearLocalUnread(conversationId);
      if (nextFp === this.messageFp) {
        this.resolveMessageImages(decorated);
        return;
      }
      this.messageFp = nextFp;
      this.setData({ messages: decorated });
      this.resolveMessageImages(decorated);
      if (!silent) {
        const target = `msg-${Math.max(decorated.length - 1, 0)}`;
        this.setData({ scrollIntoView: '' });
        wx.nextTick(() => {
          this.setData({ scrollIntoView: target });
        });
      }
    } catch (error) {
      if (!silent) wx.showToast({ title: error.message || '消息加载失败', icon: 'none' });
    }
  },

  async resolveMessageImages(messages = []) {
    const ids = messages
      .filter((item) => (item.msgType === 'image' || item.type === 'image') && item.imageFileId)
      .map((item) => item.imageFileId)
      .filter((id) => id.startsWith('cloud://') && !this.data.imageUrlMap[id]);
    if (!ids.length) return;
    const map = await resolveCloudFileUrls(ids);
    if (!Object.keys(map).length) return;
    this.setData({
      imageUrlMap: { ...this.data.imageUrlMap, ...map },
    });
  },

  selectConversation(event) {
    const id = event.currentTarget.dataset.id;
    const active = this.data.conversations.find((item) => item.id === id);
    if (!id || id === this.data.activeId) return;
    this.stopVoicePlayback();
    this.messageFp = '';
    this.setData({
      activeId: id,
      activeTitle: active?.title || '消息',
      inputFocus: false,
      messages: [],
      showEmoji: false,
      showFriends: false,
    });
    this.loadMessages(id, false);
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
    const voiceMode = !this.data.voiceMode;
    if (voiceMode) {
      // 进入语音模式前先申请权限，避免按住说话时异步授权导致 start/stop 竞态
      this.ensureRecordAuth().then((ok) => {
        if (!ok) return;
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
    if (!this.data.activeId || this.data.sending) return;
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
    if (!this.data.activeId || this.data.sending) return;
    this.setData({ sending: true });
    wx.showLoading({ title: '发送图片中' });
    try {
      const extension = (tempFilePath.split('.').pop() || 'jpg').toLowerCase().split('?')[0];
      const safeExt = /^[a-z0-9]{1,5}$/.test(extension) ? extension : 'jpg';
      const cloudPath = `chat/image/${Date.now()}-${Math.random().toString(36).slice(2)}.${safeExt}`;
      const fileID = await uploadFileToCloud(tempFilePath, cloudPath);
      const { message } = await sendImageMessage(this.data.activeId, { imageFileId: fileID });
      const decorated = decorateMessages([
        {
          ...message,
          imageFileId: message.imageFileId || fileID,
          msgType: 'image',
          type: 'image',
          imageUrl: tempFilePath,
        },
      ])[0];
      const messages = [...this.data.messages, decorated];
      this.messageFp = messageFingerprint(messages);
      this.setData({
        messages,
        sending: false,
        showEmoji: false,
        imageUrlMap: {
          ...this.data.imageUrlMap,
          [fileID]: tempFilePath,
        },
      });
      this.conversationFp = '';
      this.refreshConversations(false, { includeAvatars: false, skipMessages: true });
      wx.hideLoading();
      wx.nextTick(() => {
        this.setData({ scrollIntoView: `msg-${messages.length - 1}` });
      });
      this.resolveMessageImages([decorated]);
    } catch (error) {
      wx.hideLoading();
      this.setData({ sending: false });
      wx.showToast({ title: error.message || '图片发送失败', icon: 'none' });
    }
  },

  previewChatImage(event) {
    const url = event.currentTarget.dataset.url;
    if (!url) return;
    const urls = this.data.messages
      .filter((item) => item.msgType === 'image' || item.type === 'image')
      .map((item) => item.imageUrl || this.data.imageUrlMap[item.imageFileId] || item.imageFileId)
      .filter(Boolean);
    wx.previewImage({
      current: url,
      urls: urls.length ? urls : [url],
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
    if (!this.data.activeId || this.data.sending) return;
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
    if (!this.data.activeId || this.data.sending) return;
    this.setData({ sending: true });
    wx.showLoading({ title: '发送语音中' });
    try {
      const cloudPath = `chat/voice/${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`;
      const fileID = await uploadFileToCloud(tempFilePath, cloudPath);
      const { message } = await sendVoiceMessage(this.data.activeId, {
        voiceDuration,
        voiceFileId: fileID,
      });
      const decorated = decorateMessages([
        {
          ...message,
          msgType: 'voice',
          type: 'voice',
          voiceDuration,
          voiceFileId: message.voiceFileId || fileID,
        },
      ])[0];
      const messages = [...this.data.messages, decorated];
      this.messageFp = messageFingerprint(messages);
      this.setData({
        messages,
        sending: false,
        showEmoji: false,
      });
      this.conversationFp = '';
      this.refreshConversations(false, { includeAvatars: false, skipMessages: true });
      wx.hideLoading();
      wx.nextTick(() => {
        this.setData({ scrollIntoView: `msg-${messages.length - 1}` });
      });
    } catch (error) {
      wx.hideLoading();
      this.setData({ sending: false });
      wx.showToast({ title: error.message || '语音发送失败', icon: 'none' });
    }
  },

  stopVoicePlayback() {
    if (this.audioCtx) {
      try {
        this.audioCtx.stop();
        this.audioCtx.destroy();
      } catch (error) {
        // ignore
      }
      this.audioCtx = null;
    }
    if (this.data.playingVoiceId) this.setData({ playingVoiceId: '' });
  },

  async playVoice(event) {
    const { id, file } = event.currentTarget.dataset;
    if (!file) return;
    if (this.data.playingVoiceId === id) {
      this.stopVoicePlayback();
      return;
    }
    this.stopVoicePlayback();
    let url = file;
    if (String(file).startsWith('cloud://')) {
      url = (await resolveCloudFileUrl(file)) || '';
    }
    if (!url) {
      wx.showToast({ title: '语音无法播放', icon: 'none' });
      return;
    }
    const audio = wx.createInnerAudioContext();
    this.audioCtx = audio;
    audio.src = url;
    this.setData({ playingVoiceId: id });
    audio.onEnded(() => {
      if (this.data.playingVoiceId === id) this.setData({ playingVoiceId: '' });
      this.audioCtx = null;
    });
    audio.onError(() => {
      this.setData({ playingVoiceId: '' });
      this.audioCtx = null;
      wx.showToast({ title: '播放失败', icon: 'none' });
    });
    audio.play();
  },

  async submitMessage() {
    const text = (this.data.draft || '').trim();
    if (!text || !this.data.activeId || this.data.sending || this.data.voiceMode) return;
    this.setData({ sending: true });
    try {
      const { message } = await sendMessage(this.data.activeId, text);
      const decorated = decorateMessages([message])[0];
      const messages = [...this.data.messages, decorated];
      this.messageFp = messageFingerprint(messages);
      this.setData({
        draft: '',
        messages,
        sending: false,
        showEmoji: false,
      });
      this.conversationFp = '';
      this.refreshConversations(false, { includeAvatars: false });
      wx.nextTick(() => {
        this.setData({ scrollIntoView: `msg-${messages.length - 1}` });
      });
    } catch (error) {
      this.setData({ sending: false });
      wx.showToast({ title: error.message || '发送失败', icon: 'none' });
    }
  },

  async openFriendsPanel() {
    this.setData({
      showFriends: true,
      showEmoji: false,
      inputFocus: false,
    });
    await this.refreshFriendsPanel();
  },

  closeFriendsPanel() {
    if (!this.data.showFriends) return;
    this.setData({ showFriends: false });
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
    try {
      const { conversationId } = await openDirectChat(friendOpenid);
      this.setData({ activeId: conversationId, showFriends: false });
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
      confirmColor: '#bd6875',
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
