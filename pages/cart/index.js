const { createOrder, getCart, updateQuantity } = require('../../utils/couple-cart');
const { requireSession } = require('../../utils/auth');
const { getThemeClass } = require('../../utils/theme');

Page({
  data: {
    cartItems: [],
    note: '',
    submitting: false,
    totalCount: 0,
    themeClass: 'theme-female',
  },

  async onShow() {
    this.getTabBar().init();
    const session = await requireSession({ force: true });
    if (session) {
      this.setData({ themeClass: getThemeClass(session.user.gender) });
      this.refreshData(true);
    }
  },

  async refreshData(force = false) {
    try {
      const cartItems = await getCart(force);
      this.setData({
        cartItems,
        totalCount: cartItems.reduce((total, item) => total + item.quantity, 0),
      });
    } catch (error) {
      wx.showToast({ title: error.message || '心愿单加载失败', icon: 'none' });
    }
  },

  async changeQuantity(event) {
    const { id, step } = event.currentTarget.dataset;
    const item = this.data.cartItems.find((cartItem) => cartItem.id === id);
    try {
      const cartItems = await updateQuantity(id, item.quantity + Number(step));
      this.setData({
        cartItems,
        totalCount: cartItems.reduce((total, cartItem) => total + cartItem.quantity, 0),
      });
    } catch (error) {
      wx.showToast({ title: error.message || '更新失败', icon: 'none' });
      this.refreshData(true);
    }
  },

  updateNote(event) {
    this.setData({ note: event.detail.value });
  },

  goMenu() {
    wx.switchTab({ url: '/pages/category/index' });
  },

  async submitOrder() {
    if (!this.data.cartItems.length || this.data.submitting) return;
    const itemCount = this.data.cartItems.length;
    this.setData({ submitting: true });
    try {
      await createOrder(this.data.note.trim());
      this.setData({ cartItems: [], note: '', submitting: false, totalCount: 0 });
      wx.showModal({
        title: '心愿已送出 ♡',
        content: `${itemCount} 个选择已经记下，等 TA 回应吧。`,
        confirmText: '好呀',
        showCancel: false,
      });
    } catch (error) {
      this.setData({ submitting: false });
      wx.showToast({ title: error.message || '提交失败', icon: 'none' });
    }
  },
});
