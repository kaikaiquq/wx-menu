import updateManager from './common/updateManager';
const { envId } = require('./config/cloud');

App({
  globalData: {
    cloudReady: false,
  },

  onLaunch: function () {
    if (!wx.cloud) {
      console.error('当前基础库不支持微信云开发');
      return;
    }
    wx.cloud.init({
      env: envId || undefined,
      traceUser: true,
    });
    this.globalData.cloudReady = true;
  },
  onShow: function () {
    updateManager();
  },
});
