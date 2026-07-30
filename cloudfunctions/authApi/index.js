const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const ok = (data) => ({ data, ok: true });
const fail = (code, message) => ({ code, message, ok: false });
const now = () => db.serverDate();

const getUser = async (openid) => {
  try {
    return (await db.collection('users').doc(openid).get()).data;
  } catch (error) {
    if (error.errCode !== -1 && !String(error.message).includes('not exist')) throw error;
    const user = {
      avatarFileId: '',
      coupleId: null,
      createdAt: now(),
      gender: '',
      nickname: '',
      profileCompleted: false,
      publicUserId: crypto.randomBytes(9).toString('hex'),
      updatedAt: now(),
      version: 1,
    };
    // 必须用 doc(openid).set，保证 _id === openid，情侣成员才能互相读到
    await db.collection('users').doc(openid).set({ data: user });
    return { _id: openid, ...user };
  }
};

const publicUser = (user) => ({
  avatarFileId: user.avatarFileId || '',
  avatarUrl: '',
  coupleId: user.coupleId || null,
  gender: user.gender || '',
  nickname: user.nickname || '',
  profileCompleted: Boolean(user.profileCompleted && user.gender),
  publicUserId: user.publicUserId,
});

/** 云函数侧换临时链：可读取任意用户上传的头像（客户端受「仅创建者可读写」限制） */
const attachAvatarUrls = async (users) => {
  const list = (users || []).map((user) => ({ ...user }));
  const fileList = [
    ...new Set(list.map((user) => user.avatarFileId).filter((id) => id && id.startsWith('cloud://'))),
  ];
  if (!fileList.length) return list;
  try {
    const { fileList: result } = await cloud.getTempFileURL({ fileList });
    const urlMap = {};
    (result || []).forEach((item) => {
      if (item.fileID && item.tempFileURL && (!item.status || item.status === 0)) {
        urlMap[item.fileID] = item.tempFileURL;
      }
    });
    return list.map((user) => ({
      ...user,
      avatarUrl: urlMap[user.avatarFileId] || '',
    }));
  } catch (error) {
    console.warn('attachAvatarUrls failed', error.message || error);
    return list;
  }
};

const loadCoupleMembers = async (memberOpenids = []) => {
  const members = await Promise.all(
    memberOpenids.map(async (memberOpenid) => {
      try {
        return (await db.collection('users').doc(memberOpenid).get()).data;
      } catch (error) {
        console.warn('loadCoupleMember failed', memberOpenid, error.message || error);
        return null;
      }
    }),
  );
  return members.filter(Boolean).map(publicUser);
};

const bootstrap = async (openid) => {
  const user = await getUser(openid);
  let couple = null;

  if (user.coupleId) {
    try {
      const coupleRecord = (await db.collection('couples').doc(user.coupleId).get()).data;
      if (coupleRecord.members.includes(openid) && coupleRecord.status !== 'dissolved') {
        const members = await loadCoupleMembers(coupleRecord.members);
        couple = {
          coupleId: coupleRecord._id,
          members,
          status: coupleRecord.status,
          version: coupleRecord.version,
        };
      }
    } catch (error) {
      console.error('读取情侣空间失败', error.code || error.message);
    }
  }

  const [selfUser, coupleWithAvatars] = await Promise.all([
    attachAvatarUrls([publicUser(user)]).then((list) => list[0]),
    couple
      ? attachAvatarUrls(couple.members).then((members) => ({ ...couple, members }))
      : Promise.resolve(null),
  ]);

  return ok({ couple: coupleWithAvatars, user: selfUser });
};

const updateProfile = async (openid, event) => {
  const nickname = String(event.nickname || '').trim();
  const avatarFileId = String(event.avatarFileId || '').trim();
  const gender = String(event.gender || '');
  if (!nickname || nickname.length > 20) {
    return fail('INVALID_NICKNAME', '昵称长度应为 1-20 个字符');
  }
  if (avatarFileId && !avatarFileId.startsWith('cloud://')) {
    return fail('INVALID_AVATAR', '头像必须先上传到云存储');
  }
  if (!['female', 'male'].includes(gender)) {
    return fail('INVALID_GENDER', '请选择性别');
  }

  await getUser(openid);
  await db.collection('users').doc(openid).update({
    data: {
      avatarFileId,
      gender,
      nickname,
      profileCompleted: true,
      updatedAt: now(),
      version: _.inc(1),
    },
  });
  return ok({ updated: true });
};

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  try {
    if (event.action === 'bootstrap') return bootstrap(OPENID);
    if (event.action === 'updateProfile') return updateProfile(OPENID, event);
    return fail('UNKNOWN_ACTION', '不支持的操作');
  } catch (error) {
    console.error('authApi error', error.code || error.message);
    return fail('SERVER_ERROR', '登录服务暂时不可用');
  }
};
