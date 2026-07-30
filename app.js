import updateManager from './common/updateManager';
const { applyWindowTheme, getStoredThemeClass } = require('./utils/theme');
const { isLoggedOut, prefetchSession } = require('./utils/auth');
const { initCloud } = require('./utils/cloud');
const chatUnread = require('./utils/chat-unread');

App({
  globalData: {
    cloudReady: false,
    themeClass: getStoredThemeClass(),
  },

  onLaunch() {
    applyWindowTheme();
    this.bootstrapCloud();
  },

  async bootstrapCloud() {
    try {
      await initCloud();
      this.globalData.cloudReady = true;
      if (!isLoggedOut()) {
        await prefetchSession();
        chatUnread.start();
      }
    } catch (error) {
      this.globalData.cloudReady = false;
      console.error('云开发初始化失败', error);
      wx.showToast({
        title: '云服务初始化失败，请检查多端云开发配置',
        icon: 'none',
        duration: 3000,
      });
    }
  },

  onShow() {
    applyWindowTheme();
    updateManager();
    chatUnread.onAppShow();
  },

  onHide() {
    // 保持 watch，后台仍尽量收信标；不在这里 stop
  },
});
