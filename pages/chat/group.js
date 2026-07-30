const { requireSession } = require('../../utils/auth');
const { createGroup, listFriends } = require('../../utils/chat');
const { getStoredThemeClass, syncTheme } = require('../../utils/theme');

Page({
  data: {
    friends: [],
    selected: {},
    selectedCount: 0,
    submitting: false,
    themeClass: getStoredThemeClass(),
    title: '',
  },

  async onShow() {
    const session = await requireSession({ requireCouple: false });
    if (!session) return;
    this.setData({ themeClass: syncTheme(session.user.gender) });
    try {
      const { friends } = await listFriends();
      this.setData({ friends });
    } catch (error) {
      wx.showToast({ title: error.message || '加载失败', icon: 'none' });
    }
  },

  updateTitle(event) {
    this.setData({ title: event.detail.value });
  },

  toggleFriend(event) {
    const openid = event.currentTarget.dataset.openid;
    const selected = { ...this.data.selected };
    if (selected[openid]) delete selected[openid];
    else selected[openid] = true;
    this.setData({
      selected,
      selectedCount: Object.keys(selected).length,
    });
  },

  async submit() {
    if (this.data.submitting) return;
    const memberOpenids = Object.keys(this.data.selected);
    if (memberOpenids.length < 2) {
      wx.showToast({ title: '请至少选择两位好友', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    try {
      const { conversationId } = await createGroup(this.data.title.trim(), memberOpenids);
      wx.setStorageSync('couple.chat.activeId', conversationId);
      wx.showToast({ title: '群聊已创建', icon: 'success' });
      setTimeout(() => {
        wx.switchTab({ url: '/pages/chat/index' });
      }, 400);
    } catch (error) {
      this.setData({ submitting: false });
      wx.showToast({ title: error.message || '创建失败', icon: 'none' });
    }
  },
});
