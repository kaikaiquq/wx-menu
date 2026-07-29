const { getConfigDraft, setConfigDraft } = require('../../../utils/couple-config-session');
const { requireSession } = require('../../../utils/auth');
const { getThemeClass } = require('../../../utils/theme');

Page({
  data: {
    categories: [],
    menuItems: [],
    themeClass: 'theme-female',
  },

  async onLoad() {
    const session = await requireSession();
    if (!session) return;
    const draft = getConfigDraft();
    this.setData({
      categories: draft.categories,
      menuItems: draft.menuItems,
      themeClass: getThemeClass(session.user.gender),
    });
  },

  saveDraft(categories, menuItems = this.data.menuItems) {
    const draft = getConfigDraft();
    setConfigDraft({ ...draft, categories, menuItems });
    this.setData({ categories, menuItems });
  },

  addCategory() {
    wx.showModal({
      title: '新增分类',
      editable: true,
      placeholderText: '例如：周末约会',
      confirmColor: '#bd6875',
      success: ({ confirm, content }) => {
        const name = content?.trim();
        if (!confirm || !name) return;
        if (this.data.categories.some((category) => category.name === name)) {
          wx.showToast({ title: '已经有同名分类', icon: 'none' });
          return;
        }
        this.saveDraft([
          ...this.data.categories,
          {
            icon: '✨',
            id: `category-${Date.now()}`,
            name,
            subtitle: '自定义分类',
          },
        ]);
        wx.showToast({ title: '已加入草稿', icon: 'none' });
      },
    });
  },

  editCategory(event) {
    const index = Number(event.currentTarget.dataset.index);
    const currentCategory = this.data.categories[index];
    wx.showModal({
      title: '修改分类名称',
      content: currentCategory.name,
      editable: true,
      placeholderText: '输入分类名称',
      confirmColor: '#bd6875',
      success: ({ confirm, content }) => {
        const name = content?.trim();
        if (!confirm || !name) return;
        const categories = this.data.categories.map((category, categoryIndex) =>
          categoryIndex === index ? { ...category, name } : category,
        );
        this.saveDraft(categories);
      },
    });
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
});
