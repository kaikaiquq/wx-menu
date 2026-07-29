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
  const result = await db.runTransaction(async (transaction) => {
    const user = (await transaction.collection('users').doc(openid).get()).data;
    if (!user.profileCompleted) return fail('PROFILE_REQUIRED', '请先完善头像和昵称');
    const invite = (await transaction.collection('coupleInvites').doc(inviteId).get()).data;
    if (invite.status !== 'active') return fail('INVITE_USED', '该邀请码已被使用');
    if (new Date(invite.expiresAt).getTime() < Date.now()) {
      return fail('INVITE_EXPIRED', '邀请码已过期');
    }
    if (invite.createdBy === openid) return fail('SELF_JOIN', '不能加入自己创建的空间');
    if (user.coupleId && user.coupleId !== invite.coupleId) {
      return fail('ALREADY_BOUND', '你已经绑定了其他情侣空间');
    }

    const couple = (await transaction.collection('couples').doc(invite.coupleId).get()).data;
    if (couple.members.includes(openid)) return ok({ coupleId: couple._id });
    if (couple.members.length >= 2) return fail('INVITE_USED', '该邀请码已被使用');

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
    const config = (await transaction.collection('coupleConfigs').doc(invite.coupleId).get()).data;
    await transaction.collection('coupleConfigs').doc(invite.coupleId).update({
      data: {
        profile: { ...config.profile, anniversary },
        updatedAt: now(),
        updatedBy: openid,
        version: _.inc(1),
      },
    });
    return ok({ coupleId: invite.coupleId });
  });
  return result;
};

const unbindPartner = async (openid) => {
  const user = await getUser(openid);
  if (!user?.coupleId) return fail('COUPLE_REQUIRED', '当前没有绑定情侣空间');
  const result = await db.runTransaction(async (transaction) => {
    const couple = (await transaction.collection('couples').doc(user.coupleId).get()).data;
    if (!couple.members.includes(openid)) return fail('FORBIDDEN', '没有操作该空间的权限');
    if (couple.members.length < 2) return fail('PARTNER_NOT_FOUND', '当前还没有绑定另一位成员');
    const partnerOpenid = couple.members.find((memberOpenid) => memberOpenid !== openid);
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
      data: { coupleId: null, updatedAt: now(), version: _.inc(1) },
    });
    return ok({ coupleId: user.coupleId, removed: true });
  });
  await db.collection('coupleInvites').where({ coupleId: user.coupleId, status: 'active' }).update({
    data: { status: 'revoked', updatedAt: now() },
  });
  return result;
};

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  try {
    if (event.action === 'createInvite') return createInvite(OPENID, event.initialConfig);
    if (event.action === 'joinCouple') return joinCouple(OPENID, event.code, event.anniversary);
    if (event.action === 'unbindPartner') return unbindPartner(OPENID);
    return fail('UNKNOWN_ACTION', '不支持的操作');
  } catch (error) {
    console.error('coupleApi error', error.code || error.message);
    return fail('SERVER_ERROR', '情侣绑定服务暂时不可用');
  }
};
