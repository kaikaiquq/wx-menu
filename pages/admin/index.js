const { getMenuConfig, saveMenuConfig } = require('../../utils/couple-config');
const { requireSession } = require('../../utils/auth');
const { getThemeClass } = require('../../utils/theme');
const {
  clearConfigSession,
  getConfigDraft,
  setConfigDraft,
  startConfigSession,
} = require('../../utils/couple-config-session');

Page({
  data: {
    categoryCount: 0,
    menuCount: 0,
    profile: {},
    saving: false,
    themeClass: 'theme-female',
  },

  async onLoad() {
    const session = await requireSession();
    if (!session) return;
    this.setData({ themeClass: getThemeClass(session.user.gender) });
    try {
      const config = await getMenuConfig(true);
      const draft = startConfigSession(config);
      this.showDraft(draft);
    } catch (error) {
      wx.showToast({ title: error.message || '配置加载失败', icon: 'none' });
    }
  },

  onShow() {
    this.showDraft(getConfigDraft());
  },

  onUnload() {
    clearConfigSession();
  },

  showDraft(draft) {
    this.setData({
      categoryCount: draft.categories.length,
      menuCount: draft.menuItems.length,
      profile: draft.profile,
    });
  },

  updateProfile(event) {
    const profile = {
      ...this.data.profile,
      [event.currentTarget.dataset.field]: event.detail.value,
    };
    const draft = getConfigDraft();
    setConfigDraft({ ...draft, profile });
    this.setData({ profile });
  },

  changeAnniversary(event) {
    const profile = {
      ...this.data.profile,
      anniversary: event.detail.value,
    };
    const draft = getConfigDraft();
    setConfigDraft({ ...draft, profile });
    this.setData({ profile });
  },

  openCategoryManager() {
    wx.navigateTo({ url: '/pages/admin/categories/index' });
  },

  openMenuManager() {
    wx.navigateTo({ url: '/pages/admin-menu/index' });
  },

  clearAll() {
    wx.showModal({
      title: '清空全部菜单内容？',
      content: '所有分类和点单项会被清空。当前操作只会暂存，点击“保存并立即生效”后才会真正生效。',
      confirmText: '确认清空',
      confirmColor: '#bd6875',
      success: ({ confirm }) => {
        if (!confirm) return;
        const draft = getConfigDraft();
        const clearedDraft = {
          ...draft,
          categories: [
            {
              icon: '♡',
              id: `category-${Date.now()}`,
              name: '未分类',
              subtitle: '新的小心愿',
            },
          ],
          menuItems: [],
        };
        setConfigDraft(clearedDraft);
        this.showDraft(clearedDraft);
        wx.showToast({ title: '已暂存，尚未生效', icon: 'none' });
      },
    });
  },

  async saveAll() {
    const draft = getConfigDraft();
    if (!draft.profile.herName.trim() || !draft.profile.hisName.trim()) {
      wx.showToast({ title: '请填写双方昵称', icon: 'none' });
      return;
    }

    this.setData({ saving: true });
    try {
      const saved = await saveMenuConfig(draft);
      startConfigSession(saved);
      this.setData({ saving: false });
      wx.showToast({ title: '配置已生效', icon: 'success' });
    } catch (error) {
      this.setData({ saving: false });
      wx.showModal({
        title: error.code === 'VERSION_CONFLICT' ? '内容已被更新' : '保存失败',
        content: error.message || '请稍后重试',
        showCancel: false,
      });
    }
  },
});
