const { getSession } = require('./auth');
const { callCloud, uploadCloudImage } = require('./cloud');

const clone = (value) => JSON.parse(JSON.stringify(value));
let personalConfigCache = {
  categories: [],
  menuItems: [],
  profile: {},
  version: 0,
};

const getPersonalConfig = async (force = false) => {
  if (!force && personalConfigCache.version > 0) return clone(personalConfigCache);
  personalConfigCache = await callCloud('dataApi', 'getPersonalConfig');
  return clone(personalConfigCache);
};

const savePersonalConfig = async (config) => {
  const session = getSession();
  if (!session?.user?.publicUserId) throw new Error('请先登录');
  const [categories, menuItems] = await Promise.all([
    Promise.all(
      config.categories.map(async (item) => ({
        ...item,
        image: await uploadCloudImage(item.image, session.user.publicUserId, 'personal'),
      })),
    ),
    Promise.all(
      config.menuItems.map(async (item) => ({
        ...item,
        image: await uploadCloudImage(item.image, session.user.publicUserId, 'personal'),
      })),
    ),
  ]);
  personalConfigCache = await callCloud('dataApi', 'savePersonalConfig', {
    config: {
      categories,
      menuItems,
      profile: config.profile,
    },
    expectedVersion: config.version,
  });
  return clone(personalConfigCache);
};

const clearPersonalConfigCache = () => {
  personalConfigCache = {
    categories: [],
    menuItems: [],
    profile: {},
    version: 0,
  };
};

module.exports = {
  clearPersonalConfigCache,
  getPersonalConfig,
  savePersonalConfig,
};
