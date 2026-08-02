const { getMenuConfig, saveSharedAnniversary } = require('../../utils/couple-config');
const { getOrders, getPersonalOrders } = require('../../utils/couple-wish');
const { getSession, logout, requireSession, unbindPartner, updateProfile } = require('../../utils/auth');
const { resolveCloudFileUrls, uploadFileToCloud } = require('../../utils/cloud');
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
    historyOrders: [],
    latestOrder: null,
    maxDate: getToday(),
    orderCount: 0,
    profile: {},
    profileVersion: 0,
    savingProfile: false,
    selfGender: '',
    selfPublicUserId: '',
    detailOrder: null,
    showHistorySheet: false,
    showProfileEditor: false,
    showWishDetail: false,
    themeClass: getStoredThemeClass(),
  },

  async withDisplayAvatars(members) {
    // 优先用云函数下发的 avatarUrl（可看对方上传的文件）；缺的再尝试客户端换链
    const needResolve = members
      .filter((member) => !member.avatarUrl && String(member.avatarFileId || '').startsWith('cloud://'))
      .map((member) => member.avatarFileId);
    const urlMap = needResolve.length ? await resolveCloudFileUrls(needResolve) : {};
    return members.map((member) => ({
      ...member,
      avatarUrl: member.avatarUrl || urlMap[member.avatarFileId] || '',
    }));
  },

  buildMembers(session) {
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
      return { partnerPlaceholder, selfMember, members: [selfMember, partnerPlaceholder] };
    }
    const partnerRecord = session.couple.members.find(
      (member) => member.publicUserId !== session.user.publicUserId,
    );
    const partnerMember = partnerRecord
      ? {
          ...partnerRecord,
          fallbackLabel: partnerRecord.gender === 'male' ? '他' : '她',
        }
      : null;
    return {
      partnerPlaceholder,
      selfMember,
      members: [selfMember, partnerMember || partnerPlaceholder],
    };
  },

  async onShow() {
    this.getTabBar().init();
    let session = await requireSession({ requireCouple: false });
    if (!session) return;

    // 旧会话缺对方 avatarUrl 时强制刷新一次（部署 authApi 后生效）
    const partner = session.couple?.members?.find(
      (member) => member.publicUserId !== session.user.publicUserId,
    );
    if (partner?.avatarFileId && !partner.avatarUrl) {
      session = await requireSession({ force: true, requireCouple: false });
      if (!session) return;
    }

    const { members } = this.buildMembers(session);
    this.setData({
      coupleStatus: session.couple ? session.couple.status : 'none',
      selfGender: session.user.gender || '',
      selfPublicUserId: session.user.publicUserId,
      themeClass: syncTheme(session.user.gender),
    });

    try {
      if (!session.couple) {
        const [displayMembers, orders] = await Promise.all([
          this.withDisplayAvatars(members),
          getPersonalOrders(50),
        ]);
        const historyOrders = orders.map((order) => this.formatHistoryOrder(order));
        this.setData({
          displayMembers,
          historyOrders,
          latestOrder: this.pickFeaturedOrder(historyOrders),
          orderCount: orders.length,
          profile: {},
          profileVersion: 0,
        });
        return;
      }

      const [displayMembers, menuConfig, orders] = await Promise.all([
        this.withDisplayAvatars(members),
        getMenuConfig(),
        getOrders(50),
      ]);
      const { profile, version } = menuConfig;
      const historyOrders = orders.map((order) => this.formatHistoryOrder(order));
      this.setData({
        coupleDays: this.getCoupleDays(profile.anniversary),
        displayMembers,
        historyOrders,
        latestOrder: this.pickFeaturedOrder(historyOrders),
        maxDate: getToday(),
        orderCount: orders.length,
        profile: {
          ...profile,
          anniversaryText: profile.anniversary ? profile.anniversary.split('-').join('.') : '',
        },
        profileVersion: version,
      });
    } catch (error) {
      wx.showToast({ title: error.message || '加载失败', icon: 'none' });
    }
  },

  formatDate(timestamp) {
    const date = new Date(timestamp);
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  },

  formatHistoryOrder(order) {
    if (!order) return null;
    return {
      ...order,
      dateText: this.formatDate(order.createdAt),
      itemNames: (order.items || []).map((item) => item.name || item.nameSnapshot).join('、'),
      responseText: order.response
        ? `${order.respondedByName || 'TA'}：${order.response}`
        : '',
    };
  },

  /** 优先展示进行中的当前心愿，否则展示最近一条 */
  pickFeaturedOrder(historyOrders = []) {
    return (
      historyOrders.find((order) => ['等待回应', '进行中'].includes(order.status)) ||
      historyOrders[0] ||
      null
    );
  },

  openHistorySheet() {
    if (!this.data.historyOrders.length) return;
    this.setData({ showHistorySheet: true, showWishDetail: false, detailOrder: null });
  },

  closeHistorySheet() {
    this.setData({ showHistorySheet: false });
  },

  openWishDetail(event) {
    const id = event.currentTarget.dataset.id || this.data.latestOrder?.id;
    const detailOrder =
      this.data.historyOrders.find((order) => order.id === id) || this.data.latestOrder;
    if (!detailOrder) return;
    this._detailFromHistory = this.data.showHistorySheet;
    this.setData({
      detailOrder,
      showWishDetail: true,
      showHistorySheet: false,
    });
  },

  closeWishDetail() {
    const reopenHistory = this._detailFromHistory && this.data.historyOrders.length;
    this._detailFromHistory = false;
    this.setData({
      showWishDetail: false,
      detailOrder: null,
      showHistorySheet: Boolean(reopenHistory),
    });
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
        avatarFileId = await uploadFileToCloud(
          avatarFileId,
          `users/avatars/${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`,
        );
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

  copyPublicId() {
    const id = this.data.selfPublicUserId;
    if (!id) return;
    wx.setClipboardData({
      data: id,
      success: () => wx.showToast({ title: '已复制用户 ID', icon: 'none' }),
    });
  },

  showComingSoon() {
    wx.showToast({ title: '这个功能正在准备中', icon: 'none' });
  },

  noop() {},
});
