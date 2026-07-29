const { addToCart, getCart } = require('../../utils/couple-cart');
const { getMenuConfig } = require('../../utils/couple-config');
const { requireSession } = require('../../utils/auth');
const { getThemeClass } = require('../../utils/theme');

Page({
  data: {
    activeCategory: '',
    activeCategoryName: '',
    cartCount: 0,
    categories: [],
    menuItems: [],
    loading: true,
    themeClass: 'theme-female',
    visibleItems: [],
  },

  async onShow() {
    this.getTabBar().init();
    const session = await requireSession({ force: true });
    if (!session) return;
    this.setData({ themeClass: getThemeClass(session.user.gender) });
    try {
      const [{ categories, menuItems }, cart] = await Promise.all([getMenuConfig(true), getCart(true)]);
      this.setData({
        cartCount: cart.reduce((count, item) => count + item.quantity, 0),
        categories,
        loading: false,
        menuItems,
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
      this.updateCartCount(cart);
      wx.showToast({ title: '已加入心愿单', icon: 'none' });
    } catch (error) {
      wx.showToast({ title: error.message || '添加失败', icon: 'none' });
      if (error.code === 'VERSION_CONFLICT') {
        const latestCart = await getCart(true);
        this.updateCartCount(latestCart);
      }
    }
  },

  async updateCartCount(existingCart) {
    const cart = existingCart || (await getCart());
    this.setData({
      cartCount: cart.reduce((count, item) => count + item.quantity, 0),
    });
  },

  openCart() {
    wx.switchTab({ url: '/pages/cart/index' });
  },

  openSharedAdmin() {
    wx.navigateTo({ url: '/pages/admin/index' });
  },
});
