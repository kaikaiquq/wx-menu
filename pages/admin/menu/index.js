const {
  getConfigDraft,
  getDraftScope,
  setConfigDraft,
} = require('../utils/couple-config-session');
const { requireSession } = require('../../../utils/auth');
const { getPersonalConfig, savePersonalConfig } = require('../../../utils/personal-config');
const { getStoredThemeClass, syncTheme } = require('../../../utils/theme');

Page({
  data: {
    categories: [],
    categoryNames: [],
    createAndLinkMode: false,
    authorized: false,
    editingIndex: -1,
    itemDraft: null,
    loadError: false,
    menuItems: [],
    isSharedScope: false,
    themeClass: getStoredThemeClass(),
  },

  async onLoad(options) {
    const isSharedScope = getDraftScope() === 'shared';
    const createAndLinkMode = isSharedScope && options.mode === 'createAndLink';
    const session = await requireSession({ requireCouple: isSharedScope });
    if (!session) return;
    this.setData({
      authorized: true,
      createAndLinkMode,
      isSharedScope,
      themeClass: syncTheme(session.user.gender),
    });
    this.loadDraft();
    if (createAndLinkMode) this.addItem();
  },

  onShow() {
    if (this.data.authorized) this.loadDraft();
  },

  loadDraft() {
    try {
      const draft = getConfigDraft();
      const categories =
        Array.isArray(draft.categories) && draft.categories.length
          ? draft.categories
          : [
              {
                icon: '♡',
                id: `category-${Date.now()}`,
                name: '未分类',
                subtitle: '新的小心愿',
              },
            ];
      const menuItems = Array.isArray(draft.menuItems) ? draft.menuItems : [];
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

  async confirmItem() {
    if (!this.validateDraft()) return;
    const menuItems = [...this.data.menuItems];
    const { categoryIndex, ...item } = this.data.itemDraft;
    if (this.data.createAndLinkMode && this.data.editingIndex === menuItems.length) {
      wx.showLoading({ title: '保存到个人库' });
      try {
        const personalConfig = await getPersonalConfig(true);
        const sharedCategory = this.data.categories[categoryIndex];
        const personalCategories = [...personalConfig.categories];
        let personalCategory = personalCategories.find(
          (category) => category.name === sharedCategory.name,
        );
        if (!personalCategory) {
          personalCategory = {
            ...sharedCategory,
            id: `personal-category-${Date.now()}`,
          };
          personalCategories.push(personalCategory);
        }
        const personalItems = [...personalConfig.menuItems];
        const itemId = personalItems.some((personalItem) => personalItem.id === item.id)
          ? `personal-item-${Date.now()}`
          : item.id;
        personalItems.push({
          ...item,
          categoryId: personalCategory.id,
          id: itemId,
        });
        const savedPersonal = await savePersonalConfig({
          ...personalConfig,
          categories: personalCategories,
          menuItems: personalItems,
        });
        const savedItem = savedPersonal.menuItems.find((personalItem) => personalItem.id === itemId);
        menuItems[this.data.editingIndex] = {
          ...item,
          id: itemId,
          image: savedItem?.image || item.image,
        };
        const sharedDraft = getConfigDraft();
        setConfigDraft({ ...sharedDraft, menuItems });
        wx.hideLoading();
        wx.showToast({ title: '已保存个人库并加入共同草稿', icon: 'none' });
        setTimeout(() => wx.navigateBack(), 600);
      } catch (error) {
        wx.hideLoading();
        wx.showToast({ title: error.message || '新建失败', icon: 'none' });
      }
      return;
    }
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
