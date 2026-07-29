const getThemeClass = (gender) => (gender === 'male' ? 'theme-male' : 'theme-female');

const getStoredThemeClass = () => getThemeClass(wx.getStorageSync('couple.menu.gender'));

module.exports = {
  getStoredThemeClass,
  getThemeClass,
};
