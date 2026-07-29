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
const isNotFound = (error) =>
  error?.errCode === -1 || String(error?.message || '').toLowerCase().includes('not exist');

const createCode = () =>
  Array.from({ length: 8 }, () => INVITE_ALPHABET[crypto.randomInt(0, INVITE_ALPHABET.length)]).join('');

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

const createEmptySharedConfig = (anniversary = '') => ({
  categories: [],
  menuItems: [],
  profile: {
    anniversary,
    herName: '她',
    hisName: '他',
    message: '',
  },
});

const ensurePersonalLibrary = async (openid, coupleId) => {
  try {
    await db.collection('userConfigs').doc(openid).get();
    return;
  } catch (error) {
    if (!isNotFound(error)) throw error;
    let config = {
      categories: [{ icon: '♡', id: 'personal-default', name: '未分类', subtitle: '我喜欢的内容' }],
      menuItems: [],
      profile: { anniversary: '', herName: '她', hisName: '他', message: '' },
    };
    if (coupleId) {
      try {
        const couple = (await db.collection('couples').doc(coupleId).get()).data;
        if (
          couple.status === 'pending' &&
          couple.members.length === 1 &&
          couple.members[0] === openid
        ) {
          const source = (await db.collection('coupleConfigs').doc(coupleId).get()).data;
          config = sanitizeInitialConfig(source);
        }
      } catch (sourceError) {
        if (!isNotFound(sourceError)) throw sourceError;
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
  }
};

const createInvite = async (openid) => {
  const user = await getUser(openid);
  if (!user?.profileCompleted) return fail('PROFILE_REQUIRED', '请先完善头像和昵称');
  await ensurePersonalLibrary(openid, user.coupleId);

  let coupleId = user.coupleId;
  if (!coupleId) {
    coupleId = randomId('couple');
    const config = createEmptySharedConfig();
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
      codeValue: code,
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

const getActiveInvite = async (openid) => {
  const user = await getUser(openid);
  if (!user?.coupleId) return ok({ code: '', expiresAt: 0 });
  const couple = (await db.collection('couples').doc(user.coupleId).get()).data;
  if (!couple.members.includes(openid) || couple.members.length >= 2) {
    return ok({ code: '', expiresAt: 0 });
  }
  if (couple.activeInviteId) {
    try {
      const invite = (await db.collection('coupleInvites').doc(couple.activeInviteId).get()).data;
      if (
        invite.status === 'active' &&
        invite.codeValue &&
        new Date(invite.expiresAt).getTime() > Date.now()
      ) {
        return ok({
          code: invite.codeValue,
          coupleId: couple._id,
          expiresAt: new Date(invite.expiresAt).getTime(),
        });
      }
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  return createInvite(openid);
};

const joinCouple = async (openid, rawCode, rawAnniversary) => {
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
  const joiningUser = await getUser(openid);
  await ensurePersonalLibrary(openid, joiningUser?.coupleId);
  await ensurePersonalLibrary(inviteLookup.data[0].createdBy, inviteLookup.data[0].coupleId);

  const sharedCoupleId = randomId('couple');
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
    const inviter = (await transaction.collection('users').doc(invite.createdBy).get()).data;
    if (couple.members.includes(openid)) return ok({ coupleId: couple._id });
    if (
      couple.status !== 'pending' ||
      couple.members.length !== 1 ||
      couple.members[0] !== invite.createdBy ||
      inviter.coupleId !== invite.coupleId
    ) {
      return fail('INVITE_USED', '该邀请码已被使用');
    }

    let sourceCouple = null;
    let sourceInvite = null;
    if (user.coupleId && user.coupleId !== invite.coupleId) {
      sourceCouple = (await transaction.collection('couples').doc(user.coupleId).get()).data;
      const canLeave =
        sourceCouple &&
        sourceCouple.status === 'pending' &&
        sourceCouple.members.length === 1 &&
        sourceCouple.members[0] === openid;
      if (!canLeave) return fail('ALREADY_BOUND', '你已经绑定了其他情侣空间');
      sourceInvite = sourceCouple.activeInviteId
        ? (await transaction.collection('coupleInvites').doc(sourceCouple.activeInviteId).get()).data
        : null;
    }

    const emptySharedConfig = createEmptySharedConfig(anniversary);
    await transaction.collection('couples').doc(sharedCoupleId).set({
      data: {
        activeInviteId: null,
        activatedAt: now(),
        createdAt: now(),
        createdBy: invite.createdBy,
        members: [invite.createdBy, openid],
        status: 'active',
        updatedAt: now(),
        version: 1,
      },
    });
    await transaction.collection('coupleConfigs').doc(sharedCoupleId).set({
      data: {
        ...emptySharedConfig,
        activatedAt: now(),
        coupleId: sharedCoupleId,
        createdAt: now(),
        updatedAt: now(),
        updatedBy: openid,
        version: 1,
      },
    });
    await transaction.collection('coupleCarts').doc(sharedCoupleId).set({
      data: {
        coupleId: sharedCoupleId,
        createdAt: now(),
        items: [],
        updatedAt: now(),
        updatedBy: openid,
        version: 1,
      },
    });
    await transaction.collection('couples').doc(invite.coupleId).update({
      data: {
        activeInviteId: null,
        mergedInto: sharedCoupleId,
        status: 'dissolved',
        updatedAt: now(),
        version: _.inc(1),
      },
    });
    if (sourceCouple) {
      await transaction.collection('couples').doc(user.coupleId).update({
        data: {
          activeInviteId: null,
          mergedInto: sharedCoupleId,
          status: 'dissolved',
          updatedAt: now(),
          version: _.inc(1),
        },
      });
      if (sourceInvite?.status === 'active') {
        await transaction.collection('coupleInvites').doc(sourceInvite._id).update({
          data: { status: 'revoked', updatedAt: now() },
        });
      }
    }
    await transaction.collection('coupleInvites').doc(invite._id).update({
      data: { status: 'used', updatedAt: now(), usedBy: openid },
    });
    await transaction.collection('users').doc(invite.createdBy).update({
      data: {
        archivedCoupleIds: _.addToSet(invite.coupleId),
        coupleId: sharedCoupleId,
        updatedAt: now(),
        version: _.inc(1),
      },
    });
    const joiningUserUpdate = {
      coupleId: sharedCoupleId,
      updatedAt: now(),
      version: _.inc(1),
    };
    if (sourceCouple) joiningUserUpdate.archivedCoupleIds = _.addToSet(user.coupleId);
    await transaction.collection('users').doc(openid).update({
      data: joiningUserUpdate,
    });
    return ok({ coupleId: sharedCoupleId, sharedSpaceEmpty: true });
  });
  return result;
};

const clearCoupleOrders = async (coupleId) => {
  while (true) {
    const result = await db.collection('orders').where({ coupleId }).limit(100).get();
    if (!result.data.length) return;
    for (let index = 0; index < result.data.length; index += 20) {
      await Promise.all(
        result.data
          .slice(index, index + 20)
          .map((order) => db.collection('orders').doc(order._id).remove()),
      );
    }
  }
};

const unbindPartner = async (openid) => {
  const user = await getUser(openid);
  if (!user?.coupleId) return fail('COUPLE_REQUIRED', '当前没有绑定情侣空间');
  const couple = (await db.collection('couples').doc(user.coupleId).get()).data;
  if (!couple.members.includes(openid)) return fail('FORBIDDEN', '没有操作该空间的权限');
  if (couple.status !== 'active' || couple.members.length < 2) {
    return fail('PARTNER_NOT_FOUND', '当前还没有绑定另一位成员');
  }
  const partnerOpenid = couple.members.find((memberOpenid) => memberOpenid !== openid);
  const result = await db.runTransaction(async (transaction) => {
    const freshCouple = (await transaction.collection('couples').doc(user.coupleId).get()).data;
    if (
      freshCouple.status !== 'active' ||
      freshCouple.members.length !== 2 ||
      !freshCouple.members.includes(openid) ||
      !freshCouple.members.includes(partnerOpenid)
    ) {
      return fail('COUPLE_CHANGED', '情侣空间状态已经变化，请刷新后重试');
    }
    const activeInvite = freshCouple.activeInviteId
      ? (await transaction.collection('coupleInvites').doc(freshCouple.activeInviteId).get()).data
      : null;
    await transaction.collection('coupleConfigs').doc(user.coupleId).get();
    await transaction.collection('coupleCarts').doc(user.coupleId).get();

    await transaction.collection('coupleConfigs').doc(user.coupleId).update({
      data: {
        ...createEmptySharedConfig(),
        clearedAt: now(),
        updatedAt: now(),
        updatedBy: openid,
        version: _.inc(1),
      },
    });
    await transaction.collection('coupleCarts').doc(user.coupleId).update({
      data: {
        items: [],
        updatedAt: now(),
        updatedBy: openid,
        version: _.inc(1),
      },
    });
    await transaction.collection('couples').doc(user.coupleId).update({
      data: {
        activeInviteId: null,
        dissolvedAt: now(),
        status: 'dissolved',
        updatedAt: now(),
        version: _.inc(1),
      },
    });
    await transaction.collection('users').doc(openid).update({
      data: { coupleId: null, updatedAt: now(), version: _.inc(1) },
    });
    await transaction.collection('users').doc(partnerOpenid).update({
      data: { coupleId: null, updatedAt: now(), version: _.inc(1) },
    });
    if (activeInvite?.status === 'active') {
      await transaction.collection('coupleInvites').doc(activeInvite._id).update({
        data: { status: 'revoked', updatedAt: now() },
      });
    }
    return ok({ removed: true });
  });
  if (result.ok) {
    try {
      await clearCoupleOrders(user.coupleId);
    } catch (error) {
      console.error('清理已解绑空间订单失败', error.message);
    }
  }
  return result;
};

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  try {
    if (event.action === 'createInvite') return createInvite(OPENID);
    if (event.action === 'getActiveInvite') return getActiveInvite(OPENID);
    if (event.action === 'joinCouple') return joinCouple(OPENID, event.code, event.anniversary);
    if (event.action === 'unbindPartner') return unbindPartner(OPENID);
    return fail('UNKNOWN_ACTION', '不支持的操作');
  } catch (error) {
    console.error('coupleApi error', error.code || error.message);
    if (error.errCode === -502005 || String(error.message).includes('collection not exists')) {
      return fail('COLLECTION_REQUIRED', '请先在云开发数据库创建 userConfigs 和 userOrders 集合');
    }
    return fail('SERVER_ERROR', '情侣绑定服务暂时不可用');
  }
};
