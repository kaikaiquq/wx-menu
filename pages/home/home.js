const { addToCart, getCart } = require('../../utils/couple-cart');
const { getFeaturedItems, getMenuConfig, saveMenuConfig } = require('../../utils/couple-config');
const { requireSession } = require('../../utils/auth');
const { getThemeClass } = require('../../utils/theme');

Page({
  data: {
    cartCount: 0,
    categories: [],
    dateText: '',
    featuredItems: [],
    loading: true,
    menuConfig: null,
    sharedMessage: '',
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
      const [menuConfig, cart] = await Promise.all([getMenuConfig(true), getCart(true)]);
      const { categories, menuItems, profile } = menuConfig;
      this.setData({
        cartCount: cart.reduce((count, item) => count + item.quantity, 0),
        categories,
        dateText: `${now.getMonth() + 1}月${now.getDate()}日 · 星期${weekdays[now.getDay()]}`,
        featuredItems: getFeaturedItems(menuItems),
        loading: false,
        menuConfig,
        sharedMessage: profile.message || '点击写下一句想记住的话',
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

  editSharedMessage() {
    wx.showModal({
      title: '要记住 TA 说的话',
      content: this.data.sharedMessage,
      editable: true,
      placeholderText: '写下一句想让彼此记住的话',
      confirmText: '保存留言',
      confirmColor: '#bd6875',
      success: async ({ confirm, content }) => {
        const message = content?.trim();
        if (!confirm || !message) return;
        wx.showLoading({ title: '正在保存留言' });
        try {
          const menuConfig = await saveMenuConfig({
            ...this.data.menuConfig,
            profile: {
              ...this.data.menuConfig.profile,
              message,
            },
          });
          this.setData({ menuConfig, sharedMessage: message });
          wx.hideLoading();
          wx.showToast({ title: '留言已同步', icon: 'success' });
        } catch (error) {
          wx.hideLoading();
          wx.showToast({ title: error.message || '保存失败', icon: 'none' });
          if (error.code === 'VERSION_CONFLICT') this.onShow();
        }
      },
    });
  },
});
