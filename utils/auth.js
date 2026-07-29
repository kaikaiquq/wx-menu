const { callCloud } = require('./cloud');

let session = null;
let bootstrapPromise = null;
let redirecting = false;
const LOGGED_OUT_KEY = 'couple.menu.loggedOut';

const bootstrap = async (force = false, interactive = false) => {
  if (wx.getStorageSync(LOGGED_OUT_KEY) && !interactive) {
    const error = new Error('请点击微信登录');
    error.code = 'LOGGED_OUT';
    throw error;
  }
  if (session && !force) return session;
  if (bootstrapPromise && !force) return bootstrapPromise;

  bootstrapPromise = callCloud('authApi', 'bootstrap')
    .then((data) => {
      session = data;
      if (data.user?.gender) {
        wx.setStorageSync('couple.menu.gender', data.user.gender);
      }
      return session;
    })
    .finally(() => {
      bootstrapPromise = null;
    });
  return bootstrapPromise;
};

const getSession = () => session;

const refreshSession = () => bootstrap(true);

const login = async () => {
  wx.removeStorageSync(LOGGED_OUT_KEY);
  return bootstrap(true, true);
};

const updateProfile = async ({ nickname, avatarFileId, gender }) => {
  await callCloud('authApi', 'updateProfile', { avatarFileId, gender, nickname });
  return refreshSession();
};

const createInvite = async () => {
  const data = await callCloud('coupleApi', 'createInvite');
  await refreshSession();
  return data;
};

const getActiveInvite = () => callCloud('coupleApi', 'getActiveInvite');

const joinCouple = async (code, anniversary) => {
  const data = await callCloud('coupleApi', 'joinCouple', { anniversary, code });
  const { clearConfigCache } = require('./couple-config');
  const { clearCartCache } = require('./couple-cart');
  const { clearPersonalConfigCache } = require('./personal-config');
  clearConfigCache();
  clearCartCache();
  clearPersonalConfigCache();
  await refreshSession();
  return data;
};

const unbindPartner = async () => {
  await callCloud('coupleApi', 'unbindPartner');
  return refreshSession();
};

const logout = () => {
  wx.setStorageSync(LOGGED_OUT_KEY, true);
  clearSession();
  const { clearConfigCache } = require('./couple-config');
  const { clearCartCache } = require('./couple-cart');
  const { clearPersonalConfigCache } = require('./personal-config');
  clearConfigCache();
  clearCartCache();
  clearPersonalConfigCache();
  wx.reLaunch({ url: '/pages/auth/index' });
};

const isLoggedOut = () => Boolean(wx.getStorageSync(LOGGED_OUT_KEY));

const requireSession = async ({ force = false, requireCouple = true } = {}) => {
  try {
    const current = await bootstrap(force);
    const needsAuth = !current.user?.profileCompleted;
    const needsCouple = requireCouple && !current.couple;
    if (needsAuth || needsCouple) {
      if (!redirecting) {
        redirecting = true;
        wx.navigateTo({
          url: '/pages/auth/index',
          complete: () => {
            setTimeout(() => {
              redirecting = false;
            }, 500);
          },
        });
      }
      return null;
    }
    const { migrateLegacyData } = require('./legacy-migration');
    await migrateLegacyData(current);
    return current;
  } catch (error) {
    if (error.code === 'LOGGED_OUT') {
      wx.reLaunch({ url: '/pages/auth/index' });
      return null;
    }
    wx.showToast({ title: error.message || '登录失败', icon: 'none' });
    return null;
  }
};

const clearSession = () => {
  session = null;
  bootstrapPromise = null;
};

module.exports = {
  bootstrap,
  clearSession,
  createInvite,
  getActiveInvite,
  getSession,
  isLoggedOut,
  joinCouple,
  login,
  logout,
  refreshSession,
  requireSession,
  unbindPartner,
  updateProfile,
};
