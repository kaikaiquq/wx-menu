const { requireSession } = require('../../utils/auth');
const {
  acceptFriendRequest,
  listFriendRequests,
  listFriends,
  openDirectChat,
  rejectFriendRequest,
  removeFriend,
  sendFriendRequest,
} = require('../../utils/chat');
const { getStoredThemeClass, syncTheme } = require('../../utils/theme');

Page({
  data: {
    addId: '',
    friends: [],
    incoming: [],
    loading: true,
    myPublicUserId: '',
    outgoing: [],
    submitting: false,
    themeClass: getStoredThemeClass(),
  },

  async onShow() {
    const session = await requireSession({ requireCouple: false });
    if (!session) return;
    this.setData({
      myPublicUserId: session.user.publicUserId || '',
      themeClass: syncTheme(session.user.gender),
    });
    this.refresh();
  },

  async refresh() {
    try {
      const [{ friends }, { incoming, outgoing }] = await Promise.all([
        listFriends(),
        listFriendRequests(),
      ]);
      this.setData({ friends, incoming, loading: false, outgoing });
    } catch (error) {
      this.setData({ loading: false });
      wx.showToast({ title: error.message || '加载失败', icon: 'none' });
    }
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

  async submitAdd() {
    const publicUserId = (this.data.addId || '').trim();
    if (!publicUserId || this.data.submitting) return;
    this.setData({ submitting: true });
    try {
      await sendFriendRequest(publicUserId);
      this.setData({ addId: '', submitting: false });
      wx.showToast({ title: '已发送申请', icon: 'success' });
      this.refresh();
    } catch (error) {
      this.setData({ submitting: false });
      wx.showToast({ title: error.message || '添加失败', icon: 'none' });
    }
  },

  async acceptRequest(event) {
    try {
      await acceptFriendRequest(event.currentTarget.dataset.id);
      wx.showToast({ title: '已添加好友', icon: 'success' });
      this.refresh();
    } catch (error) {
      wx.showToast({ title: error.message || '操作失败', icon: 'none' });
    }
  },

  async rejectRequest(event) {
    try {
      await rejectFriendRequest(event.currentTarget.dataset.id);
      wx.showToast({ title: '已拒绝', icon: 'none' });
      this.refresh();
    } catch (error) {
      wx.showToast({ title: error.message || '操作失败', icon: 'none' });
    }
  },

  async chatFriend(event) {
    const friendOpenid = event.currentTarget.dataset.openid;
    try {
      const { conversationId } = await openDirectChat(friendOpenid);
      wx.switchTab({ url: '/pages/chat/index' });
      // 会话列表下次 onShow 会刷新；用 storage 提示选中
      wx.setStorageSync('couple.chat.activeId', conversationId);
    } catch (error) {
      wx.showToast({ title: error.message || '打开失败', icon: 'none' });
    }
  },

  removeFriendConfirm(event) {
    const { openid, name } = event.currentTarget.dataset;
    wx.showModal({
      title: '删除好友？',
      content: `确定删除「${name || '好友'}」吗？不会删除已有聊天记录。`,
      confirmColor: '#bd6875',
      success: async ({ confirm }) => {
        if (!confirm) return;
        try {
          await removeFriend(openid);
          wx.showToast({ title: '已删除', icon: 'none' });
          this.refresh();
        } catch (error) {
          wx.showToast({ title: error.message || '删除失败', icon: 'none' });
        }
      },
    });
  },

  openCreateGroup() {
    wx.navigateTo({ url: '/pages/chat/group' });
  },
});
