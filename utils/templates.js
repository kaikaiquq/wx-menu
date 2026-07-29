const { callCloud } = require('./cloud');
const { categoryTemplates, menuTemplates } = require('../model/templates');
const { withLetterAvatars } = require('./letter-avatar');

const localTemplates = () => ({
  categories: withLetterAvatars(categoryTemplates),
  menuItems: withLetterAvatars(menuTemplates),
});

const getContentTemplates = async () => {
  try {
    const data = await callCloud('dataApi', 'getContentTemplates');
    return {
      categories: withLetterAvatars(data.categories || categoryTemplates),
      menuItems: withLetterAvatars(data.menuItems || menuTemplates),
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
