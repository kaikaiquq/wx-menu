const { callCloud } = require('../../../utils/cloud');
const { categoryTemplates, menuTemplates } = require('./template-data');
const { withLetterAvatars } = require('../../../utils/letter-avatar');

/** 云端旧种子若缺图，用本地同 id 模板补图 */
const mergeWithLocalImages = (remoteList, localList) => {
  const localById = Object.fromEntries((localList || []).map((item) => [item.id, item]));
  return (remoteList || []).map((item) => {
    if (String(item.image || '').trim()) return item;
    const local = localById[item.id];
    if (local?.image) return { ...item, image: local.image };
    return item;
  });
};

const localTemplates = () => ({
  categories: withLetterAvatars(categoryTemplates),
  menuItems: withLetterAvatars(menuTemplates),
});

const getContentTemplates = async () => {
  try {
    const data = await callCloud('dataApi', 'getContentTemplates');
    const categories = mergeWithLocalImages(data.categories || categoryTemplates, categoryTemplates);
    const menuItems = mergeWithLocalImages(data.menuItems || menuTemplates, menuTemplates);
    return {
      categories: withLetterAvatars(categories.length ? categories : categoryTemplates),
      menuItems: withLetterAvatars(menuItems.length ? menuItems : menuTemplates),
    };
  } catch (error) {
    console.warn('getContentTemplates fallback', error);
    return localTemplates();
  }
};

module.exports = {
  getContentTemplates,
  localTemplates,
};
