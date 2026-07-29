import updateManager from './common/updateManager';
const { envId } = require('./config/cloud');
const { applyWindowTheme, getStoredThemeClass } = require('./utils/theme');
const { isLoggedOut, prefetchSession } = require('./utils/auth');

App({
  globalData: {
    cloudReady: false,
    themeClass: getStoredThemeClass(),
  },

  onLaunch: function () {
    applyWindowTheme();
    if (!wx.cloud) {
      console.error('当前基础库不支持微信云开发');
      return;
    }
    wx.cloud.init({
      env: envId || undefined,
      traceUser: true,
    });
    this.globalData.cloudReady = true;
    if (!isLoggedOut()) {
      prefetchSession();
    }
  },
  onShow: function () {
    applyWindowTheme();
    updateManager();
  },
});
