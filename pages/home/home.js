const { addToCart, getCart, getOrders, updateOrder } = require('../../utils/couple-wish');
const { getFeaturedItems, getMenuConfig, saveSharedMessage } = require('../../utils/couple-config');
const { requireSession } = require('../../utils/auth');
const { withLetterAvatars } = require('../../utils/letter-avatar');
const { getStoredThemeClass, syncTheme } = require('../../utils/theme');

Page({
  data: {
    wishCount: 0,
    activeOrder: null,
    categories: [],
    dateText: '',
    featuredItems: [],
    loading: true,
    menuConfig: null,
    orderNotice: null,
    responseAlert: null,
    sharedMessage: '',
    showResponseSheet: false,
    showWishAlert: false,
    themeClass: getStoredThemeClass(),
  },

  async onShow() {
    this.getTabBar().init();
    const session = await requireSession();
    if (!session) return;
    this.setData({ themeClass: syncTheme(session.user.gender) });
    const now = new Date();
    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    try {
      const [menuConfig, wishList, orders] = await Promise.all([getMenuConfig(), getCart(), getOrders(20)]);
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
            items: withLetterAvatars(activeRecord.items || []),
            title:
              activeRecord.isCreatedByCurrentUser
                ? '你发出的心愿'
                : `${activeRecord.createdByName || 'TA'} 想点这些`,
          }
        : null;
      const orderNotice = latestOrder && !['已完成', '已取消', '已拒绝'].includes(latestOrder.status)
        ? {
            dateText: this.formatOrderDate(latestOrder.createdAt),
            itemText: latestOrder.items.map((item) => item.name).join('、'),
            title:
              latestOrder.createdByPublicUserId === session.user.publicUserId
                ? '心愿已经发给 TA'
                : `${latestOrder.createdByName || 'TA'} 发来一份点单`,
          }
        : null;
      const unread = orders.find((order) => order.hasUnreadResponse);
      const responseAlert = unread
        ? {
            id: unread.id,
            dateText: this.formatOrderDate(unread.respondedAt || unread.createdAt),
            itemText: (unread.items || []).map((item) => item.name).join('、'),
            response: unread.response || '',
            respondedByName: unread.respondedByName || 'TA',
            status: unread.status,
            title:
              unread.status === '已拒绝'
                ? `${unread.respondedByName || 'TA'} 拒绝了你的心愿`
                : `${unread.respondedByName || 'TA'} 答应了你的心愿`,
          }
        : null;
      this.setData({
        wishCount: wishList.reduce((count, item) => count + item.quantity, 0),
        activeOrder,
        categories: withLetterAvatars(categories),
        dateText: `${now.getMonth() + 1}月${now.getDate()}日 · 星期${weekdays[now.getDay()]}`,
        featuredItems: withLetterAvatars(getFeaturedItems(menuItems)),
        loading: false,
        menuConfig,
        orderNotice,
        responseAlert,
        showWishAlert: Boolean(responseAlert),
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
      const wishList = await addToCart(item);
      this.setData({
        wishCount: wishList.reduce((count, item) => count + item.quantity, 0),
      });
      wx.showToast({ title: '已加入心愿单', icon: 'none' });
    } catch (error) {
      wx.showToast({ title: error.message || '添加失败', icon: 'none' });
      if (error.code === 'VERSION_CONFLICT') {
        const wishList = await getCart(true);
        this.setData({ wishCount: wishList.reduce((count, item) => count + item.quantity, 0) });
      }
    }
  },

  openWish() {
    wx.navigateTo({ url: '/pages/wish/index' });
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

  openResponseAlert() {
    if (!this.data.responseAlert) return;
    this.setData({ showResponseSheet: true, showWishAlert: false });
    this.ackResponseAlert();
  },

  closeResponseSheet() {
    this.setData({ showResponseSheet: false });
  },

  async ackResponseAlert() {
    const alert = this.data.responseAlert;
    if (!alert?.id) return;
    try {
      await updateOrder(alert.id, 'ackResponse');
    } catch (error) {
      // 已读失败不打断查看
    }
  },

  acceptOrder() {
    wx.showModal({
      title: '答应这个心愿？',
      editable: true,
      placeholderText: '例如：好呀，今晚一起完成！',
      confirmText: '答应',
      confirmColor: '#bd6875',
      success: async ({ confirm, content }) => {
        if (!confirm) return;
        const response = content?.trim() || '好呀 ♡';
        wx.showLoading({ title: '正在答应' });
        try {
          await updateOrder(this.data.activeOrder.id, 'respond', response);
          wx.hideLoading();
          wx.showToast({ title: '已答应 TA', icon: 'success' });
          this.onShow();
        } catch (error) {
          wx.hideLoading();
          wx.showToast({ title: error.message || '操作失败', icon: 'none' });
        }
      },
    });
  },

  rejectOrder() {
    wx.showModal({
      title: '拒绝这个心愿？',
      editable: true,
      placeholderText: '可以说说原因，也可以直接拒绝',
      confirmText: '拒绝',
      confirmColor: '#bd6875',
      success: async ({ confirm, content }) => {
        if (!confirm) return;
        const response = content?.trim() || '这次先不了～';
        wx.showLoading({ title: '正在拒绝' });
        try {
          await updateOrder(this.data.activeOrder.id, 'reject', response);
          wx.hideLoading();
          wx.showToast({ title: '已拒绝', icon: 'none' });
          this.onShow();
        } catch (error) {
          wx.hideLoading();
          wx.showToast({ title: error.message || '操作失败', icon: 'none' });
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

  noop() {},
});
