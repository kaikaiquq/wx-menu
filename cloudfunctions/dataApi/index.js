const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const ok = (data) => ({ data, ok: true });
const fail = (code, message, details) => ({ code, details, message, ok: false });
const now = () => db.serverDate();
const randomId = (prefix) => `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
const isNotFound = (error) =>
  error?.errCode === -1 || String(error?.message || '').toLowerCase().includes('not exist');

const getMemberContext = async (openid) => {
  const user = (await db.collection('users').doc(openid).get()).data;
  if (!user.coupleId) throw Object.assign(new Error('请先绑定情侣空间'), { code: 'COUPLE_REQUIRED' });
  const couple = (await db.collection('couples').doc(user.coupleId).get()).data;
  if (!couple.members.includes(openid) || couple.status === 'dissolved') {
    throw Object.assign(new Error('没有访问该情侣空间的权限'), { code: 'FORBIDDEN' });
  }
  return { couple, coupleId: user.coupleId, user };
};

const sanitizeConfig = (config = {}) => ({
  categories: (Array.isArray(config.categories) ? config.categories : []).slice(0, 50).map((item) => ({
    icon: String(item.icon || '♡').slice(0, 4),
    id: String(item.id || '').slice(0, 64),
    image: String(item.image || '').slice(0, 1024),
    name: String(item.name || '').trim().slice(0, 20),
    subtitle: String(item.subtitle || '').slice(0, 40),
  })),
  menuItems: (Array.isArray(config.menuItems) ? config.menuItems : []).slice(0, 300).map((item) => ({
    badge: String(item.badge || '').slice(0, 20),
    categoryId: String(item.categoryId || '').slice(0, 64),
    cost: String(item.cost || '一份小心意').slice(0, 40),
    description: String(item.description || '').slice(0, 100),
    id: String(item.id || '').slice(0, 64),
    image: String(item.image || '').slice(0, 1024),
    name: String(item.name || '').trim().slice(0, 30),
  })),
  profile: {
    anniversary: String(config.profile?.anniversary || '').slice(0, 10),
    herName: String(config.profile?.herName || '她').slice(0, 40),
    hisName: String(config.profile?.hisName || '他').slice(0, 40),
    message: String(config.profile?.message || '写下一句想记住的话').slice(0, 80),
  },
});

const validateConfig = (config) => {
  // 共同空间允许完全空白；只有存在点单项时才要求分类完整
  if (!config.categories.length) {
    return config.menuItems.length ? '请先添加分类，再保存点单项' : '';
  }
  if (config.categories.some((item) => !item.id || !item.name)) return '分类名称不能为空';
  const categoryIds = new Set(config.categories.map((item) => item.id));
  if (config.menuItems.some((item) => !item.id || !item.name || !item.cost || !categoryIds.has(item.categoryId))) {
    return '菜单数据不完整或所属分类不存在';
  }
  return '';
};

const emptyPersonalConfig = () => ({
  categories: [{ icon: '♡', id: 'personal-default', image: '', name: '未分类', subtitle: '我喜欢的内容' }],
  menuItems: [],
  profile: {
    anniversary: '',
    herName: '她',
    hisName: '他',
    message: '写下一句想记住的话',
  },
});

const { categoryTemplates, menuTemplates } = require('./content-templates');
const CONTENT_TEMPLATE_SEED_VERSION = 2;
const CONTENT_TEMPLATE_SEED = {
  categories: categoryTemplates,
  menuItems: menuTemplates,
};

/** 推荐模板：代码种子为准；库内旧版（无图）会按 seedVersion 自动覆盖 */
const getContentTemplates = async () => {
  const seed = {
    categories: CONTENT_TEMPLATE_SEED.categories,
    menuItems: CONTENT_TEMPLATE_SEED.menuItems,
  };
  try {
    const current = (await db.collection('contentTemplates').doc('default').get()).data;
    if ((current.seedVersion || 0) < CONTENT_TEMPLATE_SEED_VERSION) {
      await db.collection('contentTemplates').doc('default').set({
        ...seed,
        seedVersion: CONTENT_TEMPLATE_SEED_VERSION,
        updatedAt: now(),
      });
      return ok(seed);
    }
    return ok({
      categories:
        Array.isArray(current.categories) && current.categories.length ? current.categories : seed.categories,
      menuItems:
        Array.isArray(current.menuItems) && current.menuItems.length ? current.menuItems : seed.menuItems,
    });
  } catch (error) {
    if (!isNotFound(error) && error.errCode !== -502005) throw error;
    try {
      await db.collection('contentTemplates').doc('default').set({
        ...seed,
        seedVersion: CONTENT_TEMPLATE_SEED_VERSION,
        updatedAt: now(),
      });
    } catch (writeError) {
      console.warn('seed contentTemplates failed', writeError.message || writeError);
    }
    return ok(seed);
  }
};

const getOrCreatePersonalConfig = async (openid) => {
  try {
    return (await db.collection('userConfigs').doc(openid).get()).data;
  } catch (error) {
    if (!isNotFound(error)) throw error;
    const user = (await db.collection('users').doc(openid).get()).data;
    let config = emptyPersonalConfig();
    if (user.coupleId) {
      try {
        const couple = (await db.collection('couples').doc(user.coupleId).get()).data;
        if (couple.status === 'pending' && couple.members.length === 1 && couple.members[0] === openid) {
          const legacyConfig = (await db.collection('coupleConfigs').doc(user.coupleId).get()).data;
          config = sanitizeConfig(legacyConfig);
        }
      } catch (migrationError) {
        console.error('迁移个人内容失败', migrationError.message);
      }
    }
    await db.collection('userConfigs').doc(openid).set({
      data: {
        ...config,
        createdAt: now(),
        ownerOpenid: openid,
        updatedAt: now(),
        updatedBy: openid,
        version: 1,
      },
    });
    return { ...config, version: 1 };
  }
};

const getPersonalConfig = async (openid) => {
  const config = await getOrCreatePersonalConfig(openid);
  return ok({
    categories: config.categories,
    menuItems: config.menuItems,
    profile: config.profile || emptyPersonalConfig().profile,
    version: config.version,
  });
};

const savePersonalConfig = async (openid, event) => {
  await getOrCreatePersonalConfig(openid);
  const config = sanitizeConfig(event.config);
  const validationError = validateConfig(config);
  if (validationError) return fail('INVALID_CONFIG', validationError);
  return db.runTransaction(async (transaction) => {
    const current = (await transaction.collection('userConfigs').doc(openid).get()).data;
    if (Number(event.expectedVersion) !== current.version) {
      return fail('VERSION_CONFLICT', '个人内容刚刚发生变化，请刷新后重试');
    }
    await transaction.collection('userConfigs').doc(openid).update({
      data: {
        ...config,
        updatedAt: now(),
        updatedBy: openid,
        version: _.inc(1),
      },
    });
    return ok({ ...config, version: current.version + 1 });
  });
};

const getConfig = async (openid) => {
  const { coupleId } = await getMemberContext(openid);
  const config = (await db.collection('coupleConfigs').doc(coupleId).get()).data;
  return ok({
    categories: config.categories,
    menuItems: config.menuItems,
    profile: config.profile,
    version: config.version,
  });
};

const saveConfig = async (openid, event) => {
  const { coupleId } = await getMemberContext(openid);
  const config = sanitizeConfig(event.config);
  const validationError = validateConfig(config);
  if (validationError) return fail('INVALID_CONFIG', validationError);

  const result = await db.runTransaction(async (transaction) => {
    const current = (await transaction.collection('coupleConfigs').doc(coupleId).get()).data;
    if (Number(event.expectedVersion) !== current.version) {
      return fail('VERSION_CONFLICT', '另一位成员刚刚修改了内容，请重新进入后再编辑', {
        currentVersion: current.version,
      });
    }
    await transaction.collection('coupleConfigs').doc(coupleId).update({
      data: {
        ...config,
        updatedAt: now(),
        updatedBy: openid,
        version: _.inc(1),
      },
    });
    return ok({ ...config, version: current.version + 1 });
  });
  return result;
};

const saveSharedMessage = async (openid, event) => {
  const { coupleId } = await getMemberContext(openid);
  const message = String(event.message || '').trim().slice(0, 80);
  if (!message) return fail('INVALID_MESSAGE', '请写下一句想记住的话');

  return db.runTransaction(async (transaction) => {
    const current = (await transaction.collection('coupleConfigs').doc(coupleId).get()).data;
    if (event.expectedVersion != null && Number(event.expectedVersion) !== current.version) {
      return fail('VERSION_CONFLICT', '另一位成员刚刚修改了内容，请重新进入后再编辑', {
        currentVersion: current.version,
      });
    }
    const profile = {
      ...(current.profile || {}),
      message,
    };
    await transaction.collection('coupleConfigs').doc(coupleId).update({
      data: {
        profile,
        updatedAt: now(),
        updatedBy: openid,
        version: _.inc(1),
      },
    });
    return ok({
      categories: current.categories || [],
      menuItems: current.menuItems || [],
      profile,
      version: current.version + 1,
    });
  });
};

const saveSharedAnniversary = async (openid, event) => {
  const { coupleId } = await getMemberContext(openid);
  const anniversary = String(event.anniversary || '').trim();
  const anniversaryDate = new Date(`${anniversary}T00:00:00`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(anniversary) ||
    Number.isNaN(anniversaryDate.getTime()) ||
    anniversaryDate > new Date()
  ) {
    return fail('INVALID_ANNIVERSARY', '请选择今天或更早的纪念日');
  }

  return db.runTransaction(async (transaction) => {
    const current = (await transaction.collection('coupleConfigs').doc(coupleId).get()).data;
    if (event.expectedVersion != null && Number(event.expectedVersion) !== current.version) {
      return fail('VERSION_CONFLICT', '另一位成员刚刚修改了内容，请重新进入后再编辑', {
        currentVersion: current.version,
      });
    }
    const profile = {
      ...(current.profile || {}),
      anniversary,
    };
    await transaction.collection('coupleConfigs').doc(coupleId).update({
      data: {
        profile,
        updatedAt: now(),
        updatedBy: openid,
        version: _.inc(1),
      },
    });
    return ok({
      categories: current.categories || [],
      menuItems: current.menuItems || [],
      profile,
      version: current.version + 1,
    });
  });
};

const getCart = async (openid) => {
  const { coupleId } = await getMemberContext(openid);
  const cart = (await db.collection('coupleCarts').doc(coupleId).get()).data;
  return ok({ items: cart.items || [], version: cart.version });
};

const updateCart = async (openid, event) => {
  const { coupleId } = await getMemberContext(openid);
  const config = (await db.collection('coupleConfigs').doc(coupleId).get()).data;
  const requestItems = Array.isArray(event.items) ? event.items.slice(0, 100) : [];
  const items = requestItems
    .map((requestItem) => {
      const menuItem = config.menuItems.find((item) => item.id === requestItem.id);
      const quantity = Math.max(1, Math.min(99, Number(requestItem.quantity) || 1));
      return menuItem ? { ...menuItem, quantity } : null;
    })
    .filter(Boolean);

  const result = await db.runTransaction(async (transaction) => {
    const cart = (await transaction.collection('coupleCarts').doc(coupleId).get()).data;
    if (event.expectedVersion != null && Number(event.expectedVersion) !== cart.version) {
      return fail('VERSION_CONFLICT', '心愿单已被另一位成员更新，请刷新后重试');
    }
    await transaction.collection('coupleCarts').doc(coupleId).update({
      data: {
        items,
        updatedAt: now(),
        updatedBy: openid,
        version: _.inc(1),
      },
    });
    return ok({ items, version: cart.version + 1 });
  });
  return result;
};

const createOrder = async (openid, event) => {
  const { coupleId, user } = await getMemberContext(openid);
  const requestId = String(event.requestId || randomId('request')).slice(0, 80);
  const mutationId = `${openid}_${requestId}`;
  try {
    const previous = (await db.collection('mutationRequests').doc(mutationId).get()).data;
    return ok(previous.result);
  } catch (error) {
    // 首次请求继续执行
  }

  const activeOrder = await db
    .collection('orders')
    .where({ coupleId, status: _.in(['等待回应', '进行中']) })
    .limit(1)
    .get();
  if (activeOrder.data.length) return fail('ACTIVE_ORDER_EXISTS', '请先完成当前心愿，再发起新的点单');

  const result = await db.runTransaction(async (transaction) => {
    const cart = (await transaction.collection('coupleCarts').doc(coupleId).get()).data;
    if (!cart.items?.length) return fail('EMPTY_CART', '心愿单还是空的');
    const orderId = randomId('order');
    const order = {
      coupleId,
      createdAt: now(),
      createdBy: openid,
      createdByName: user.nickname || 'TA',
      createdByPublicUserId: user.publicUserId,
      items: cart.items.map((item) => ({
        cost: item.cost,
        image: item.image,
        menuItemId: item.id,
        name: item.name,
        quantity: item.quantity,
      })),
      note: String(event.note || '').slice(0, 100),
      orderNo: `LOVE-${Date.now()}`,
      status: '等待回应',
      updatedAt: now(),
      updatedBy: openid,
      version: 1,
    };
    await transaction.collection('orders').doc(orderId).set({ data: order });
    await transaction.collection('coupleCarts').doc(coupleId).update({
      data: { items: [], updatedAt: now(), updatedBy: openid, version: _.inc(1) },
    });
    await transaction.collection('mutationRequests').doc(mutationId).set({
      data: {
        action: 'createOrder',
        createdAt: now(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        openid,
        result: { orderId, orderNo: order.orderNo },
      },
    });
    return ok({ orderId, orderNo: order.orderNo });
  });
  return result;
};

const getOrders = async (openid, event) => {
  const { coupleId } = await getMemberContext(openid);
  const limit = Math.max(1, Math.min(50, Number(event.limit) || 20));
  const result = await db.collection('orders').where({ coupleId }).orderBy('createdAt', 'desc').limit(limit).get();
  return ok({
    orders: result.data.map((order) => ({
      createdAt: order.createdAt,
      createdByName: order.createdByName || 'TA',
      createdByPublicUserId: order.createdByPublicUserId || '',
      id: order._id,
      isCreatedByCurrentUser: order.createdBy === openid,
      items: order.items,
      note: order.note,
      orderNo: order.orderNo,
      respondedByName: order.respondedByName || '',
      response: order.response || '',
      status: order.status,
    })),
  });
};

const getPersonalOrders = async (openid, event) => {
  const limit = Math.max(1, Math.min(50, Number(event.limit) || 20));
  const user = (await db.collection('users').doc(openid).get()).data;
  const archivedCoupleIds = Array.isArray(user.archivedCoupleIds)
    ? user.archivedCoupleIds.slice(-10)
    : [];
  const personalResult = await db
    .collection('userOrders')
    .where({ ownerOpenid: openid })
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();
  let archivedOrders = [];
  if (archivedCoupleIds.length) {
    const archivedResult = await db
      .collection('orders')
      .where({ coupleId: _.in(archivedCoupleIds) })
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();
    archivedOrders = archivedResult.data;
  }
  const orders = personalResult.data
    .concat(archivedOrders)
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
    .slice(0, limit);
  return ok({
    orders: orders.map((order) => ({
      createdAt: order.createdAt,
      createdByName: order.createdByName || 'TA',
      id: order._id,
      isCreatedByCurrentUser: order.createdBy === openid,
      items: order.items,
      note: order.note,
      orderNo: order.orderNo,
      respondedByName: order.respondedByName || '',
      response: order.response || '',
      status: order.status,
    })),
  });
};

const updateOrder = async (openid, event) => {
  const { coupleId, user } = await getMemberContext(openid);
  const orderId = String(event.orderId || '');
  const operation = String(event.operation || '');
  if (!orderId) return fail('ORDER_REQUIRED', '订单不存在');

  return db.runTransaction(async (transaction) => {
    const order = (await transaction.collection('orders').doc(orderId).get()).data;
    if (order.coupleId !== coupleId) return fail('FORBIDDEN', '没有操作该心愿的权限');

    if (operation === 'respond') {
      if (order.status !== '等待回应') return fail('INVALID_STATUS', '该心愿已经回应过了');
      if (order.createdBy === openid) return fail('CREATOR_CANNOT_RESPOND', '请等待 TA 回应');
      const response = String(event.response || '').trim().slice(0, 100);
      if (!response) return fail('RESPONSE_REQUIRED', '请写一句回应');
      await transaction.collection('orders').doc(orderId).update({
        data: {
          respondedAt: now(),
          respondedBy: openid,
          respondedByName: user.nickname || 'TA',
          response,
          status: '进行中',
          updatedAt: now(),
          updatedBy: openid,
          version: _.inc(1),
        },
      });
      return ok({ status: '进行中' });
    }

    if (operation === 'complete') {
      if (order.status !== '进行中') return fail('INVALID_STATUS', '请先回应后再完成心愿');
      await transaction.collection('orders').doc(orderId).update({
        data: {
          completedAt: now(),
          status: '已完成',
          updatedAt: now(),
          updatedBy: openid,
          version: _.inc(1),
        },
      });
      return ok({ status: '已完成' });
    }
    return fail('UNKNOWN_OPERATION', '不支持的心愿操作');
  });
};

const importLegacy = async (openid, event) => {
  const user = (await db.collection('users').doc(openid).get()).data;
  if (user.legacyMigratedAt) return ok({ imported: false, reason: 'already_imported' });
  await getOrCreatePersonalConfig(openid);
  const legacy = event.legacy || {};
  const importedConfig = legacy.config ? sanitizeConfig(legacy.config) : null;
  if (importedConfig) {
    const validationError = validateConfig(importedConfig);
    if (validationError) return fail('INVALID_LEGACY_DATA', validationError);
    await db.collection('userConfigs').doc(openid).update({
      data: { ...importedConfig, updatedAt: now(), updatedBy: openid, version: _.inc(1) },
    });
  }
  const orders = Array.isArray(legacy.orders) ? legacy.orders.slice(0, 100) : [];
  for (const legacyOrder of orders) {
    const legacyItems = (Array.isArray(legacyOrder.items) ? legacyOrder.items : []).slice(0, 100).map((item) => ({
      cost: String(item.cost || '一份小心意').slice(0, 40),
      image: String(item.image || '').slice(0, 1024),
      menuItemId: String(item.menuItemId || item.id || '').slice(0, 64),
      name: String(item.name || item.nameSnapshot || '旧心愿').slice(0, 30),
      quantity: Math.max(1, Math.min(99, Number(item.quantity) || 1)),
    }));
    await db.collection('userOrders').add({
      data: {
        coupleId: null,
        createdAt: new Date(legacyOrder.createdAt || Date.now()),
        createdBy: openid,
        items: legacyItems,
        note: String(legacyOrder.note || '').slice(0, 100),
        orderNo: String(legacyOrder.id || `LOVE-${Date.now()}`),
        status: String(legacyOrder.status || '等待回应'),
        ownerOpenid: openid,
        updatedAt: now(),
        updatedBy: openid,
        version: 1,
      },
    });
  }
  await db.collection('users').doc(openid).update({
    data: { legacyMigratedAt: now(), updatedAt: now(), version: _.inc(1) },
  });
  return ok({ imported: true });
};

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  try {
    if (event.action === 'getPersonalConfig') return getPersonalConfig(OPENID);
    if (event.action === 'savePersonalConfig') return savePersonalConfig(OPENID, event);
    if (event.action === 'getConfig') return getConfig(OPENID);
    if (event.action === 'saveConfig') return saveConfig(OPENID, event);
    if (event.action === 'saveSharedMessage') return saveSharedMessage(OPENID, event);
    if (event.action === 'saveSharedAnniversary') return saveSharedAnniversary(OPENID, event);
    if (event.action === 'getCart') return getCart(OPENID);
    if (event.action === 'updateCart') return updateCart(OPENID, event);
    if (event.action === 'createOrder') return createOrder(OPENID, event);
    if (event.action === 'getOrders') return getOrders(OPENID, event);
    if (event.action === 'getPersonalOrders') return getPersonalOrders(OPENID, event);
    if (event.action === 'updateOrder') return updateOrder(OPENID, event);
    if (event.action === 'importLegacy') return importLegacy(OPENID, event);
    if (event.action === 'getContentTemplates') return getContentTemplates();
    return fail('UNKNOWN_ACTION', '不支持的操作');
  } catch (error) {
    console.error('dataApi error', error.code || error.message);
    if (error.errCode === -502005 || String(error.message).includes('collection not exists')) {
      return fail('COLLECTION_REQUIRED', '请先在云开发数据库创建 userConfigs 和 userOrders 集合');
    }
    return fail(error.code || 'SERVER_ERROR', error.message || '云端数据服务暂时不可用');
  }
};
