const {
  bootstrap,
  createInvite,
  isLoggedOut,
  joinCouple,
  login,
  updateProfile,
} = require('../../utils/auth');
const { getDefaultConfig } = require('../../utils/couple-config');
const { getStoredThemeClass, getThemeClass } = require('../../utils/theme');
const LAST_INVITE_KEY = 'couple.menu.lastInvite';

const getToday = () => {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
};

Page({
  data: {
    anniversary: getToday(),
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
    const lastInvite = wx.getStorageSync(LAST_INVITE_KEY);
    if (lastInvite?.code && Number(lastInvite.expiresAt) > Date.now()) {
      this.setData({ inviteCode: lastInvite.code });
    }
    if (isLoggedOut()) {
      this.setData({ loading: false, loggedOut: true });
    } else {
      this.loadSession();
    }
  },

  onShareAppMessage() {
    return {
      imageUrl: '/couple-menu-avatar.svg.png',
      path: `/pages/auth/index?invite=${this.data.inviteCode}`,
      title: '邀请你加入我们的两人菜单',
    };
  },

  async loadSession() {
    this.setData({ cloudError: '', loading: true });
    try {
      const session = await bootstrap(true);
      this.setData({
        avatarUrl: session.user.avatarFileId || '',
        loading: false,
        nickname: session.user.nickname || '',
        session,
        gender: session.user.gender || '',
        themeClass: getThemeClass(session.user.gender),
      });
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
      this.setData({
        avatarUrl: session.user.avatarFileId || '',
        loading: false,
        nickname: session.user.nickname || '',
        session,
        gender: session.user.gender || '',
        themeClass: getThemeClass(session.user.gender),
      });
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
    this.setData({ avatarUrl: event.detail.avatarUrl });
  },

  updateNickname(event) {
    this.setData({ nickname: event.detail.value });
  },

  selectGender(event) {
    const gender = event.currentTarget.dataset.gender;
    this.setData({ gender, themeClass: getThemeClass(gender) });
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
      if (avatarFileId && !avatarFileId.startsWith('cloud://')) {
        const extension = avatarFileId.split('.').pop().split('?')[0] || 'jpg';
        const { fileID } = await wx.cloud.uploadFile({
          cloudPath: `users/avatars/${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`,
          filePath: avatarFileId,
        });
        avatarFileId = fileID;
      }
      const session = await updateProfile({ avatarFileId, gender: this.data.gender, nickname });
      this.setData({ avatarUrl: avatarFileId, saving: false, session });
    } catch (error) {
      this.setData({ saving: false });
      wx.showToast({ title: error.message || '保存失败', icon: 'none' });
    }
  },

  async createSpace() {
    const isFirstCreation = !this.data.session?.couple;
    this.setData({ saving: true });
    try {
      const initialConfig = wx.getStorageSync('couple.menu.config') || getDefaultConfig();
      const { code, expiresAt } = await createInvite(initialConfig);
      const session = await bootstrap(true);
      this.setData({ inviteCode: code, saving: false, session });
      wx.setStorageSync(LAST_INVITE_KEY, { code, expiresAt });
      wx.showToast({ title: '情侣空间已创建', icon: 'success' });
      if (isFirstCreation) {
        setTimeout(() => wx.switchTab({ url: '/pages/home/home' }), 500);
      }
    } catch (error) {
      this.setData({ saving: false });
      wx.showToast({ title: error.message || '创建失败', icon: 'none' });
    }
  },

  async joinSpace(allowMerge = false) {
    const mergeAllowed = allowMerge === true;
    if (this.data.incomingCode.length !== 8) {
      wx.showToast({ title: '请输入 8 位邀请码', icon: 'none' });
      return;
    }
    this.setData({ saving: true });
    try {
      const result = await joinCouple(this.data.incomingCode, this.data.anniversary, mergeAllowed);
      this.setData({ saving: false });
      wx.removeStorageSync(LAST_INVITE_KEY);
      wx.showToast({ title: result.merged ? '空间已合并并绑定' : '绑定成功', icon: 'success' });
      setTimeout(() => wx.switchTab({ url: '/pages/home/home' }), 500);
    } catch (error) {
      this.setData({ saving: false });
      if (error.code === 'MERGE_REQUIRED') {
        wx.showModal({
          title: '合并并加入 TA 的空间？',
          content: '你当前空间的菜单、心愿单和历史点单会合并过去；留言以邀请方空间为准，纪念日按当前选择保存。',
          confirmText: '合并并加入',
          confirmColor: '#bd6875',
          success: ({ confirm }) => {
            if (confirm) this.joinSpace(true);
          },
        });
        return;
      }
      wx.showToast({ title: error.message || '绑定失败', icon: 'none' });
    }
  },

  copyInvite() {
    wx.setClipboardData({ data: this.data.inviteCode });
  },

  returnHome() {
    wx.switchTab({ url: '/pages/home/home' });
  },
});
