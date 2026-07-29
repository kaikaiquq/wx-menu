const { categories, coupleProfile, featuredIds, menuItems } = require('../model/couple-menu');
const { getSession } = require('./auth');
const { callCloud, uploadCloudImage } = require('./cloud');

const clone = (value) => JSON.parse(JSON.stringify(value));
const defaultConfig = {
  categories: clone(categories),
  menuItems: clone(menuItems),
  profile: clone(coupleProfile),
  version: 0,
};
let configCache = clone(defaultConfig);

const getDefaultConfig = () => clone(defaultConfig);
const getCachedMenuConfig = () => clone(configCache);

const getMenuConfig = async (force = false) => {
  if (!force && configCache.version > 0) return getCachedMenuConfig();
  const cloudConfig = await callCloud('dataApi', 'getConfig');
  configCache = {
    categories: cloudConfig.categories,
    menuItems: cloudConfig.menuItems,
    profile: cloudConfig.profile,
    version: cloudConfig.version,
  };
  return getCachedMenuConfig();
};

const saveMenuConfig = async (config) => {
  const session = getSession();
  if (!session?.couple?.coupleId) throw new Error('请先绑定情侣空间');
  const uploadedItems = await Promise.all(
    config.menuItems.map(async (item) => ({
      ...item,
      image: await uploadCloudImage(item.image, session.couple.coupleId),
    })),
  );
  const savedConfig = await callCloud('dataApi', 'saveConfig', {
    config: {
      categories: config.categories,
      menuItems: uploadedItems,
      profile: config.profile,
    },
    expectedVersion: config.version,
  });
  configCache = savedConfig;
  return getCachedMenuConfig();
};

const saveSharedMessage = async (message, version) => {
  const session = getSession();
  if (!session?.couple?.coupleId) throw new Error('请先绑定情侣空间');
  const savedConfig = await callCloud('dataApi', 'saveSharedMessage', {
    expectedVersion: version,
    message,
  });
  configCache = savedConfig;
  return getCachedMenuConfig();
};

const getFeaturedItems = (items) => {
  const featured = featuredIds.map((id) => items.find((item) => item.id === id)).filter(Boolean);
  if (featured.length >= 4) return featured.slice(0, 4);
  const fallback = items.filter((item) => !featured.some((featuredItem) => featuredItem.id === item.id));
  return featured.concat(fallback).slice(0, 4);
};

const clearConfigCache = () => {
  configCache = clone(defaultConfig);
};

module.exports = {
  clearConfigCache,
  getCachedMenuConfig,
  getDefaultConfig,
  getFeaturedItems,
  getMenuConfig,
  saveMenuConfig,
  saveSharedMessage,
};
