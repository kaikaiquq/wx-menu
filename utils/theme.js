const THEME_COLORS = {
  female: {
    background: '#f6f3ef',
    primary: '#855461',
    secondary: '#635550',
  },
  male: {
    background: '#f0f3f5',
    primary: '#344b5e',
    secondary: '#536874',
  },
};
const NEUTRAL_COLORS = { background: '#f4f4f1', primary: '#485f52', secondary: '#5d675f' };

const getThemeClass = (gender) =>
  gender === 'male' ? 'theme-male' : gender === 'female' ? 'theme-female' : 'theme-neutral';

const getStoredGender = () => wx.getStorageSync('couple.menu.gender') || '';
const getThemeColors = (gender = getStoredGender()) => THEME_COLORS[gender] || NEUTRAL_COLORS;

/** 尚未选择时使用完整的中性主题，避免先粉后蓝闪一下。 */
const getStoredThemeClass = () => {
  const gender = getStoredGender();
  return getThemeClass(gender);
};

const applyWindowTheme = (gender = getStoredGender()) => {
  // 尚无性别时用中性底色，避免导航栏/窗口先刷成粉色
  const colors = getThemeColors(gender);
  try {
    wx.setBackgroundColor({
      backgroundColor: colors.background,
      backgroundColorBottom: colors.background,
      backgroundColorTop: colors.background,
    });
  } catch (error) {
    // 部分基础库或页面不支持时忽略
  }
  try {
    wx.setNavigationBarColor({
      frontColor: '#000000',
      backgroundColor: colors.background,
      animation: { duration: 0 },
    });
  } catch (error) {
    // ignore
  }
};

/** 写入本地性别、刷新窗口色，并返回对应 theme class */
const syncTheme = (gender) => {
  if (gender) {
    wx.setStorageSync('couple.menu.gender', gender);
  }
  applyWindowTheme(gender);
  const themeClass = getThemeClass(gender);
  try {
    const app = getApp();
    if (app?.globalData) app.globalData.themeClass = themeClass;
    const pages = getCurrentPages();
    const tabBar = pages[pages.length - 1]?.getTabBar?.();
    if (tabBar) tabBar.setData({ themeClass });
  } catch (error) {
    // 尚未创建页面时由 Tab attached/show 使用存储主题。
  }
  return themeClass;
};

module.exports = {
  applyWindowTheme,
  getStoredGender,
  getStoredThemeClass,
  getThemeClass,
  getThemeColors,
  syncTheme,
  THEME_COLORS,
};
