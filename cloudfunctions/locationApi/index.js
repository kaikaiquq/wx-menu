const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const MIN_PUBLISH_INTERVAL_MS = 5000;
const ok = (data) => ({ ok: true, data });
const fail = (code, message) => ({ ok: false, code, message });
const reject = (code, message) => { throw Object.assign(new Error(message), { code }); };
const errorMessage = (error) => String(error?.message || error?.errMsg || error || '');
const isDocumentMissing = (error) =>
  /\bdocument(?:\s+with\s+_id\s+\S+)?\s+(?:does\s+)?not\s+(?:exists?|found)\b/i.test(errorMessage(error));
const isCollectionMissing = (error) =>
  error?.errCode === -502005 ||
  /collection (?:not exists|does not exist)|Db or Table not exist|DATABASE_COLLECTION_NOT_EXIST/i.test(errorMessage(error));

const readDocument = async (transaction, collection, id) => {
  try {
    return (await transaction.collection(collection).doc(id).get()).data || null;
  } catch (error) {
    if (isDocumentMissing(error) && !isCollectionMissing(error)) return null;
    throw error;
  }
};

// Every read/write uses current server-side membership in the same transaction.
// Reading the couple makes a concurrent unbind conflict and retry before publishing.
const readContext = async (transaction, openid) => {
  const user = await readDocument(transaction, 'users', openid);
  if (!user) reject('UNAUTHORIZED', '请先登录');
  if (!user.coupleId) reject('COUPLE_REQUIRED', '请先绑定另一半');
  const couple = await readDocument(transaction, 'couples', user.coupleId);
  if (
    !couple || couple.status !== 'active' || !Array.isArray(couple.members) ||
    couple.members.length !== 2 || new Set(couple.members).size !== 2 ||
    !couple.members.includes(openid)
  ) reject('COUPLE_CHANGED', '情侣绑定状态已变化，请刷新后重试');
  const partnerOpenid = couple.members.find((id) => id !== openid);
  const partner = await readDocument(transaction, 'users', partnerOpenid);
  if (partner?.coupleId !== user.coupleId) {
    reject('COUPLE_CHANGED', '情侣绑定状态已变化，请刷新后重试');
  }
  const stored = await readDocument(transaction, 'coupleLocations', user.coupleId);
  const valid = stored?.active === true &&
    stored.memberA === couple.members[0] && stored.memberB === couple.members[1];
  // Never revive coordinates belonging to a previous membership or revoked document.
  const state = valid ? stored : {
    active: true,
    memberA: couple.members[0],
    memberB: couple.members[1],
    positions: {},
    updatedAt: Date.now(),
    version: Number(stored?.version || 0),
  };
  return {
    coupleId: user.coupleId,
    selfOpenid: openid,
    partnerOpenid,
    state,
    needsCreate: !valid,
  };
};

const saveState = async (transaction, context, positions) => {
  const state = {
    active: true,
    memberA: context.state.memberA,
    memberB: context.state.memberB,
    positions,
    updatedAt: Date.now(),
    version: Number(context.state.version || 0) + 1,
  };
  await transaction.collection('coupleLocations').doc(context.coupleId).set({ data: state });
  context.state = state;
  return state;
};

const publicContext = ({ coupleId, selfOpenid, partnerOpenid, state }) => ({
  coupleId, selfOpenid, partnerOpenid, state,
});

const ensure = (openid) => db.runTransaction(async (transaction) => {
  const context = await readContext(transaction, openid);
  if (context.needsCreate) await saveState(transaction, context, {});
  return ok(publicContext(context));
});

const begin = (openid) => db.runTransaction(async (transaction) => {
  const context = await readContext(transaction, openid);
  const sessionId = crypto.randomBytes(24).toString('hex');
  await saveState(transaction, context, {
    ...(context.state.positions || {}),
    [openid]: { sessionId, sharing: true, updatedAt: Date.now() },
  });
  return ok({ ...publicContext(context), sessionId });
});

const validateCoordinates = (event) => {
  const { latitude, longitude, accuracy } = event;
  if (
    typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
    typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180 ||
    typeof accuracy !== 'number' || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 1000000
  ) reject('INVALID_COORDINATES', '定位坐标无效，请重新定位');
};

const publish = async (openid, event) => {
  validateCoordinates(event);
  return db.runTransaction(async (transaction) => {
    const context = await readContext(transaction, openid);
    const current = context.state.positions?.[openid];
    if (!current?.sharing || !event.sessionId || current.sessionId !== event.sessionId) {
      reject('SESSION_REPLACED', '位置共享已停止或已在其他设备开启');
    }
    const timestamp = Date.now();
    const elapsed = timestamp - Number(current.updatedAt || 0);
    if (Number.isFinite(current.latitude) && elapsed < MIN_PUBLISH_INTERVAL_MS) {
      return ok({
        accepted: false,
        updatedAt: current.updatedAt,
        retryAfterMs: MIN_PUBLISH_INTERVAL_MS - Math.max(0, elapsed),
      });
    }
    await saveState(transaction, context, {
      ...(context.state.positions || {}),
      [openid]: {
        sessionId: current.sessionId,
        sharing: true,
        latitude: event.latitude,
        longitude: event.longitude,
        accuracy: event.accuracy,
        updatedAt: timestamp,
      },
    });
    return ok({ accepted: true, updatedAt: timestamp, retryAfterMs: 0 });
  });
};

const end = (openid, event) => db.runTransaction(async (transaction) => {
  const context = await readContext(transaction, openid);
  const current = context.state.positions?.[openid];
  if (!event.sessionId || current?.sessionId !== event.sessionId) return ok({ ended: false });
  const positions = { ...(context.state.positions || {}) };
  delete positions[openid];
  await saveState(transaction, context, positions);
  return ok({ ended: true });
});

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return fail('UNAUTHORIZED', '请先登录');
  try {
    if (event.action === 'ensure') return await ensure(OPENID);
    if (event.action === 'begin') return await begin(OPENID);
    if (event.action === 'publish') return await publish(OPENID, event);
    if (event.action === 'end') return await end(OPENID, event);
    return fail('UNKNOWN_ACTION', '不支持的操作');
  } catch (error) {
    console.error('locationApi error', error.code || error.errCode || error.message);
    if (isCollectionMissing(error)) {
      return fail('COLLECTION_REQUIRED', '请先创建 coupleLocations 集合并配置安全规则');
    }
    const domainCodes = ['UNAUTHORIZED', 'COUPLE_REQUIRED', 'COUPLE_CHANGED', 'INVALID_COORDINATES', 'SESSION_REPLACED'];
    return domainCodes.includes(error.code)
      ? fail(error.code, error.message)
      : fail('SERVER_ERROR', '位置共享服务暂时不可用，请稍后重试');
  }
};
