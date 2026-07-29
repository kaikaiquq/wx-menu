const {
  bootstrap,
  createInvite,
  getActiveInvite,
  isLoggedOut,
  joinCouple,
  login,
  updateProfile,
} = require('../../utils/auth');
const { resolveCloudFileUrl } = require('../../utils/cloud');
const { getStoredThemeClass, syncTheme } = require('../../utils/theme');

const getToday = () => {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
};

Page({
  data: {
    anniversary: getToday(),
    avatarFileId: '',
    avatarUrl: '',
    cloudError: '',
    gender: '',
    incomingCode: '',
    inviteCode: '',
    loggedOut: false,
    loading: true,
    maxDate: getToday(),
    nickname: '',
    saving: false,
    session: null,
    themeClass: getStoredThemeClass(),
  },

  onLoad(options) {
    if (options.invite) {
      this.setData({
        incomingCode: String(options.invite).toUpperCase().replace(/\s/g, ''),
      });
    }
    if (isLoggedOut()) {
      this.setData({ loading: false, loggedOut: true });
    } else {
      this.loadSession();
    }
  },

  onShareAppMessage() {
    return {
      imageUrl: '/assets/share-cover.jpg',
      path: `/pages/auth/index?mode=join&invite=${this.data.inviteCode}`,
      title: '邀请你加入我们的两人菜单',
    };
  },

  async applyUserAvatar(session) {
    const avatarFileId = session.user.avatarFileId || '';
    const avatarUrl = avatarFileId.startsWith('cloud://')
      ? (await resolveCloudFileUrl(avatarFileId)) || ''
      : avatarFileId;
    this.setData({
      avatarFileId,
      avatarUrl,
      loading: false,
      nickname: session.user.nickname || '',
      session,
      gender: session.user.gender || '',
      themeClass: syncTheme(session.user.gender),
    });
  },

  async loadSession() {
    this.setData({ cloudError: '', loading: true });
    try {
      const session = await bootstrap(true);
      await this.applyUserAvatar(session);
      if (session.user.profileCompleted && session.couple?.status === 'pending' && !this.data.incomingCode) {
        await this.loadActiveInvite();
      }
      if (session.user.profileCompleted && session.couple?.status === 'active' && !this.data.incomingCode) {
        setTimeout(() => wx.switchTab({ url: '/pages/home/home' }), 300);
      }
    } catch (error) {
      this.setData({
        cloudError: error.message || '请先按文档开通并部署微信云开发',
        loading: false,
      });
    }
  },

  async startLogin() {
    this.setData({ cloudError: '', loading: true, loggedOut: false });
    try {
      const session = await login();
      await this.applyUserAvatar(session);
      if (session.user.profileCompleted && session.couple?.status === 'pending' && !this.data.incomingCode) {
        await this.loadActiveInvite();
      }
      if (session.user.profileCompleted && session.couple && !this.data.incomingCode) {
        setTimeout(() => wx.switchTab({ url: '/pages/home/home' }), 300);
      }
    } catch (error) {
      this.setData({
        cloudError: error.message || '微信登录失败',
        loading: false,
      });
    }
  },

  chooseAvatar(event) {
    this.setData({ avatarFileId: '', avatarUrl: event.detail.avatarUrl });
  },

  updateNickname(event) {
    this.setData({ nickname: event.detail.value });
  },

  selectGender(event) {
    const gender = event.currentTarget.dataset.gender;
    this.setData({ gender, themeClass: syncTheme(gender) });
  },

  updateIncomingCode(event) {
    this.setData({ incomingCode: event.detail.value.toUpperCase().replace(/\s/g, '') });
  },

  changeAnniversary(event) {
    this.setData({ anniversary: event.detail.value });
  },

  async saveProfile() {
    const nickname = this.data.nickname.trim();
    if (!nickname) {
      wx.showToast({ title: '请填写昵称', icon: 'none' });
      return;
    }
    if (!this.data.gender) {
      wx.showToast({ title: '请选择性别', icon: 'none' });
      return;
    }
    this.setData({ saving: true });
    try {
      let avatarFileId = this.data.avatarUrl;
      if (avatarFileId.startsWith('https://')) {
        avatarFileId = this.data.avatarFileId;
      } else if (avatarFileId && !avatarFileId.startsWith('cloud://')) {
        const extension = avatarFileId.split('.').pop().split('?')[0] || 'jpg';
        const { fileID } = await wx.cloud.uploadFile({
          cloudPath: `users/avatars/${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`,
          filePath: avatarFileId,
        });
        avatarFileId = fileID;
      } else if (!avatarFileId) {
        avatarFileId = this.data.avatarFileId;
      }
      const session = await updateProfile({ avatarFileId, gender: this.data.gender, nickname });
      await this.applyUserAvatar(session);
      this.setData({ saving: false });
    } catch (error) {
      this.setData({ saving: false });
      wx.showToast({ title: error.message || '保存失败', icon: 'none' });
    }
  },

  async createSpace() {
    const isFirstCreation = !this.data.session?.couple;
    this.setData({ saving: true });
    try {
      const { code } = await createInvite();
      const session = await bootstrap(true);
      this.setData({ inviteCode: code, saving: false, session });
      wx.showToast({ title: '情侣空间已创建', icon: 'success' });
      if (isFirstCreation) {
        setTimeout(() => wx.switchTab({ url: '/pages/home/home' }), 500);
      }
    } catch (error) {
      this.setData({ saving: false });
      wx.showToast({ title: error.message || '创建失败', icon: 'none' });
    }
  },

  async joinSpace() {
    if (this.data.incomingCode.length !== 8) {
      wx.showToast({ title: '请输入 8 位邀请码', icon: 'none' });
      return;
    }
    this.setData({ saving: true });
    try {
      await joinCouple(this.data.incomingCode, this.data.anniversary);
      this.setData({ saving: false });
      wx.showToast({ title: '共同空间已创建', icon: 'success' });
      setTimeout(() => wx.switchTab({ url: '/pages/home/home' }), 500);
    } catch (error) {
      this.setData({ saving: false });
      wx.showToast({ title: error.message || '绑定失败', icon: 'none' });
    }
  },

  copyInvite() {
    wx.setClipboardData({ data: this.data.inviteCode });
  },

  async loadActiveInvite() {
    try {
      const { code } = await getActiveInvite();
      if (code && !this.data.incomingCode) this.setData({ inviteCode: code });
    } catch (error) {
      wx.showToast({ title: error.message || '邀请码加载失败', icon: 'none' });
    }
  },

  returnHome() {
    wx.switchTab({ url: '/pages/home/home' });
  },

  openPersonalLibrary() {
    wx.navigateTo({ url: '/pages/admin/index?scope=personal' });
  },
});
