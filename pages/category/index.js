const { addToCart, getCart } = require('../../utils/couple-wish');
const { getMenuConfig } = require('../../utils/couple-config');
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
    const session = await requireSession({ force: true });
    if (!session) return;
    this.setData({ themeClass: syncTheme(session.user.gender) });
    try {
      const [{ categories, menuItems }, cart] = await Promise.all([getMenuConfig(true), getCart(true)]);
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
    this.setData({
      activeCategory: selectedCategory.id,
      activeCategoryName: selectedCategory.name,
      visibleItems: this.data.menuItems.filter((item) => item.categoryId === selectedCategory.id),
    });
  },

  selectCategory(event) {
    const activeCategory = event.currentTarget.dataset.id;
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
    wx.switchTab({ url: '/pages/wish/index' });
  },

  openSharedAdmin() {
    wx.navigateTo({ url: '/pages/admin/index' });
  },
});
