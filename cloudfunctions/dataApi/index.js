const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const ok = (data) => ({ data, ok: true });
const fail = (code, message, details) => ({ code, details, message, ok: false });
const now = () => db.serverDate();
const randomId = (prefix) => `${prefix}_${crypto.randomBytes(12).toString('hex')}`;

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
    name: String(item.name || '').trim().slice(0, 20),
    subtitle: String(item.subtitle || '').slice(0, 40),
  })),
  menuItems: (Array.isArray(config.menuItems) ? config.menuItems : []).slice(0, 300).map((item) => ({
    badge: String(item.badge || '').slice(0, 20),
    categoryId: String(item.categoryId || '').slice(0, 64),
    cost: String(item.cost || '一份小心意').slice(0, 40),
    description: String(item.description || '').slice(0, 100),
    id: String(item.id || '').slice(0, 64),
    image: String(item.image || '').slice(0, 500),
    name: String(item.name || '').trim().slice(0, 30),
  })),
  profile: {
    anniversary: String(config.profile?.anniversary || '').slice(0, 10),
    herName: String(config.profile?.herName || '她').slice(0, 20),
    hisName: String(config.profile?.hisName || '他').slice(0, 20),
    message: String(config.profile?.message || '写下一句想记住的话').slice(0, 80),
  },
});

const validateConfig = (config) => {
  if (!config.categories.length) return '至少保留一个分类';
  if (config.categories.some((item) => !item.id || !item.name)) return '分类名称不能为空';
  const categoryIds = new Set(config.categories.map((item) => item.id));
  if (config.menuItems.some((item) => !item.id || !item.name || !item.cost || !categoryIds.has(item.categoryId))) {
    return '菜单数据不完整或所属分类不存在';
  }
  return '';
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
  const { coupleId } = await getMemberContext(openid);
  const requestId = String(event.requestId || randomId('request')).slice(0, 80);
  const mutationId = `${openid}_${requestId}`;
  try {
    const previous = (await db.collection('mutationRequests').doc(mutationId).get()).data;
    return ok(previous.result);
  } catch (error) {
    // 首次请求继续执行
  }

  const result = await db.runTransaction(async (transaction) => {
    const cart = (await transaction.collection('coupleCarts').doc(coupleId).get()).data;
    if (!cart.items?.length) return fail('EMPTY_CART', '心愿单还是空的');
    const orderId = randomId('order');
    const order = {
      _id: orderId,
      coupleId,
      createdAt: now(),
      createdBy: openid,
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
      id: order._id,
      items: order.items,
      note: order.note,
      orderNo: order.orderNo,
      status: order.status,
    })),
  });
};

const importLegacy = async (openid, event) => {
  const { coupleId, user } = await getMemberContext(openid);
  if (user.legacyMigratedAt) return ok({ imported: false, reason: 'already_imported' });
  const legacy = event.legacy || {};
  const importedConfig = legacy.config ? sanitizeConfig(legacy.config) : null;
  if (importedConfig) {
    const validationError = validateConfig(importedConfig);
    if (validationError) return fail('INVALID_LEGACY_DATA', validationError);
    await db.collection('coupleConfigs').doc(coupleId).update({
      data: { ...importedConfig, updatedAt: now(), updatedBy: openid, version: _.inc(1) },
    });
  }
  if (Array.isArray(legacy.cart)) {
    await updateCart(openid, { items: legacy.cart });
  }
  const orders = Array.isArray(legacy.orders) ? legacy.orders.slice(0, 100) : [];
  for (const legacyOrder of orders) {
    const legacyItems = (Array.isArray(legacyOrder.items) ? legacyOrder.items : []).slice(0, 100).map((item) => ({
      cost: String(item.cost || '一份小心意').slice(0, 40),
      image: String(item.image || '').slice(0, 500),
      menuItemId: String(item.menuItemId || item.id || '').slice(0, 64),
      name: String(item.name || item.nameSnapshot || '旧心愿').slice(0, 30),
      quantity: Math.max(1, Math.min(99, Number(item.quantity) || 1)),
    }));
    await db.collection('orders').add({
      data: {
        coupleId,
        createdAt: new Date(legacyOrder.createdAt || Date.now()),
        createdBy: openid,
        items: legacyItems,
        note: String(legacyOrder.note || '').slice(0, 100),
        orderNo: String(legacyOrder.id || `LOVE-${Date.now()}`),
        status: String(legacyOrder.status || '等待回应'),
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
    if (event.action === 'getConfig') return getConfig(OPENID);
    if (event.action === 'saveConfig') return saveConfig(OPENID, event);
    if (event.action === 'getCart') return getCart(OPENID);
    if (event.action === 'updateCart') return updateCart(OPENID, event);
    if (event.action === 'createOrder') return createOrder(OPENID, event);
    if (event.action === 'getOrders') return getOrders(OPENID, event);
    if (event.action === 'importLegacy') return importLegacy(OPENID, event);
    return fail('UNKNOWN_ACTION', '不支持的操作');
  } catch (error) {
    console.error('dataApi error', error.code || error.message);
    return fail(error.code || 'SERVER_ERROR', error.message || '云端数据服务暂时不可用');
  }
};
