/** 无图时的文字头像：取首字或次字，颜色按名称稳定哈希 */

const AVATAR_COLORS = [
  '#E8A0AE',
  '#D4A5C9',
  '#B8A9C9',
  '#9BB7D4',
  '#8FBFB8',
  '#A8C5A0',
  '#D4C08A',
  '#E0B088',
  '#D9A08F',
  '#C9B1A3',
  '#A3B4C9',
  '#B5A8D4',
];

const getAvatarText = (name = '') => {
  const text = String(name).trim();
  if (!text) return '♡';
  // 两个字及以上取第二个字，更有辨识度；否则取第一个
  return text.length >= 2 ? text[1] : text[0];
};

const hashString = (value = '') => {
  let hash = 0;
  const str = String(value);
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
};

const getAvatarColor = (seed = '') => AVATAR_COLORS[hashString(seed) % AVATAR_COLORS.length];

/** 为分类 / 菜单项补充展示字段：hasImage、avatarText、avatarColor */
const withLetterAvatar = (item, { nameKey = 'name', imageKey = 'image' } = {}) => {
  const image = String(item?.[imageKey] || '').trim();
  const name = item?.[nameKey] || '';
  const seed = item?.id || name;
  if (image) {
    return { ...item, hasImage: true, avatarText: '', avatarColor: '' };
  }
  return {
    ...item,
    hasImage: false,
    avatarText: getAvatarText(name),
    avatarColor: getAvatarColor(seed),
  };
};

const withLetterAvatars = (items, options) => (items || []).map((item) => withLetterAvatar(item, options));

module.exports = {
  getAvatarColor,
  getAvatarText,
  withLetterAvatar,
  withLetterAvatars,
};
