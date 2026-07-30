const {
  getConfigDraft,
  getDraftScope,
  setConfigDraft,
} = require('../utils/couple-config-session');
const { requireSession } = require('../../../utils/auth');
const { getContentTemplates } = require('../utils/templates');
const { withLetterAvatars } = require('../../../utils/letter-avatar');
const { getStoredThemeClass, syncTheme } = require('../../../utils/theme');

Page({
  data: {
    categories: [],
    categoryDraft: null,
    editingIndex: -1,
    menuItems: [],
    showTemplatePicker: false,
    templates: [],
    themeClass: getStoredThemeClass(),
  },

  async onLoad() {
    const session = await requireSession({ requireCouple: getDraftScope() === 'shared' });
    if (!session) return;
    const draft = getConfigDraft();
    this.setData({
      categories: withLetterAvatars(draft.categories),
      menuItems: draft.menuItems,
      themeClass: syncTheme(session.user.gender),
    });
    this.loadTemplates();
  },

  async loadTemplates() {
    const { categories } = await getContentTemplates();
    this.setData({ templates: categories });
  },

  saveDraft(categories, menuItems = this.data.menuItems) {
    const draft = getConfigDraft();
    setConfigDraft({ ...draft, categories, menuItems });
    this.setData({ categories: withLetterAvatars(categories), menuItems });
  },

  openAddOptions() {
    this.setData({ showTemplatePicker: true });
  },

  closeTemplatePicker() {
    this.setData({ showTemplatePicker: false });
  },

  pickTemplate(event) {
    const template = this.data.templates[Number(event.currentTarget.dataset.index)];
    if (!template) return;
    if (this.data.categories.some((category) => category.name === template.name)) {
      wx.showToast({ title: '已经有同名分类', icon: 'none' });
      return;
    }
    this.saveDraft([
      ...this.data.categories,
      {
        icon: template.icon || '✨',
        id: `category-${Date.now()}`,
        image: template.image || '',
        name: template.name,
        subtitle: template.subtitle || '推荐分类',
      },
    ]);
    this.setData({ showTemplatePicker: false });
    wx.showToast({ title: '已加入草稿', icon: 'none' });
  },

  openCustomEditor() {
    this.setData({
      categoryDraft: {
        icon: '✨',
        image: '',
        name: '',
        subtitle: '自定义分类',
      },
      editingIndex: -1,
      showTemplatePicker: false,
    });
  },

  editCategory(event) {
    const index = Number(event.currentTarget.dataset.index);
    const current = this.data.categories[index];
    this.setData({
      categoryDraft: {
        icon: current.icon || '✨',
        image: current.image || '',
        name: current.name || '',
        subtitle: current.subtitle || '',
      },
      editingIndex: index,
      showTemplatePicker: false,
    });
  },

  closeCategoryEditor() {
    this.setData({ categoryDraft: null, editingIndex: -1 });
  },

  updateCategoryDraft(event) {
    this.setData({
      [`categoryDraft.${event.currentTarget.dataset.field}`]: event.detail.value,
    });
  },

  chooseCategoryImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: ({ tempFiles }) => {
        const tempFilePath = tempFiles[0]?.tempFilePath;
        if (!tempFilePath) return;
        wx.saveFile({
          tempFilePath,
          success: ({ savedFilePath }) => {
            this.setData({ 'categoryDraft.image': savedFilePath });
          },
          fail: () => this.setData({ 'categoryDraft.image': tempFilePath }),
        });
      },
    });
  },

  clearCategoryImage() {
    this.setData({ 'categoryDraft.image': '' });
  },

  confirmCategory() {
    const draft = this.data.categoryDraft || {};
    const name = String(draft.name || '').trim();
    if (!name) {
      wx.showToast({ title: '请填写分类名称', icon: 'none' });
      return;
    }
    const duplicated = this.data.categories.some(
      (category, index) => category.name === name && index !== this.data.editingIndex,
    );
    if (duplicated) {
      wx.showToast({ title: '已经有同名分类', icon: 'none' });
      return;
    }

    let categories = [...this.data.categories];
    if (this.data.editingIndex >= 0) {
      categories[this.data.editingIndex] = {
        ...categories[this.data.editingIndex],
        icon: draft.icon || '✨',
        image: draft.image || '',
        name,
        subtitle: String(draft.subtitle || '').trim() || '自定义分类',
      };
    } else {
      categories.push({
        icon: draft.icon || '✨',
        id: `category-${Date.now()}`,
        image: draft.image || '',
        name,
        subtitle: String(draft.subtitle || '').trim() || '自定义分类',
      });
    }
    this.saveDraft(categories);
    this.closeCategoryEditor();
    wx.showToast({ title: '已加入草稿', icon: 'none' });
  },

  deleteCategory(event) {
    if (this.data.categories.length === 1) {
      wx.showToast({ title: '至少保留一个分类', icon: 'none' });
      return;
    }

    const index = Number(event.currentTarget.dataset.index);
    const category = this.data.categories[index];
    const itemCount = this.data.menuItems.filter((item) => item.categoryId === category.id).length;
    wx.showModal({
      title: `删除“${category.name}”？`,
      content: `会同时从草稿中删除该分类下的 ${itemCount} 个点单项。返回配置首页并保存后才会生效。`,
      confirmText: '确认删除',
      confirmColor: '#bd6875',
      success: ({ confirm }) => {
        if (!confirm) return;
        const categories = this.data.categories.filter((_, categoryIndex) => categoryIndex !== index);
        const menuItems = this.data.menuItems.filter((item) => item.categoryId !== category.id);
        this.saveDraft(categories, menuItems);
        wx.showToast({ title: '已从草稿删除', icon: 'none' });
      },
    });
  },

  noop() {},
});
