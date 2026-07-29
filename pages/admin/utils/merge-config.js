const clone = (value) => JSON.parse(JSON.stringify(value));

const mergeConfigContent = (targetConfig, sourceConfig) => {
  const target = clone(targetConfig);
  const categories = target.categories || [];
  const menuItems = target.menuItems || [];
  const categoryMap = {};
  const suffix = Date.now().toString(36);

  (sourceConfig.categories || []).forEach((sourceCategory, index) => {
    const sameId = categories.find((item) => item.id === sourceCategory.id);
    if (!sameId) {
      categories.push(clone(sourceCategory));
      categoryMap[sourceCategory.id] = sourceCategory.id;
      return;
    }
    if (sameId.name === sourceCategory.name && sameId.icon === sourceCategory.icon) {
      categoryMap[sourceCategory.id] = sameId.id;
      return;
    }
    const id = `${sourceCategory.id.slice(0, 42)}-personal-${suffix}-${index}`;
    categories.push({ ...clone(sourceCategory), id });
    categoryMap[sourceCategory.id] = id;
  });

  (sourceConfig.menuItems || []).forEach((sourceItem, index) => {
    const categoryId = categoryMap[sourceItem.categoryId] || sourceItem.categoryId;
    const sameId = menuItems.find((item) => item.id === sourceItem.id);
    if (
      sameId &&
      sameId.name === sourceItem.name &&
      sameId.categoryId === categoryId &&
      sameId.cost === sourceItem.cost
    ) {
      return;
    }
    const id = sameId ? `${sourceItem.id.slice(0, 46)}-personal-${suffix}-${index}` : sourceItem.id;
    menuItems.push({ ...clone(sourceItem), categoryId, id });
  });

  if (categories.length > 50 || menuItems.length > 300) {
    const error = new Error('双方内容较多，导入后会超出上限，请先精简个人内容库');
    error.code = 'MERGE_LIMIT';
    throw error;
  }

  return {
    ...target,
    categories,
    menuItems,
  };
};

module.exports = {
  mergeConfigContent,
};
