const THEME_COLORS = {
  female: {
    background: '#f8f5f2',
    primary: '#bd6875',
  },
  male: {
    background: '#f1f4f6',
    primary: '#647e94',
  },
};

const getThemeKey = (gender) => (gender === 'male' ? 'male' : 'female');

const getThemeClass = (gender) => (gender === 'male' ? 'theme-male' : 'theme-female');

const getStoredGender = () => wx.getStorageSync('couple.menu.gender') || '';

/** 本地已有性别时同步主题；未知时返回空，避免先粉后蓝闪一下 */
const getStoredThemeClass = () => {
  const gender = getStoredGender();
  return gender ? getThemeClass(gender) : '';
};

const applyWindowTheme = (gender = getStoredGender()) => {
  // 尚无性别时用中性底色，避免导航栏/窗口先刷成粉色
  const colors = gender
    ? THEME_COLORS[getThemeKey(gender)]
    : { background: '#f4f5f5', primary: '#666666' };
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
  return gender ? getThemeClass(gender) : '';
};

module.exports = {
  applyWindowTheme,
  getStoredGender,
  getStoredThemeClass,
  getThemeClass,
  syncTheme,
  THEME_COLORS,
};
