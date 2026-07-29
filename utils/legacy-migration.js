const { callCloud } = require('./cloud');

const CONFIG_KEY = 'couple.menu.config';
const CART_KEY = 'couple.menu.cart';
const ORDERS_KEY = 'couple.menu.orders';
let checked = false;

const askToImport = () =>
  new Promise((resolve) => {
    wx.showModal({
      title: '发现本机旧数据',
      content: '是否把之前的菜单和记录导入你的个人内容库？成功后旧本地数据会被清理。',
      confirmText: '导入云端',
      confirmColor: '#bd6875',
      success: ({ confirm }) => resolve(confirm),
      fail: () => resolve(false),
    });
  });

const migrateLegacyData = async (session) => {
  if (checked || !session?.user?.publicUserId) return false;
  checked = true;
  const markerKey = `couple.menu.migrated.${session.user.publicUserId}`;
  if (wx.getStorageSync(markerKey)) return false;

  const legacy = {
    cart: wx.getStorageSync(CART_KEY) || [],
    config: wx.getStorageSync(CONFIG_KEY) || null,
    orders: wx.getStorageSync(ORDERS_KEY) || [],
  };
  if (!legacy.config && !legacy.cart.length && !legacy.orders.length) {
    wx.setStorageSync(markerKey, true);
    return false;
  }

  const confirmed = await askToImport();
  if (!confirmed) return false;
  wx.showLoading({ title: '正在导入旧数据' });
  try {
    await callCloud('dataApi', 'importLegacy', {
      legacy,
      requestId: `${Date.now()}-${session.user.publicUserId}`,
    });
    wx.removeStorageSync(CONFIG_KEY);
    wx.removeStorageSync(CART_KEY);
    wx.removeStorageSync(ORDERS_KEY);
    wx.setStorageSync(markerKey, true);
    const { clearConfigCache } = require('./couple-config');
    const { clearCartCache } = require('./couple-cart');
    const { clearPersonalConfigCache } = require('./personal-config');
    clearConfigCache();
    clearCartCache();
    clearPersonalConfigCache();
    wx.showToast({ title: '旧数据已导入', icon: 'success' });
    return true;
  } finally {
    wx.hideLoading();
  }
};

module.exports = {
  migrateLegacyData,
};
