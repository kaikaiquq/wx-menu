const { callCloud } = require('./cloud');

let session = null;
let sessionFetchedAt = 0;
let bootstrapPromise = null;
let redirecting = false;
const LOGGED_OUT_KEY = 'couple.menu.loggedOut';
/** 切 Tab 复用会话，避免每次都打 authApi */
const SESSION_TTL_MS = 90 * 1000;

const isSessionFresh = () => session && Date.now() - sessionFetchedAt < SESSION_TTL_MS;

const bootstrap = async (force = false, interactive = false) => {
  if (wx.getStorageSync(LOGGED_OUT_KEY) && !interactive) {
    const error = new Error('请点击微信登录');
    error.code = 'LOGGED_OUT';
    throw error;
  }
  if (!force && isSessionFresh()) return session;
  if (bootstrapPromise && !force) return bootstrapPromise;

  bootstrapPromise = callCloud('authApi', 'bootstrap', {}, { interactiveLogin: interactive })
    .then((data) => {
      session = data;
      sessionFetchedAt = Date.now();
      if (data.user?.openid) {
        wx.setStorageSync('couple.menu.openid', data.user.openid);
      }
      if (data.user?.gender) {
        const { syncTheme } = require('./theme');
        syncTheme(data.user.gender);
      }
      return session;
    })
    .finally(() => {
      bootstrapPromise = null;
    });
  return bootstrapPromise;
};

const getSession = () => session;

const getSelfOpenid = () => session?.user?.openid || wx.getStorageSync('couple.menu.openid') || '';

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
  const { clearCartCache } = require('./couple-wish');
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
  const { clearCartCache } = require('./couple-wish');
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
  sessionFetchedAt = 0;
  bootstrapPromise = null;
};

/** 启动时预热会话，首个 Tab 少等一轮云函数冷启动 */
const prefetchSession = () => {
  if (isLoggedOut()) return Promise.resolve(null);
  return bootstrap(false).catch((error) => {
    if (error.code !== 'LOGGED_OUT') {
      console.warn('prefetchSession failed', error.message || error);
    }
    return null;
  });
};

module.exports = {
  bootstrap,
  clearSession,
  createInvite,
  getActiveInvite,
  getSelfOpenid,
  getSession,
  isLoggedOut,
  joinCouple,
  login,
  logout,
  prefetchSession,
  refreshSession,
  requireSession,
  unbindPartner,
  updateProfile,
};
