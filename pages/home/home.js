const { addToCart, getCart, getOrders, updateOrder } = require('../../utils/couple-cart');
const { getFeaturedItems, getMenuConfig, saveSharedMessage } = require('../../utils/couple-config');
const { requireSession } = require('../../utils/auth');
const { getThemeClass } = require('../../utils/theme');

Page({
  data: {
    cartCount: 0,
    activeOrder: null,
    categories: [],
    dateText: '',
    featuredItems: [],
    loading: true,
    menuConfig: null,
    orderNotice: null,
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
      const [menuConfig, cart, orders] = await Promise.all([getMenuConfig(true), getCart(true), getOrders(20)]);
      const { categories, menuItems, profile } = menuConfig;
      const latestOrder = orders[0];
      const activeRecord = orders.find((order) => ['等待回应', '进行中'].includes(order.status));
      const activeOrder = activeRecord
        ? {
            ...activeRecord,
            canComplete: activeRecord.status === '进行中',
            canRespond: activeRecord.status === '等待回应' && !activeRecord.isCreatedByCurrentUser,
            dateText: this.formatOrderDate(activeRecord.createdAt),
            isMine: activeRecord.isCreatedByCurrentUser,
            title:
              activeRecord.isCreatedByCurrentUser
                ? '你发出的心愿'
                : `${activeRecord.createdByName || 'TA'} 想点这些`,
          }
        : null;
      const orderNotice = latestOrder && !['已完成', '已取消'].includes(latestOrder.status)
        ? {
            dateText: this.formatOrderDate(latestOrder.createdAt),
            itemText: latestOrder.items.map((item) => item.name).join('、'),
            title:
              latestOrder.createdByPublicUserId === session.user.publicUserId
                ? '心愿已经发给 TA'
                : `${latestOrder.createdByName || 'TA'} 发来一份点单`,
          }
        : null;
      this.setData({
        cartCount: cart.reduce((count, item) => count + item.quantity, 0),
        activeOrder,
        categories,
        dateText: `${now.getMonth() + 1}月${now.getDate()}日 · 星期${weekdays[now.getDay()]}`,
        featuredItems: getFeaturedItems(menuItems),
        loading: false,
        menuConfig,
        orderNotice,
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

  formatOrderDate(createdAt) {
    const date = new Date(createdAt);
    const hour = String(date.getHours()).padStart(2, '0');
    const minute = String(date.getMinutes()).padStart(2, '0');
    return `${date.getMonth() + 1}月${date.getDate()}日 ${hour}:${minute}`;
  },

  openOrderNotice() {
    wx.switchTab({ url: '/pages/usercenter/index' });
  },

  respondOrder() {
    wx.showModal({
      title: '回应 TA 的心愿',
      editable: true,
      placeholderText: '例如：好呀，今晚一起完成！',
      confirmText: '发送回应',
      confirmColor: '#bd6875',
      success: async ({ confirm, content }) => {
        const response = content?.trim();
        if (!confirm || !response) return;
        wx.showLoading({ title: '正在回应' });
        try {
          await updateOrder(this.data.activeOrder.id, 'respond', response);
          wx.hideLoading();
          wx.showToast({ title: '已回应 TA', icon: 'success' });
          this.onShow();
        } catch (error) {
          wx.hideLoading();
          wx.showToast({ title: error.message || '回应失败', icon: 'none' });
        }
      },
    });
  },

  completeOrder() {
    wx.showModal({
      title: '完成这个心愿？',
      content: '完成后，这份点单会收进你们的共同记录。',
      confirmText: '完成心愿',
      confirmColor: '#bd6875',
      success: async ({ confirm }) => {
        if (!confirm) return;
        wx.showLoading({ title: '正在完成' });
        try {
          await updateOrder(this.data.activeOrder.id, 'complete');
          wx.hideLoading();
          wx.showToast({ title: '心愿已完成', icon: 'success' });
          this.onShow();
        } catch (error) {
          wx.hideLoading();
          wx.showToast({ title: error.message || '操作失败', icon: 'none' });
        }
      },
    });
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
          const menuConfig = await saveSharedMessage(message, this.data.menuConfig.version);
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
