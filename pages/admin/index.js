const { getMenuConfig, saveMenuConfig } = require('../../utils/couple-config');
const { mergeConfigContent } = require('../../utils/merge-config');
const { getPersonalConfig, savePersonalConfig } = require('../../utils/personal-config');
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
    personalItems: [],
    profile: {},
    saving: false,
    selectedPersonalIds: [],
    showPersonalPicker: false,
    scope: 'shared',
    themeClass: 'theme-female',
  },

  async onLoad(options) {
    this.scope = options.scope === 'personal' ? 'personal' : 'shared';
    const session = await requireSession({ requireCouple: this.scope === 'shared' });
    if (!session) return;
    if (this.scope === 'shared' && session.couple?.status !== 'active') {
      wx.showToast({ title: '绑定后才能管理共同空间', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 500);
      return;
    }
    wx.setNavigationBarTitle({ title: this.scope === 'personal' ? '我的内容库' : '共同空间管理' });
    this.setData({ scope: this.scope, themeClass: getThemeClass(session.user.gender) });
    try {
      const config = this.scope === 'personal' ? await getPersonalConfig(true) : await getMenuConfig(true);
      const draft = startConfigSession(config, this.scope);
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
    const field = event.currentTarget.dataset.field;
    let value = event.detail.value || '';
    if (field === 'herName' || field === 'hisName') {
      value = this.limitDisplayName(value);
    }
    const profile = {
      ...this.data.profile,
      [field]: value,
    };
    const draft = getConfigDraft();
    setConfigDraft({ ...draft, profile });
    this.setData({ profile });
  },

  // 按常见规则：1 个汉字 = 2 个字符，上限 40 字符（约 20 个汉字）
  limitDisplayName(value) {
    let units = 0;
    let result = '';
    for (const char of value) {
      const cost = /[\u4e00-\u9fff]/.test(char) ? 2 : 1;
      if (units + cost > 40) break;
      units += cost;
      result += char;
    }
    return result;
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

  createAndLinkItem() {
    wx.navigateTo({ url: '/pages/admin-menu/index?mode=createAndLink' });
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
    if (
      this.scope === 'shared' &&
      (!draft.profile.herName.trim() || !draft.profile.hisName.trim())
    ) {
      wx.showToast({ title: '请填写双方昵称', icon: 'none' });
      return;
    }

    this.setData({ saving: true });
    try {
      const saved =
        this.scope === 'personal' ? await savePersonalConfig(draft) : await saveMenuConfig(draft);
      startConfigSession(saved, this.scope);
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

  async openPersonalPicker() {
    wx.showLoading({ title: '加载个人内容' });
    try {
      const personalConfig = await getPersonalConfig(true);
      wx.hideLoading();
      this.personalConfig = personalConfig;
      this.setData({
        personalItems: personalConfig.menuItems.map((item) => ({ ...item, selected: false })),
        selectedPersonalIds: [],
        showPersonalPicker: true,
      });
    } catch (error) {
      wx.hideLoading();
      wx.showToast({ title: error.message || '个人内容加载失败', icon: 'none' });
    }
  },

  closePersonalPicker() {
    this.setData({ showPersonalPicker: false });
  },

  togglePersonalItem(event) {
    const id = event.currentTarget.dataset.id;
    const selectedPersonalIds = this.data.selectedPersonalIds.includes(id)
      ? this.data.selectedPersonalIds.filter((itemId) => itemId !== id)
      : this.data.selectedPersonalIds.concat(id);
    this.setData({
      personalItems: this.data.personalItems.map((item) => ({
        ...item,
        selected: selectedPersonalIds.includes(item.id),
      })),
      selectedPersonalIds,
    });
  },

  addSelectedPersonalItems() {
    if (!this.data.selectedPersonalIds.length) {
      wx.showToast({ title: '请先选择内容', icon: 'none' });
      return;
    }
    const menuItems = this.personalConfig.menuItems.filter((item) =>
      this.data.selectedPersonalIds.includes(item.id),
    );
    const categoryIds = new Set(menuItems.map((item) => item.categoryId));
    const categories = this.personalConfig.categories.filter((item) => categoryIds.has(item.id));
    try {
      const merged = mergeConfigContent(getConfigDraft(), { categories, menuItems });
      setConfigDraft(merged);
      this.showDraft(merged);
      this.setData({ showPersonalPicker: false });
      wx.showToast({ title: '已加入共同草稿', icon: 'none' });
    } catch (error) {
      wx.showToast({ title: error.message || '添加失败', icon: 'none' });
    }
  },
});
