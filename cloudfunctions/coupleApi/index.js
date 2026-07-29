const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const INVITE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const ok = (data) => ({ data, ok: true });
const fail = (code, message) => ({ code, message, ok: false });
const now = () => db.serverDate();
const randomId = (prefix) => `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
const hashCode = (code) => crypto.createHash('sha256').update(code).digest('hex');

const createCode = () =>
  Array.from({ length: 8 }, () => INVITE_ALPHABET[crypto.randomInt(0, INVITE_ALPHABET.length)]).join('');

const createMergedId = (type, sourceCoupleId, originalId) =>
  `${type}_${crypto.createHash('sha1').update(`${sourceCoupleId}:${originalId}`).digest('hex').slice(0, 20)}`;

const getUser = async (openid) => {
  try {
    return (await db.collection('users').doc(openid).get()).data;
  } catch (error) {
    return null;
  }
};

const sanitizeInitialConfig = (config = {}) => {
  const categories = Array.isArray(config.categories) ? config.categories.slice(0, 50) : [];
  const menuItems = Array.isArray(config.menuItems) ? config.menuItems.slice(0, 300) : [];
  return {
    categories: categories.map((item) => ({
      icon: String(item.icon || '♡').slice(0, 4),
      id: String(item.id || randomId('category')).slice(0, 64),
      name: String(item.name || '未分类').slice(0, 20),
      subtitle: String(item.subtitle || '').slice(0, 40),
    })),
    menuItems: menuItems.map((item) => ({
      badge: String(item.badge || '').slice(0, 20),
      categoryId: String(item.categoryId || '').slice(0, 64),
      cost: String(item.cost || '一份小心意').slice(0, 40),
      description: String(item.description || '').slice(0, 100),
      id: String(item.id || randomId('menu')).slice(0, 64),
      image: String(item.image || '').slice(0, 500),
      name: String(item.name || '新的小心愿').slice(0, 30),
    })),
    profile: {
      anniversary: String(config.profile?.anniversary || '').slice(0, 10),
      herName: String(config.profile?.herName || '她').slice(0, 20),
      hisName: String(config.profile?.hisName || '他').slice(0, 20),
      message: String(config.profile?.message || '写下一句想记住的话').slice(0, 80),
    },
  };
};

const mergeCoupleContent = (targetConfig, sourceConfig, targetCart, sourceCart, sourceCoupleId) => {
  const categories = [...(targetConfig.categories || [])];
  const menuItems = [...(targetConfig.menuItems || [])];
  const categoryIds = new Set(categories.map((item) => item.id));
  const menuItemIds = new Set(menuItems.map((item) => item.id));
  const categoryIdMap = {};
  const menuItemIdMap = {};

  (sourceConfig.categories || []).forEach((sourceCategory) => {
    const existing = categories.find((item) => item.id === sourceCategory.id);
    if (!existing) {
      categories.push(sourceCategory);
      categoryIds.add(sourceCategory.id);
      categoryIdMap[sourceCategory.id] = sourceCategory.id;
      return;
    }
    const isSame =
      existing.name === sourceCategory.name &&
      existing.icon === sourceCategory.icon &&
      existing.subtitle === sourceCategory.subtitle;
    if (isSame) {
      categoryIdMap[sourceCategory.id] = existing.id;
      return;
    }
    let mergedId = createMergedId('category', sourceCoupleId, sourceCategory.id);
    while (categoryIds.has(mergedId)) mergedId = `${mergedId.slice(0, 60)}_${categories.length}`;
    categories.push({ ...sourceCategory, id: mergedId });
    categoryIds.add(mergedId);
    categoryIdMap[sourceCategory.id] = mergedId;
  });

  (sourceConfig.menuItems || []).forEach((sourceItem) => {
    const mappedCategoryId = categoryIdMap[sourceItem.categoryId] || sourceItem.categoryId;
    const existing = menuItems.find((item) => item.id === sourceItem.id);
    const comparableSource = { ...sourceItem, categoryId: mappedCategoryId };
    if (!existing) {
      menuItems.push(comparableSource);
      menuItemIds.add(sourceItem.id);
      menuItemIdMap[sourceItem.id] = sourceItem.id;
      return;
    }
    const isSame = ['badge', 'categoryId', 'cost', 'description', 'image', 'name'].every(
      (key) => existing[key] === comparableSource[key],
    );
    if (isSame) {
      menuItemIdMap[sourceItem.id] = existing.id;
      return;
    }
    let mergedId = createMergedId('menu', sourceCoupleId, sourceItem.id);
    while (menuItemIds.has(mergedId)) mergedId = `${mergedId.slice(0, 60)}_${menuItems.length}`;
    menuItems.push({ ...comparableSource, id: mergedId });
    menuItemIds.add(mergedId);
    menuItemIdMap[sourceItem.id] = mergedId;
  });

  if (categories.length > 50 || menuItems.length > 300) {
    return { error: fail('MERGE_LIMIT', '双方菜单内容较多，请先精简后再合并') };
  }

  const cartById = new Map();
  (targetCart.items || []).forEach((item) => cartById.set(item.id, { ...item }));
  (sourceCart.items || []).forEach((item) => {
    const id = menuItemIdMap[item.id] || item.id;
    const menuItem = menuItems.find((candidate) => candidate.id === id);
    if (!menuItem) return;
    const existing = cartById.get(id);
    cartById.set(id, {
      ...menuItem,
      quantity: Math.min(99, (existing?.quantity || 0) + Math.max(1, Number(item.quantity) || 1)),
    });
  });
  const cartItems = Array.from(cartById.values());
  if (cartItems.length > 100) return { error: fail('MERGE_LIMIT', '双方心愿单内容较多，请先精简后再合并') };

  return {
    cartItems,
    config: {
      categories,
      menuItems,
      profile: targetConfig.profile,
    },
  };
};

const getOrdersForCopy = async (coupleId) => {
  const orders = [];
  const batchSize = 100;
  while (orders.length <= 500) {
    const result = await db
      .collection('orders')
      .where({ coupleId })
      .orderBy('createdAt', 'asc')
      .skip(orders.length)
      .limit(batchSize)
      .get();
    orders.push(...result.data);
    if (result.data.length < batchSize) break;
  }
  return orders;
};

const copyOrders = async (orders, targetCoupleId, copiedBy) => {
  const copiedOrderIds = [];
  for (let index = 0; index < orders.length; index += 20) {
    const batch = orders.slice(index, index + 20);
    const ids = await Promise.all(
      batch.map(async (order) => {
        const { _id: sourceOrderId, ...orderData } = order;
        const orderId = randomId('order');
        const isActive = ['等待回应', '进行中'].includes(order.status);
        await db.collection('orders').doc(orderId).set({
          data: {
            ...orderData,
            copiedAt: now(),
            copiedBy,
            copiedFromOrderId: sourceOrderId,
            coupleId: targetCoupleId,
            status: isActive ? '已取消' : order.status,
            updatedAt: now(),
            version: Math.max(1, Number(order.version) || 1) + (isActive ? 1 : 0),
          },
        });
        return orderId;
      }),
    );
    copiedOrderIds.push(...ids);
  }
  return copiedOrderIds;
};

const createInvite = async (openid, initialConfig) => {
  const user = await getUser(openid);
  if (!user?.profileCompleted) return fail('PROFILE_REQUIRED', '请先完善头像和昵称');

  let coupleId = user.coupleId;
  if (!coupleId) {
    coupleId = randomId('couple');
    const config = sanitizeInitialConfig(initialConfig);
    await db.runTransaction(async (transaction) => {
      const freshUser = (await transaction.collection('users').doc(openid).get()).data;
      if (freshUser.coupleId) {
        coupleId = freshUser.coupleId;
        return;
      }
      await transaction.collection('couples').doc(coupleId).set({
        data: {
          activeInviteId: null,
          createdAt: now(),
          createdBy: openid,
          members: [openid],
          status: 'pending',
          updatedAt: now(),
          version: 1,
        },
      });
      await transaction.collection('coupleConfigs').doc(coupleId).set({
        data: {
          ...config,
          coupleId,
          createdAt: now(),
          updatedAt: now(),
          updatedBy: openid,
          version: 1,
        },
      });
      await transaction.collection('coupleCarts').doc(coupleId).set({
        data: {
          coupleId,
          createdAt: now(),
          items: [],
          updatedAt: now(),
          updatedBy: openid,
          version: 1,
        },
      });
      await transaction.collection('users').doc(openid).update({
        data: { coupleId, updatedAt: now(), version: _.inc(1) },
      });
    });
  }

  const couple = (await db.collection('couples').doc(coupleId).get()).data;
  if (!couple.members.includes(openid) || couple.members.length >= 2) {
    return fail('COUPLE_COMPLETE', '情侣空间已经完成绑定');
  }

  await db.collection('coupleInvites').where({ coupleId, status: 'active' }).update({
    data: { status: 'revoked', updatedAt: now() },
  });

  const code = createCode();
  const inviteId = randomId('invite');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await db.collection('coupleInvites').doc(inviteId).set({
    data: {
      codeHash: hashCode(code),
      coupleId,
      createdAt: now(),
      createdBy: openid,
      expiresAt,
      status: 'active',
      updatedAt: now(),
      usedBy: null,
    },
  });
  await db.collection('couples').doc(coupleId).update({
    data: { activeInviteId: inviteId, updatedAt: now(), version: _.inc(1) },
  });
  return ok({ code, coupleId, expiresAt: expiresAt.getTime() });
};

const joinCouple = async (openid, rawCode, rawAnniversary, allowMerge = false) => {
  const code = String(rawCode || '').trim().toUpperCase();
  const anniversary = String(rawAnniversary || '').trim();
  const anniversaryDate = new Date(`${anniversary}T00:00:00`);
  if (code.length !== 8) return fail('INVALID_INVITE', '请输入 8 位邀请码');
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(anniversary) ||
    Number.isNaN(anniversaryDate.getTime()) ||
    anniversaryDate > new Date()
  ) {
    return fail('INVALID_ANNIVERSARY', '请选择正确的在一起日期');
  }
  const inviteLookup = await db
    .collection('coupleInvites')
    .where({ codeHash: hashCode(code), status: 'active' })
    .limit(1)
    .get();
  if (!inviteLookup.data.length) return fail('INVALID_INVITE', '邀请码不存在或已失效');
  const inviteId = inviteLookup.data[0]._id;
  let mergedFromCoupleId = '';
  const result = await db.runTransaction(async (transaction) => {
    const user = (await transaction.collection('users').doc(openid).get()).data;
    if (!user.profileCompleted) return fail('PROFILE_REQUIRED', '请先完善头像和昵称');
    const invite = (await transaction.collection('coupleInvites').doc(inviteId).get()).data;
    if (invite.status !== 'active') return fail('INVITE_USED', '该邀请码已被使用');
    if (new Date(invite.expiresAt).getTime() < Date.now()) {
      return fail('INVITE_EXPIRED', '邀请码已过期');
    }
    if (invite.createdBy === openid) return fail('SELF_JOIN', '不能加入自己创建的空间');
    const couple = (await transaction.collection('couples').doc(invite.coupleId).get()).data;
    if (couple.members.includes(openid)) return ok({ coupleId: couple._id });
    if (couple.members.length >= 2) return fail('INVITE_USED', '该邀请码已被使用');
    const targetConfig = (await transaction.collection('coupleConfigs').doc(invite.coupleId).get()).data;

    if (user.coupleId && user.coupleId !== invite.coupleId) {
      const sourceCouple = (await transaction.collection('couples').doc(user.coupleId).get()).data;
      const canMerge =
        sourceCouple &&
        sourceCouple.status === 'pending' &&
        sourceCouple.members.length === 1 &&
        sourceCouple.members[0] === openid;
      if (!canMerge) return fail('ALREADY_BOUND', '你已经绑定了其他情侣空间');
      if (!allowMerge) return fail('MERGE_REQUIRED', '加入后会合并你当前空间的菜单和历史内容');

      const sourceConfig = (await transaction.collection('coupleConfigs').doc(user.coupleId).get()).data;
      const targetCart = (await transaction.collection('coupleCarts').doc(invite.coupleId).get()).data;
      const sourceCart = (await transaction.collection('coupleCarts').doc(user.coupleId).get()).data;
      const merged = mergeCoupleContent(
        targetConfig,
        sourceConfig,
        targetCart,
        sourceCart,
        user.coupleId,
      );
      if (merged.error) return merged.error;

      await transaction.collection('coupleConfigs').doc(invite.coupleId).update({
        data: {
          ...merged.config,
          profile: { ...merged.config.profile, anniversary },
          updatedAt: now(),
          updatedBy: openid,
          version: _.inc(1),
        },
      });
      await transaction.collection('coupleCarts').doc(invite.coupleId).update({
        data: {
          items: merged.cartItems,
          updatedAt: now(),
          updatedBy: openid,
          version: _.inc(1),
        },
      });
      await transaction.collection('couples').doc(user.coupleId).update({
        data: {
          activeInviteId: null,
          mergedInto: invite.coupleId,
          status: 'dissolved',
          updatedAt: now(),
          version: _.inc(1),
        },
      });
      mergedFromCoupleId = user.coupleId;
    }

    await transaction.collection('couples').doc(invite.coupleId).update({
      data: {
        activeInviteId: null,
        members: _.addToSet(openid),
        status: 'active',
        updatedAt: now(),
        version: _.inc(1),
      },
    });
    await transaction.collection('coupleInvites').doc(invite._id).update({
      data: { status: 'used', updatedAt: now(), usedBy: openid },
    });
    await transaction.collection('users').doc(openid).update({
      data: { coupleId: invite.coupleId, updatedAt: now(), version: _.inc(1) },
    });
    if (!mergedFromCoupleId) {
      await transaction.collection('coupleConfigs').doc(invite.coupleId).update({
        data: {
          profile: { ...targetConfig.profile, anniversary },
          updatedAt: now(),
          updatedBy: openid,
          version: _.inc(1),
        },
      });
    }
    return ok({ coupleId: invite.coupleId, merged: Boolean(mergedFromCoupleId) });
  });
  if (result.ok && mergedFromCoupleId) {
    await db
      .collection('orders')
      .where({ coupleId: mergedFromCoupleId, status: _.in(['等待回应', '进行中']) })
      .update({
        data: {
          status: '已取消',
          updatedAt: now(),
          updatedBy: openid,
        },
      });
    await db.collection('orders').where({ coupleId: mergedFromCoupleId }).update({
      data: {
        coupleId: inviteLookup.data[0].coupleId,
        mergedAt: now(),
        mergedFrom: mergedFromCoupleId,
        updatedAt: now(),
        updatedBy: openid,
      },
    });
    await db.collection('coupleInvites').where({ coupleId: mergedFromCoupleId, status: 'active' }).update({
      data: { status: 'revoked', updatedAt: now() },
    });
  }
  return result;
};

const unbindPartner = async (openid) => {
  const user = await getUser(openid);
  if (!user?.coupleId) return fail('COUPLE_REQUIRED', '当前没有绑定情侣空间');
  const couple = (await db.collection('couples').doc(user.coupleId).get()).data;
  if (!couple.members.includes(openid)) return fail('FORBIDDEN', '没有操作该空间的权限');
  if (couple.members.length < 2) return fail('PARTNER_NOT_FOUND', '当前还没有绑定另一位成员');
  const partnerOpenid = couple.members.find((memberOpenid) => memberOpenid !== openid);
  const partnerCoupleId = randomId('couple');
  const orders = await getOrdersForCopy(user.coupleId);
  if (orders.length > 500) return fail('COPY_LIMIT', '共同记录较多，暂时无法自动拆分，请联系客服处理');

  let copiedOrderIds = [];
  let splitCompleted = false;
  try {
    copiedOrderIds = await copyOrders(orders, partnerCoupleId, openid);
    const result = await db.runTransaction(async (transaction) => {
      const freshCouple = (await transaction.collection('couples').doc(user.coupleId).get()).data;
      if (
        freshCouple.members.length !== 2 ||
        !freshCouple.members.includes(openid) ||
        !freshCouple.members.includes(partnerOpenid)
      ) {
        return fail('COUPLE_CHANGED', '情侣空间状态已经变化，请刷新后重试');
      }
      const activeInvite = freshCouple.activeInviteId
        ? (await transaction.collection('coupleInvites').doc(freshCouple.activeInviteId).get()).data
        : null;
      const config = (await transaction.collection('coupleConfigs').doc(user.coupleId).get()).data;
      const cart = (await transaction.collection('coupleCarts').doc(user.coupleId).get()).data;
      const activeOrders = orders.filter((order) => ['等待回应', '进行中'].includes(order.status));
      for (const activeOrder of activeOrders) {
        await transaction.collection('orders').doc(activeOrder._id).get();
      }
      const configData = { ...config };
      const cartData = { ...cart };
      delete configData._id;
      delete cartData._id;

      await transaction.collection('couples').doc(partnerCoupleId).set({
        data: {
          activeInviteId: null,
          copiedFrom: user.coupleId,
          createdAt: now(),
          createdBy: partnerOpenid,
          members: [partnerOpenid],
          status: 'pending',
          updatedAt: now(),
          version: 1,
        },
      });
      await transaction.collection('coupleConfigs').doc(partnerCoupleId).set({
        data: {
          ...configData,
          coupleId: partnerCoupleId,
          copiedAt: now(),
          copiedFrom: user.coupleId,
          createdAt: now(),
          updatedAt: now(),
          updatedBy: partnerOpenid,
          version: 1,
        },
      });
      await transaction.collection('coupleCarts').doc(partnerCoupleId).set({
        data: {
          ...cartData,
          coupleId: partnerCoupleId,
          copiedAt: now(),
          copiedFrom: user.coupleId,
          createdAt: now(),
          updatedAt: now(),
          updatedBy: partnerOpenid,
          version: 1,
        },
      });
      await transaction.collection('couples').doc(user.coupleId).update({
        data: {
          activeInviteId: null,
          members: [openid],
          status: 'pending',
          updatedAt: now(),
          version: _.inc(1),
        },
      });
      await transaction.collection('users').doc(partnerOpenid).update({
        data: { coupleId: partnerCoupleId, updatedAt: now(), version: _.inc(1) },
      });
      if (activeInvite?.status === 'active') {
        await transaction.collection('coupleInvites').doc(activeInvite._id).update({
          data: { status: 'revoked', updatedAt: now() },
        });
      }
      for (const activeOrder of activeOrders) {
        await transaction.collection('orders').doc(activeOrder._id).update({
          data: {
            status: '已取消',
            updatedAt: now(),
            updatedBy: openid,
            version: _.inc(1),
          },
        });
      }
      return ok({
        copiedOrders: copiedOrderIds.length,
        coupleId: user.coupleId,
        partnerCoupleId,
        removed: true,
      });
    });
    if (!result.ok) {
      await db.collection('orders').where({ coupleId: partnerCoupleId }).remove();
      return result;
    }
    splitCompleted = true;
    return result;
  } catch (error) {
    if (!splitCompleted) {
      const freshPartner = await getUser(partnerOpenid);
      if (freshPartner?.coupleId === partnerCoupleId) {
        return ok({
          copiedOrders: copiedOrderIds.length,
          coupleId: user.coupleId,
          partnerCoupleId,
          removed: true,
        });
      }
      await db.collection('orders').where({ coupleId: partnerCoupleId }).remove();
    }
    throw error;
  }
};

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  try {
    if (event.action === 'createInvite') return createInvite(OPENID, event.initialConfig);
    if (event.action === 'joinCouple') {
      return joinCouple(OPENID, event.code, event.anniversary, Boolean(event.allowMerge));
    }
    if (event.action === 'unbindPartner') return unbindPartner(OPENID);
    return fail('UNKNOWN_ACTION', '不支持的操作');
  } catch (error) {
    console.error('coupleApi error', error.code || error.message);
    return fail('SERVER_ERROR', '情侣绑定服务暂时不可用');
  }
};
