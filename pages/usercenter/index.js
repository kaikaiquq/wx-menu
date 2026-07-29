const { getMenuConfig, saveSharedAnniversary } = require('../../utils/couple-config');
const { getOrders, getPersonalOrders } = require('../../utils/couple-wish');
const { getSession, logout, requireSession, unbindPartner, updateProfile } = require('../../utils/auth');
const { resolveCloudFileUrls } = require('../../utils/cloud');
const { getStoredThemeClass, syncTheme } = require('../../utils/theme');

const getToday = () => {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
};

Page({
  data: {
    coupleDays: 1,
    coupleStatus: '',
    displayMembers: [],
    editAvatarUrl: '',
    editNickname: '',
    latestOrder: null,
    maxDate: getToday(),
    orderCount: 0,
    profile: {},
    profileVersion: 0,
    savingProfile: false,
    selfGender: '',
    selfPublicUserId: '',
    showProfileEditor: false,
    themeClass: getStoredThemeClass(),
  },

  async withDisplayAvatars(members) {
    const urlMap = await resolveCloudFileUrls(members.map((member) => member.avatarFileId));
    return members.map((member) => ({
      ...member,
      avatarUrl: urlMap[member.avatarFileId] || '',
    }));
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
        const displayMembers = await this.withDisplayAvatars([selfMember, partnerPlaceholder]);
        this.setData({
          coupleStatus: 'none',
          displayMembers,
          latestOrder,
          orderCount: orders.length,
          profile: {},
          profileVersion: 0,
          selfGender: session.user.gender || '',
          selfPublicUserId: session.user.publicUserId,
          themeClass: syncTheme(session.user.gender),
        });
      } catch (error) {
        wx.showToast({ title: error.message || '个人记录加载失败', icon: 'none' });
      }
      return;
    }
    try {
      const [{ profile, version }, orders] = await Promise.all([getMenuConfig(true), getOrders()]);
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
      const displayMembers = await this.withDisplayAvatars([
        selfMember,
        partnerMember || partnerPlaceholder,
      ]);
      this.setData({
        coupleDays: this.getCoupleDays(profile.anniversary),
        coupleStatus: session.couple.status,
        displayMembers,
        latestOrder,
        maxDate: getToday(),
        orderCount: orders.length,
        profile: {
          ...profile,
          anniversaryText: profile.anniversary ? profile.anniversary.split('-').join('.') : '',
        },
        profileVersion: version,
        selfGender: session.user.gender || '',
        selfPublicUserId: session.user.publicUserId,
        themeClass: syncTheme(session.user.gender),
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
    if (!anniversary) return 1;
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
      this.openProfileEditor();
      return;
    }
    this.confirmUnbind();
  },

  openProfileEditor() {
    const self = this.data.displayMembers[0] || {};
    this.setData({
      editAvatarUrl: self.avatarUrl || '',
      editNickname: self.nickname || '',
      showProfileEditor: true,
    });
  },

  closeProfileEditor() {
    if (this.data.savingProfile) return;
    this.setData({ showProfileEditor: false });
  },

  logoutAccount() {
    if (this.data.savingProfile) return;
    wx.showModal({
      title: '退出登录？',
      content: '退出后需要重新用微信登录才能进入空间。',
      confirmText: '退出登录',
      confirmColor: '#bd6875',
      success: ({ confirm }) => {
        if (confirm) logout();
      },
    });
  },

  onChooseAvatar(event) {
    this.setData({ editAvatarUrl: event.detail.avatarUrl });
  },

  updateEditNickname(event) {
    this.setData({ editNickname: event.detail.value });
  },

  async saveSelfProfile() {
    const nickname = (this.data.editNickname || '').trim();
    if (!nickname) {
      wx.showToast({ title: '请填写昵称', icon: 'none' });
      return;
    }
    if (nickname.length > 20) {
      wx.showToast({ title: '昵称最多 20 个字符', icon: 'none' });
      return;
    }
    const gender = this.data.selfGender || getSession()?.user?.gender;
    if (!gender) {
      wx.showToast({ title: '请先完善性别信息', icon: 'none' });
      return;
    }
    this.setData({ savingProfile: true });
    try {
      const originalCloudId = this.data.displayMembers[0]?.avatarFileId || '';
      let avatarFileId = this.data.editAvatarUrl || originalCloudId;
      if (avatarFileId.startsWith('https://')) {
        // 展示用的临时链接不能入库，继续沿用原 cloud 文件
        avatarFileId = originalCloudId;
      } else if (avatarFileId && !avatarFileId.startsWith('cloud://')) {
        const extension = avatarFileId.split('.').pop().split('?')[0] || 'jpg';
        const { fileID } = await wx.cloud.uploadFile({
          cloudPath: `users/avatars/${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`,
          filePath: avatarFileId,
        });
        avatarFileId = fileID;
      }
      await updateProfile({ avatarFileId, gender, nickname });
      this.setData({ savingProfile: false, showProfileEditor: false });
      wx.showToast({ title: '资料已更新', icon: 'success' });
      this.onShow();
    } catch (error) {
      this.setData({ savingProfile: false });
      wx.showToast({ title: error.message || '保存失败', icon: 'none' });
    }
  },

  confirmUnbind() {
    if (this.data.coupleStatus !== 'active') {
      this.openInvite();
      return;
    }
    wx.showActionSheet({
      itemList: ['解除情侣绑定'],
      success: ({ tapIndex }) => {
        if (tapIndex !== 0) return;
        wx.showModal({
          title: '解除情侣绑定？',
          content:
            '解绑后，共同空间里的菜单、心愿单、留言和点单记录会全部清空且无法恢复；双方各自的个人内容库不会受到影响。',
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
    });
  },

  async changeAnniversary(event) {
    const anniversary = event.detail.value;
    if (!anniversary || anniversary === this.data.profile.anniversary) return;
    wx.showLoading({ title: '保存中' });
    try {
      const saved = await saveSharedAnniversary(anniversary, this.data.profileVersion);
      this.setData({
        coupleDays: this.getCoupleDays(saved.profile.anniversary),
        profile: {
          ...saved.profile,
          anniversaryText: saved.profile.anniversary.split('-').join('.'),
        },
        profileVersion: saved.version,
      });
      wx.hideLoading();
      wx.showToast({ title: '纪念日已更新', icon: 'success' });
    } catch (error) {
      wx.hideLoading();
      wx.showToast({ title: error.message || '保存失败', icon: 'none' });
    }
  },

  showComingSoon() {
    wx.showToast({ title: '这个功能正在准备中', icon: 'none' });
  },

  noop() {},
});
