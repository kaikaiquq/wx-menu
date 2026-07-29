const { getConfigDraft, setConfigDraft } = require('../../../utils/couple-config-session');
const { getDefaultConfig } = require('../../../utils/couple-config');
const { requireSession } = require('../../../utils/auth');
const { getThemeClass } = require('../../../utils/theme');

Page({
  data: {
    categories: [],
    categoryNames: [],
    authorized: false,
    editingIndex: -1,
    itemDraft: null,
    loadError: false,
    menuItems: [],
    themeClass: 'theme-female',
  },

  async onLoad() {
    const session = await requireSession();
    if (!session) return;
    this.setData({ authorized: true, themeClass: getThemeClass(session.user.gender) });
    this.loadDraft();
  },

  onShow() {
    if (this.data.authorized) this.loadDraft();
  },

  loadDraft() {
    try {
      const draft = getConfigDraft();
      const defaults = getDefaultConfig();
      const categories =
        Array.isArray(draft.categories) && draft.categories.length ? draft.categories : defaults.categories;
      const menuItems = Array.isArray(draft.menuItems) ? draft.menuItems : defaults.menuItems;
      const normalizedDraft = { ...draft, categories, menuItems };
      setConfigDraft(normalizedDraft);
      this.setData({
        categories,
        categoryNames: categories.map((category) => category.name),
        loadError: false,
        menuItems,
      });
    } catch (error) {
      console.error('菜单管理页加载失败:', error);
      this.setData({ loadError: true });
    }
  },

  retryLoad() {
    this.loadDraft();
  },

  editItem(event) {
    const editingIndex = Number(event.currentTarget.dataset.index);
    const itemDraft = { ...this.data.menuItems[editingIndex] };
    this.setData({
      editingIndex,
      itemDraft: {
        ...itemDraft,
        categoryIndex: Math.max(
          0,
          this.data.categories.findIndex((category) => category.id === itemDraft.categoryId),
        ),
      },
    });
  },

  addItem() {
    this.setData({
      editingIndex: this.data.menuItems.length,
      itemDraft: {
        badge: '',
        categoryId: this.data.categories[0].id,
        categoryIndex: 0,
        cost: '一个抱抱',
        description: '',
        id: `custom-${Date.now()}`,
        image: this.data.menuItems[0]?.image || '',
        name: '新的小心愿',
      },
    });
  },

  updateDraft(event) {
    this.setData({
      [`itemDraft.${event.currentTarget.dataset.field}`]: event.detail.value,
    });
  },

  changeCategory(event) {
    const categoryIndex = Number(event.detail.value);
    this.setData({
      'itemDraft.categoryId': this.data.categories[categoryIndex].id,
      'itemDraft.categoryIndex': categoryIndex,
    });
  },

  previewImage() {
    if (!this.data.itemDraft.image) return;
    wx.previewImage({
      current: this.data.itemDraft.image,
      urls: [this.data.itemDraft.image],
    });
  },

  chooseLocalImage() {
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
            this.setData({ 'itemDraft.image': savedFilePath });
          },
          fail: () => {
            this.setData({ 'itemDraft.image': tempFilePath });
            wx.showToast({ title: '图片已选择，请尽快保存', icon: 'none' });
          },
        });
      },
    });
  },

  cancelEdit() {
    this.setData({ editingIndex: -1, itemDraft: null });
  },

  validateDraft() {
    const { itemDraft } = this.data;
    if (!itemDraft.name.trim() || !itemDraft.cost.trim()) {
      wx.showToast({ title: '请填写名称和交换条件', icon: 'none' });
      return false;
    }
    return true;
  },

  confirmItem() {
    if (!this.validateDraft()) return;
    const menuItems = [...this.data.menuItems];
    const { categoryIndex, ...item } = this.data.itemDraft;
    menuItems[this.data.editingIndex] = item;
    const draft = getConfigDraft();
    setConfigDraft({ ...draft, menuItems });
    this.setData({
      editingIndex: -1,
      itemDraft: null,
      menuItems,
    });
    wx.showToast({ title: '已加入草稿', icon: 'none' });
  },

  deleteItem(event) {
    const index = Number(event.currentTarget.dataset.index);
    wx.showModal({
      title: '删除这个点单项？',
      content: '它会先从草稿中移除，返回配置首页并保存后才会生效。',
      confirmColor: '#bd6875',
      success: ({ confirm }) => {
        if (!confirm) return;
        const menuItems = this.data.menuItems.filter((_, itemIndex) => itemIndex !== index);
        const draft = getConfigDraft();
        setConfigDraft({ ...draft, menuItems });
        this.setData({ menuItems });
      },
    });
  },
});
