const { getMenuConfig } = require('../../utils/couple-config');
const { getOrders, getPersonalOrders } = require('../../utils/couple-cart');
const { logout, requireSession, unbindPartner } = require('../../utils/auth');
const { getThemeClass } = require('../../utils/theme');

Page({
  data: {
    coupleDays: 1,
    coupleStatus: '',
    displayMembers: [],
    latestOrder: null,
    orderCount: 0,
    profile: {},
    selfPublicUserId: '',
    themeClass: 'theme-female',
  },

  async onShow() {
    this.getTabBar().init();
    const session = await requireSession({ force: true, requireCouple: false });
    if (!session) return;
    const selfMember = {
      ...session.user,
      fallbackLabel: session.user.gender === 'male' ? '他' : '她',
    };
    const partnerPlaceholder = {
      avatarFileId: '',
      fallbackLabel: session.user.gender === 'male' ? '她' : '他',
      nickname: session.user.gender === 'male' ? '小可爱' : '大朋友',
      publicUserId: '',
    };
    if (!session.couple) {
      try {
        const orders = await getPersonalOrders();
        const latestOrder = this.formatLatestOrder(orders[0]);
        this.setData({
          coupleStatus: 'none',
          displayMembers: [selfMember, partnerPlaceholder],
          latestOrder,
          orderCount: orders.length,
          profile: {},
          selfPublicUserId: session.user.publicUserId,
          themeClass: getThemeClass(session.user.gender),
        });
      } catch (error) {
        wx.showToast({ title: error.message || '个人记录加载失败', icon: 'none' });
      }
      return;
    }
    try {
      const [{ profile }, orders] = await Promise.all([getMenuConfig(true), getOrders()]);
      const latestOrder = this.formatLatestOrder(orders[0]);
      const partnerRecord = session.couple.members.find(
        (member) => member.publicUserId !== session.user.publicUserId,
      );
      const partnerMember = partnerRecord
        ? {
            ...partnerRecord,
            fallbackLabel: partnerRecord.gender === 'male' ? '他' : '她',
          }
        : null;
      this.setData({
        coupleDays: this.getCoupleDays(profile.anniversary),
        coupleStatus: session.couple.status,
        displayMembers: [selfMember, partnerMember || partnerPlaceholder],
        latestOrder,
        orderCount: orders.length,
        profile: {
          ...profile,
          anniversaryText: profile.anniversary.split('-').join('.'),
        },
        selfPublicUserId: session.user.publicUserId,
        themeClass: getThemeClass(session.user.gender),
      });
    } catch (error) {
      wx.showToast({ title: error.message || '加载失败', icon: 'none' });
    }
  },

  formatDate(timestamp) {
    const date = new Date(timestamp);
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  },

  formatLatestOrder(order) {
    return order
      ? {
          ...order,
          dateText: this.formatDate(order.createdAt),
          itemNames: order.items.map((item) => item.name || item.nameSnapshot).join('、'),
        }
      : null;
  },

  getCoupleDays(anniversary) {
    const start = new Date(`${anniversary}T00:00:00`);
    const today = new Date();
    const difference = today.setHours(0, 0, 0, 0) - start.getTime();
    return Math.max(1, Math.floor(difference / 86400000) + 1);
  },

  goMenu() {
    if (this.data.coupleStatus === 'none') {
      this.openPersonalLibrary();
      return;
    }
    wx.switchTab({ url: '/pages/category/index' });
  },

  openAdmin() {
    wx.navigateTo({ url: '/pages/admin/index' });
  },

  openPersonalLibrary() {
    wx.navigateTo({ url: '/pages/admin/index?scope=personal' });
  },

  openInvite() {
    wx.navigateTo({ url: '/pages/auth/index?mode=invite' });
  },

  handleAvatarTap(event) {
    const publicUserId = event.currentTarget.dataset.publicId;
    if (!publicUserId) {
      this.openInvite();
      return;
    }
    if (publicUserId === this.data.selfPublicUserId) {
      wx.showActionSheet({
        itemList: ['退出当前登录'],
        success: ({ tapIndex }) => {
          if (tapIndex === 0) logout();
        },
      });
      return;
    }
    wx.showModal({
      title: '解除情侣绑定？',
      content: '解绑后，共同空间里的菜单、心愿单、留言和点单记录会全部清空且无法恢复；双方各自的个人内容库不会受到影响。',
      confirmText: '清空并解绑',
      confirmColor: '#bd6875',
      success: async ({ confirm }) => {
        if (!confirm) return;
        wx.showLoading({ title: '正在解除绑定' });
        try {
          await unbindPartner();
          wx.hideLoading();
          wx.showToast({ title: '已解除绑定', icon: 'success' });
          this.onShow();
        } catch (error) {
          wx.hideLoading();
          wx.showToast({ title: error.message || '解绑失败', icon: 'none' });
        }
      },
    });
  },

  showComingSoon() {
    wx.showToast({ title: '这个功能正在准备中', icon: 'none' });
  },
});
