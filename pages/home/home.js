const { addToCart, getCart } = require('../../utils/couple-cart');
const { getFeaturedItems, getMenuConfig } = require('../../utils/couple-config');
const { requireSession } = require('../../utils/auth');
const { getThemeClass } = require('../../utils/theme');

Page({
  data: {
    cartCount: 0,
    categories: [],
    dateText: '',
    featuredItems: [],
    loading: true,
    themeClass: 'theme-female',
  },

  async onShow() {
    this.getTabBar().init();
    const session = await requireSession({ force: true });
    if (!session) return;
    this.setData({ themeClass: getThemeClass(session.user.gender) });
    const now = new Date();
    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    try {
      const [{ categories, menuItems }, cart] = await Promise.all([getMenuConfig(true), getCart(true)]);
      this.setData({
        cartCount: cart.reduce((count, item) => count + item.quantity, 0),
        categories,
        dateText: `${now.getMonth() + 1}月${now.getDate()}日 · 星期${weekdays[now.getDay()]}`,
        featuredItems: getFeaturedItems(menuItems),
        loading: false,
      });
    } catch (error) {
      this.setData({ loading: false });
      wx.showToast({ title: error.message || '加载失败', icon: 'none' });
    }
  },

  chooseCategory(event) {
    wx.setStorageSync('couple.menu.activeCategory', event.currentTarget.dataset.id);
    wx.switchTab({ url: '/pages/category/index' });
  },

  async addItem(event) {
    const item = this.data.featuredItems.find((menuItem) => menuItem.id === event.currentTarget.dataset.id);
    try {
      const cart = await addToCart(item);
      this.setData({
        cartCount: cart.reduce((count, cartItem) => count + cartItem.quantity, 0),
      });
      wx.showToast({ title: '已加入心愿单', icon: 'none' });
    } catch (error) {
      wx.showToast({ title: error.message || '添加失败', icon: 'none' });
      if (error.code === 'VERSION_CONFLICT') {
        const cart = await getCart(true);
        this.setData({ cartCount: cart.reduce((count, cartItem) => count + cartItem.quantity, 0) });
      }
    }
  },

  openCart() {
    wx.switchTab({ url: '/pages/cart/index' });
  },
});
