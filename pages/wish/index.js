const { createOrder, getCart, updateQuantity } = require('../../utils/couple-wish');
const { requireSession } = require('../../utils/auth');
const { getStoredThemeClass, syncTheme } = require('../../utils/theme');

Page({
  data: {
    wishItems: [],
    note: '',
    submitting: false,
    totalCount: 0,
    themeClass: getStoredThemeClass(),
  },

  async onShow() {
    this.getTabBar().init();
    const session = await requireSession({ force: true });
    if (session) {
      this.setData({ themeClass: syncTheme(session.user.gender) });
      this.refreshData(true);
    }
  },

  async refreshData(force = false) {
    try {
      const wishItems = await getCart(force);
      this.setData({
        wishItems,
        totalCount: wishItems.reduce((total, item) => total + item.quantity, 0),
      });
    } catch (error) {
      wx.showToast({ title: error.message || '心愿单加载失败', icon: 'none' });
    }
  },

  async changeQuantity(event) {
    const { id, step } = event.currentTarget.dataset;
    const item = this.data.wishItems.find((wishItem) => wishItem.id === id);
    try {
      const wishItems = await updateQuantity(id, item.quantity + Number(step));
      this.setData({
        wishItems,
        totalCount: wishItems.reduce((total, wishItem) => total + wishItem.quantity, 0),
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
    if (!this.data.wishItems.length || this.data.submitting) return;
    const itemCount = this.data.wishItems.length;
    this.setData({ submitting: true });
    try {
      await createOrder(this.data.note.trim());
      this.setData({ wishItems: [], note: '', submitting: false, totalCount: 0 });
      wx.showModal({
        title: '心愿已送出 ♡',
        content: `${itemCount} 个选择已经记下，等 TA 回应吧。`,
        confirmText: '好呀',
        showCancel: false,
        success: ({ confirm }) => {
          if (confirm) wx.switchTab({ url: '/pages/home/home' });
        },
      });
    } catch (error) {
      this.setData({ submitting: false });
      wx.showToast({ title: error.message || '提交失败', icon: 'none' });
    }
  },
});
