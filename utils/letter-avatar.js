/** 无图时的文字头像：取首字或次字，颜色按名称稳定哈希 */

const AVATAR_COLORS = [
  '#855461',
  '#78627C',
  '#69657D',
  '#536E86',
  '#50756F',
  '#637453',
  '#79663B',
  '#845E3D',
  '#895D54',
  '#7A695F',
  '#596E80',
  '#73688A',
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
