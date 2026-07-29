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
      _id: openid,
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
    await db.collection('users').add({ data: user });
    return user;
  }
};

const publicUser = (user) => ({
  avatarFileId: user.avatarFileId || '',
  coupleId: user.coupleId || null,
  gender: user.gender || '',
  nickname: user.nickname || '',
  profileCompleted: Boolean(user.profileCompleted && user.gender),
  publicUserId: user.publicUserId,
});

const bootstrap = async (openid) => {
  const user = await getUser(openid);
  let couple = null;

  if (user.coupleId) {
    try {
      const coupleRecord = (await db.collection('couples').doc(user.coupleId).get()).data;
      if (coupleRecord.members.includes(openid) && coupleRecord.status !== 'dissolved') {
        let members = [];
        try {
          const memberResult = await db
            .collection('users')
            .where({ _id: _.in(coupleRecord.members) })
            .limit(10)
            .get();
          const byId = Object.fromEntries((memberResult.data || []).map((item) => [item._id, item]));
          members = coupleRecord.members.map((memberOpenid) => byId[memberOpenid]).filter(Boolean);
        } catch (batchError) {
          // 兼容部分环境不支持 _id + _.in，回退逐个读取
          members = await Promise.all(
            coupleRecord.members.map(async (memberOpenid) => {
              const member = await db.collection('users').doc(memberOpenid).get();
              return member.data;
            }),
          );
        }
        couple = {
          coupleId: coupleRecord._id,
          members: members.map(publicUser),
          status: coupleRecord.status,
          version: coupleRecord.version,
        };
      }
    } catch (error) {
      console.error('读取情侣空间失败', error.code || error.message);
    }
  }

  return ok({ couple, user: publicUser(user) });
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
