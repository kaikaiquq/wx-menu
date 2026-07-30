const { requireSession } = require('../../utils/auth');
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
} = require('../../utils/chat');
const { getStoredThemeClass, syncTheme } = require('../../utils/theme');

const conversationFingerprint = (list = []) =>
  list
    .map((item) => `${item.id}|${item.title}|${item.lastMessageText || ''}|${item.isCouple ? 1 : 0}`)
    .join(';;');

const messageFingerprint = (list = []) => list.map((item) => `${item.id}|${item.text}`).join(';;');

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

Page({
  data: {
    activeId: '',
    activeTitle: '消息',
    addId: '',
    avatarMap: {},
    conversations: [],
    draft: '',
    filteredFriends: [],
    friends: [],
    friendKeyword: '',
    incoming: [],
    loading: true,
    messages: [],
    myPublicUserId: '',
    scrollIntoView: '',
    sending: false,
    showFriends: false,
    submittingFriend: false,
    themeClass: getStoredThemeClass(),
  },

  pollTimer: null,
  polling: false,
  conversationFp: '',
  messageFp: '',
  conversationAvatarsReady: false,
  friendAvatarsReady: false,

  async onShow() {
    this.getTabBar()?.init?.();
    const session = await requireSession({ requireCouple: false });
    if (!session) return;
    this.setData({
      myPublicUserId: session.user.publicUserId || '',
      themeClass: syncTheme(session.user.gender),
    });
    const preferredId = wx.getStorageSync('couple.chat.activeId') || '';
    if (preferredId) {
      this.setData({ activeId: preferredId });
      wx.removeStorageSync('couple.chat.activeId');
    }
    // 进入页面只在首次拉头像；之后轮询不再要临时链
    await this.refreshConversations(true, { includeAvatars: !this.conversationAvatarsReady });
    this.startPolling();
  },

  onHide() {
    this.stopPolling();
  },

  onUnload() {
    this.stopPolling();
  },

  startPolling() {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      this.pollTick();
    }, 5000);
  },

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.polling = false;
  },

  async pollTick() {
    if (this.polling || this.data.showFriends) return;
    this.polling = true;
    try {
      await Promise.all([
        this.data.activeId ? this.loadMessages(this.data.activeId, true) : Promise.resolve(),
        this.refreshConversations(false, { includeAvatars: false, skipMessages: true }),
      ]);
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
          conversations.map((item) => item.peer).filter(Boolean),
        );
        if (avatarMap) {
          patch.avatarMap = avatarMap;
          this.conversationAvatarsReady = true;
        } else if (conversations.length) {
          this.conversationAvatarsReady = true;
        }
      }

      if (nextFp !== this.conversationFp) {
        this.conversationFp = nextFp;
        // 展示头像只用 avatarMap，会话数据里不再依赖会变化的临时链
        patch.conversations = conversations.map((item) => ({
          ...item,
          peer: item.peer
            ? {
                ...item.peer,
                avatarUrl: '',
              }
            : null,
        }));
      }
      if (activeId !== this.data.activeId) patch.activeId = activeId;
      if ((active?.title || '消息') !== this.data.activeTitle) {
        patch.activeTitle = active?.title || '消息';
      }
      if (Object.keys(patch).length) this.setData(patch);
      if (!options.skipMessages && activeId) {
        await this.loadMessages(activeId, !selectDefault);
      }
    } catch (error) {
      if (this.data.loading) this.setData({ loading: false });
      if (selectDefault) wx.showToast({ title: error.message || '会话加载失败', icon: 'none' });
    }
  },

  async loadMessages(conversationId, silent) {
    try {
      const { messages } = await listMessages(conversationId, 40);
      if (this.data.activeId !== conversationId) return;
      const nextFp = messageFingerprint(messages);
      if (nextFp === this.messageFp) return;
      this.messageFp = nextFp;
      this.setData({ messages });
      if (!silent) {
        const target = `msg-${Math.max(messages.length - 1, 0)}`;
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
    this.messageFp = '';
    this.setData({
      activeId: id,
      activeTitle: active?.title || '消息',
      messages: [],
      showFriends: false,
    });
    this.loadMessages(id, false);
  },

  updateDraft(event) {
    this.setData({ draft: event.detail.value });
  },

  async submitMessage() {
    const text = (this.data.draft || '').trim();
    if (!text || !this.data.activeId || this.data.sending) return;
    this.setData({ sending: true });
    try {
      const { message } = await sendMessage(this.data.activeId, text);
      const messages = [...this.data.messages, message];
      this.messageFp = messageFingerprint(messages);
      this.setData({
        draft: '',
        messages,
        sending: false,
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
    this.setData({ showFriends: true });
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
