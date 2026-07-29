const { getSession } = require('./auth');
const { callCloud, uploadCloudImage } = require('./cloud');

const clone = (value) => JSON.parse(JSON.stringify(value));
let personalConfigCache = {
  categories: [],
  menuItems: [],
  profile: {},
  version: 0,
};
let personalFetchedAt = 0;
const PERSONAL_TTL_MS = 60 * 1000;

const getPersonalConfig = async (force = false) => {
  const fresh = personalConfigCache.version > 0 && Date.now() - personalFetchedAt < PERSONAL_TTL_MS;
  if (!force && fresh) return clone(personalConfigCache);
  personalConfigCache = await callCloud('dataApi', 'getPersonalConfig');
  personalFetchedAt = Date.now();
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
  personalFetchedAt = Date.now();
  return clone(personalConfigCache);
};

const clearPersonalConfigCache = () => {
  personalConfigCache = {
    categories: [],
    menuItems: [],
    profile: {},
    version: 0,
  };
  personalFetchedAt = 0;
};

module.exports = {
  clearPersonalConfigCache,
  getPersonalConfig,
  savePersonalConfig,
};
