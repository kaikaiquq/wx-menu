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
let configFetchedAt = 0;

const getDefaultConfig = () => clone(defaultConfig);
const getCachedMenuConfig = () => clone(configCache);
const hasMenuConfigCache = () => configFetchedAt > 0;

const getMenuConfig = async (force = false) => {
  // 拉取成功后常驻内存，切页/切栏目不再打云；仅 force 或 clear 后重拉。
  // 保存空间内容时 save* 会同步写回 cache，无需再按 TTL 失效。
  if (!force && configFetchedAt > 0) return getCachedMenuConfig();
  const cloudConfig = await callCloud('dataApi', 'getConfig');
  configCache = {
    categories: cloudConfig.categories,
    menuItems: cloudConfig.menuItems,
    profile: cloudConfig.profile,
    version: cloudConfig.version,
  };
  configFetchedAt = Date.now();
  return getCachedMenuConfig();
};

const uploadSharedImages = async (items, coupleId) =>
  Promise.all(
    items.map(async (item) => {
      try {
        return {
          ...item,
          image: await uploadCloudImage(item.image, coupleId, 'couple'),
        };
      } catch (error) {
        const label = item.name ? `「${item.name}」` : '内容';
        const err = new Error(error.message || `${label}图片处理失败，请重新选择图片后再保存`);
        err.code = error.code || 'IMAGE_UPLOAD_FAILED';
        throw err;
      }
    }),
  );

const saveMenuConfig = async (config) => {
  const session = getSession();
  if (!session?.couple?.coupleId) throw new Error('请先绑定情侣空间');
  const coupleId = session.couple.coupleId;
  const [uploadedCategories, uploadedItems] = await Promise.all([
    uploadSharedImages(config.categories || [], coupleId),
    uploadSharedImages(config.menuItems || [], coupleId),
  ]);
  const savedConfig = await callCloud('dataApi', 'saveConfig', {
    config: {
      categories: uploadedCategories,
      menuItems: uploadedItems,
      profile: config.profile,
    },
    expectedVersion: config.version,
  });
  configCache = savedConfig;
  configFetchedAt = Date.now();
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
  configFetchedAt = Date.now();
  return getCachedMenuConfig();
};

const saveSharedAnniversary = async (anniversary, version) => {
  const session = getSession();
  if (!session?.couple?.coupleId) throw new Error('请先绑定情侣空间');
  const savedConfig = await callCloud('dataApi', 'saveSharedAnniversary', {
    anniversary,
    expectedVersion: version,
  });
  configCache = savedConfig;
  configFetchedAt = Date.now();
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
  configFetchedAt = 0;
};

module.exports = {
  clearConfigCache,
  getCachedMenuConfig,
  getDefaultConfig,
  getFeaturedItems,
  getMenuConfig,
  hasMenuConfigCache,
  saveMenuConfig,
  saveSharedAnniversary,
  saveSharedMessage,
};
