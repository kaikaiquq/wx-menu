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
  sendMessage,
  sendVoiceMessage,
} = require('../../utils/chat');
const { resolveCloudFileUrl } = require('../../utils/cloud');
const { getStoredThemeClass, syncTheme } = require('../../utils/theme');
const { EMOJI_LIST } = require('./emoji-data');

const conversationFingerprint = (list = []) =>
  list
    .map(
      (item) =>
        `${item.id}|${item.title}|${item.lastMessageText || ''}|${item.isCouple ? 1 : 0}|${item.unreadCount || 0}`,
    )
    .join(';;');

const messageFingerprint = (list = []) =>
  list.map((item) => `${item.id}|${item.text}|${item.type || 'text'}|${item.voiceFileId || ''}`).join(';;');

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

const decorateMessages = (messages = []) =>
  messages.map((item) => ({
    ...item,
    timeText: formatMessageTime(item.createdAt),
    type: item.type === 'voice' ? 'voice' : 'text',
  }));

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
    submittingFriend: false,
    themeClass: getStoredThemeClass(),
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
  recorder: null,
  recorderStartedAt: 0,
  voiceTouching: false,
  audioCtx: null,

  async onShow() {
    this.getTabBar()?.init?.();
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
    if (openid && this.startSignalWatch(openid)) {
      this.usingWatch = true;
      return;
    }
    // watch 不可用时才低频兜底（仅当前页、仅当前会话消息）
    this.usingWatch = false;
    this.pollTimer = setInterval(() => {
      this.pollMessages();
    }, 30000);
  },

  stopRealtime() {
    this.stopSignalWatch();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.polling = false;
  },

  startSignalWatch(openid) {
    if (!openid || !wx.cloud?.database) return false;
    try {
      const db = wx.cloud.database();
      this.signalWatchReady = false;
      this.signalWatcher = db.collection('chatSignals').doc(openid).watch({
        onChange: (snapshot) => {
          // 首次 init 不处理，避免进页重复拉
          if (!this.signalWatchReady) {
            this.signalWatchReady = true;
            return;
          }
          const doc =
            (snapshot.docs && snapshot.docs[0]) ||
            (snapshot.docChanges && snapshot.docChanges[0] && snapshot.docChanges[0].doc) ||
            null;
          const conversationId = doc?.conversationId || '';
          this.onChatSignal(conversationId);
        },
        onError: (error) => {
          console.warn('chatSignals watch failed, fallback polling', error);
          this.stopSignalWatch();
          this.usingWatch = false;
          if (!this.pollTimer) {
            this.pollTimer = setInterval(() => {
              this.pollMessages();
            }, 30000);
          }
        },
      });
      return true;
    } catch (error) {
      console.warn('chatSignals watch unavailable', error);
      return false;
    }
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
    this.setData({
      [`conversations[${index}].unreadCount`]: 0,
    });
    this.conversationFp = conversationFingerprint(
      conversations.map((item, i) => (i === index ? { ...item, unreadCount: 0 } : item)),
    );
  },

  async loadMessages(conversationId, silent) {
    try {
      const { messages } = await listMessages(conversationId, 40);
      if (this.data.activeId !== conversationId) return;
      const decorated = decorateMessages(messages);
      const nextFp = messageFingerprint(decorated);
      this.clearLocalUnread(conversationId);
      if (nextFp === this.messageFp) return;
      this.messageFp = nextFp;
      this.setData({ messages: decorated });
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
    this.setData({
      voiceMode,
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

  /** 点空白：键盘和表情都收起 */
  dismissComposerExtras() {
    if (!this.data.showEmoji && !this.data.inputFocus) return;
    this.setData({
      showEmoji: false,
      inputFocus: false,
    });
  },

  ensureRecorder() {
    if (this.recorder) return this.recorder;
    const recorder = wx.getRecorderManager();
    recorder.onStart(() => {
      this.recorderStartedAt = Date.now();
      this.setData({ recording: true });
    });
    recorder.onStop(async (res) => {
      const wasTouching = this.voiceTouching;
      this.voiceTouching = false;
      this.setData({ recording: false });
      if (!wasTouching || this._voiceCancelled) {
        this._voiceCancelled = false;
        return;
      }
      const durationMs = res.duration || Date.now() - this.recorderStartedAt;
      const durationSec = Math.max(1, Math.round(durationMs / 1000));
      if (durationMs < 800) {
        wx.showToast({ title: '说话时间太短', icon: 'none' });
        return;
      }
      if (!res.tempFilePath) {
        wx.showToast({ title: '录音失败', icon: 'none' });
        return;
      }
      await this.uploadAndSendVoice(res.tempFilePath, durationSec);
    });
    recorder.onError((error) => {
      this.voiceTouching = false;
      this.setData({ recording: false });
      wx.showToast({ title: error?.errMsg || '录音失败', icon: 'none' });
    });
    this.recorder = recorder;
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

  async onVoiceTouchStart() {
    if (!this.data.activeId || this.data.sending) return;
    const ok = await this.ensureRecordAuth();
    if (!ok) return;
    this._voiceCancelled = false;
    this.voiceTouching = true;
    const recorder = this.ensureRecorder();
    recorder.start({
      duration: 60000,
      format: 'mp3',
      sampleRate: 16000,
      numberOfChannels: 1,
      encodeBitRate: 48000,
    });
  },

  onVoiceTouchEnd() {
    if (!this.voiceTouching && !this.data.recording) return;
    this.voiceTouching = true;
    try {
      this.ensureRecorder().stop();
    } catch (error) {
      this.setData({ recording: false });
    }
  },

  onVoiceTouchCancel() {
    this.cancelRecording();
  },

  cancelRecording(silent) {
    this._voiceCancelled = true;
    this.voiceTouching = false;
    if (this.data.recording || this.recorder) {
      try {
        this.ensureRecorder().stop();
      } catch (error) {
        // ignore
      }
    }
    this.setData({ recording: false });
    if (!silent) {
      // no toast on page hide
    }
  },

  async uploadAndSendVoice(tempFilePath, voiceDuration) {
    if (!this.data.activeId || this.data.sending) return;
    this.setData({ sending: true });
    wx.showLoading({ title: '发送语音中' });
    try {
      const cloudPath = `chat/voice/${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`;
      const { fileID } = await wx.cloud.uploadFile({
        cloudPath,
        filePath: tempFilePath,
      });
      const { message } = await sendVoiceMessage(this.data.activeId, {
        voiceDuration,
        voiceFileId: fileID,
      });
      const decorated = decorateMessages([message])[0];
      const messages = [...this.data.messages, decorated];
      this.messageFp = messageFingerprint(messages);
      this.setData({
        messages,
        sending: false,
        showEmoji: false,
      });
      this.conversationFp = '';
      this.refreshConversations(false, { includeAvatars: false });
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
