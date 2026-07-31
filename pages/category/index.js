const { addToCart, getCart } = require('../../utils/couple-wish');
const { getMenuConfig, hasMenuConfigCache } = require('../../utils/couple-config');
const { requireSession } = require('../../utils/auth');
const { withLetterAvatars } = require('../../utils/letter-avatar');
const { getStoredThemeClass, syncTheme } = require('../../utils/theme');

Page({
  data: {
    activeCategory: '',
    activeCategoryName: '',
    wishCount: 0,
    categories: [],
    menuItems: [],
    loading: true,
    themeClass: getStoredThemeClass(),
    visibleItems: [],
  },

  async onShow() {
    this.getTabBar().init();
    const session = await requireSession();
    if (!session) return;
    this.setData({ themeClass: syncTheme(session.user.gender) });
    try {
      // 菜单已进内存缓存且本页已渲染过：只刷新心愿数与当前栏目，不再整表 setData
      if (hasMenuConfigCache() && this._menuVersion != null) {
        const { version } = await getMenuConfig();
        if (version === this._menuVersion) {
          await this.updateWishCount();
          const activeCategory =
            wx.getStorageSync('couple.menu.activeCategory') || this.data.activeCategory;
          if (activeCategory && activeCategory !== this.data.activeCategory) {
            this.showCategory(activeCategory);
          }
          return;
        }
      }

      const [{ categories, menuItems, version }, cart] = await Promise.all([
        getMenuConfig(),
        getCart(),
      ]);
      this._menuVersion = version;
      this.setData({
        wishCount: cart.reduce((count, item) => count + item.quantity, 0),
        categories: withLetterAvatars(categories),
        loading: false,
        menuItems: withLetterAvatars(menuItems),
      });
      if (categories.length) {
        const activeCategory = wx.getStorageSync('couple.menu.activeCategory') || categories[0].id;
        this.showCategory(activeCategory);
      } else {
        this.setData({ activeCategory: '', activeCategoryName: '', visibleItems: [] });
      }
    } catch (error) {
      this.setData({ loading: false });
      wx.showToast({ title: error.message || '加载失败', icon: 'none' });
    }
  },

  showCategory(activeCategory) {
    const selectedCategory =
      this.data.categories.find((category) => category.id === activeCategory) || this.data.categories[0];
    if (!selectedCategory) {
      this.setData({ activeCategory: '', activeCategoryName: '', visibleItems: [] });
      return;
    }
    this.setData({
      activeCategory: selectedCategory.id,
      activeCategoryName: selectedCategory.name,
      visibleItems: this.data.menuItems.filter((item) => item.categoryId === selectedCategory.id),
    });
  },

  selectCategory(event) {
    const activeCategory = event.currentTarget.dataset.id;
    if (activeCategory === this.data.activeCategory) return;
    wx.setStorageSync('couple.menu.activeCategory', activeCategory);
    this.showCategory(activeCategory);
  },

  async addItem(event) {
    const item = this.data.menuItems.find((menuItem) => menuItem.id === event.currentTarget.dataset.id);
    try {
      const cart = await addToCart(item);
      this.updateWishCount(cart);
      wx.showToast({ title: '已加入心愿单', icon: 'none' });
    } catch (error) {
      wx.showToast({ title: error.message || '添加失败', icon: 'none' });
      if (error.code === 'VERSION_CONFLICT') {
        const latestCart = await getCart(true);
        this.updateWishCount(latestCart);
      }
    }
  },

  async updateWishCount(existingCart) {
    const cart = existingCart || (await getCart());
    this.setData({
      wishCount: cart.reduce((count, item) => count + item.quantity, 0),
    });
  },

  openWish() {
    wx.navigateTo({ url: '/pages/wish/index' });
  },

  openSharedAdmin() {
    wx.navigateTo({ url: '/pages/admin/index' });
  },
});
