/** 前台位置共享单例：系统定位事件 -> 有界节流上传 -> 情侣文档 watch。没有位置查询轮询。 */
const { callCloud, getCloud, initCloud } = require('./cloud');
const MIN_UPLOAD_MS = 5000;
const STILL_UPLOAD_MS = 30000;
const MOVE_METERS = 20;
const MAX_RETRIES = 5;
const PREFERENCE_KEY = 'couple.menu.locationSharing.preference';
const listeners = new Set();
let identity = null;
let pageOpen = false;
let foreground = true;
let online = true;
let sharing = false;
let starting = false;
let permission = 'unknown';
let privacyContractName = '用户隐私保护指引';
let autoAttempted = false;
let status = 'idle';
let errorText = '';
let self = null;
let partner = null;
let token = '';
let remoteOwnToken = '';
let hideOwnSnapshot = false;
const pendingEnds = new Set();
let shareVersion = 0;
let version = -1;
let epoch = 0;
let shareEpoch = 0;
let watchEpoch = 0;
let watcher = null;
let opening = null;
let retryTimer = null;
let watchTimeout = null;
let retries = 0;
let gpsQueue = Promise.resolve();
let gpsHandler = null;
let gpsErrorHandler = null;
let gpsEpoch = 0;
let gpsStarting = null;
let networkBound = false;
let uploadTimer = null;
let uploading = null;
let pendingPoint = null;
let lastAttemptAt = 0;
let lastSentAt = 0;
let lastSentPoint = null;

const api = (action, data = {}) => callCloud('locationApi', action, data);
const wxCall = (name, options = {}) => new Promise((resolve, reject) => {
  if (typeof wx[name] !== 'function') {
    reject(Object.assign(new Error('当前微信版本不支持此定位功能，请升级微信'), { code: 'UNSUPPORTED' }));
    return;
  }
  wx[name]({ ...options, success: resolve, fail: reject });
});
const getState = () => ({
  status, sharing, starting, permission, privacyContractName, error: errorText,
  self: self ? { ...self } : null, partner: partner ? { ...partner } : null,
  coupleId: identity?.coupleId || '', selfOpenid: identity?.selfOpenid || '', partnerOpenid: identity?.partnerOpenid || '',
});
const emit = () => {
  const state = getState();
  listeners.forEach((fn) => { try { fn(state); } catch (error) { console.warn('location listener failed'); } });
};
const subscribe = (fn) => {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const wanted = () => Boolean(identity && foreground && online && (pageOpen || sharing || starting));
const active = (generation) => epoch === generation && Boolean(identity);
const safePoint = (point) => {
  if (!point || typeof point.latitude !== 'number' || typeof point.longitude !== 'number' ||
    !Number.isFinite(point.latitude) || !Number.isFinite(point.longitude) ||
    Math.abs(point.latitude) > 90 || Math.abs(point.longitude) > 180) return null;
  return {
    latitude: point.latitude, longitude: point.longitude,
    accuracy: Number.isFinite(point.accuracy) && point.accuracy >= 0 ? point.accuracy : 0,
    updatedAt: Number(point.updatedAt) || Date.now(),
  };
};
const metersBetween = (a, b) => {
  if (!a || !b) return Infinity;
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLng = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
};
const friendlyError = (error) => {
  const code = error?.code || '';
  const message = String(error?.errMsg || error?.message || '');
  if (/COUPLE_|FORBIDDEN/.test(code)) return '情侣绑定已变化，请重新进入位置页';
  if (code === 'SESSION_REPLACED') return '共享已在另一设备开启，请重新选择是否共享';
  if (/auth deny|auth denied|authorize:fail|scope.userLocation|permission/i.test(message)) return '未获得位置权限，可前往设置后重新开启';
  if (/privacy/i.test(message)) return '请先同意隐私保护指引，再开启位置共享';
  if (/requiredPrivateInfos|api scope|no permission|not support|接口未开通/i.test(message) || code === 'UNSUPPORTED') return '定位能力暂不可用，请确认微信版本和定位接口配置';
  return '位置同步失败，请检查网络后重试';
};
const clearUpload = () => {
  if (uploadTimer) clearTimeout(uploadTimer);
  uploadTimer = null;
  pendingPoint = null;
  uploading = null;
};
const closeWatch = () => {
  watchEpoch += 1;
  if (retryTimer) clearTimeout(retryTimer);
  if (watchTimeout) clearTimeout(watchTimeout);
  retryTimer = watchTimeout = null;
  const old = watcher;
  watcher = null;
  opening = null;
  try { old?.close(); } catch (error) { /* 已关闭 */ }
};
const stopGPS = () => {
  gpsEpoch += 1;
  gpsStarting = null;
  if (gpsHandler && typeof wx.offLocationChange === 'function') wx.offLocationChange(gpsHandler);
  if (gpsErrorHandler && typeof wx.offLocationChangeError === 'function') wx.offLocationChangeError(gpsErrorHandler);
  const hadGPS = Boolean(gpsHandler);
  gpsHandler = gpsErrorHandler = null;
  clearUpload();
  // 所有启停串行，避免旧 start 的成功回调在退后台后重新留下 GPS 监听。
  if (hadGPS) gpsQueue = gpsQueue.then(() => wxCall('stopLocationUpdate').catch(() => {}));
  return gpsQueue;
};
const endToken = async (oldToken) => {
  if (!oldToken) return { ended: false };
  pendingEnds.add(oldToken);
  try {
    const result = await api('end', { sessionId: oldToken });
    pendingEnds.delete(oldToken);
    return result;
  } catch (error) {
    // 解绑后无需保留清理任务；事务已撤销整个空间的位置读取权限。
    if (/COUPLE_/.test(error?.code || '')) { pendingEnds.delete(oldToken); return { ended: false }; }
    throw error;
  }
};
const flushEnds = async () => {
  await Promise.all([...pendingEnds].map((id) => endToken(id).catch(() => null)));
  if (!pendingEnds.size && errorText.includes('云端位置清除失败')) { errorText = ''; emit(); }
};
const stop = () => {
  const oldToken = token;
  epoch += 1;
  shareEpoch += 1;
  token = '';
  remoteOwnToken = '';
  hideOwnSnapshot = false;
  identity = null;
  sharing = starting = pageOpen = false;
  self = partner = null;
  permission = 'unknown';
  autoAttempted = false;
  status = 'idle'; errorText = '';
  version = -1; retries = 0;
  lastSentPoint = null; lastSentAt = lastAttemptAt = 0;
  closeWatch(); stopGPS(); emit();
  // 退出/换绑立即本地停止；服务端旧 token 不能覆盖另一次新共享。
  endToken(oldToken).catch(() => {});
};
const syncSession = (session) => {
  const selfOpenid = session?.user?.openid;
  const couple = session?.couple;
  const next = selfOpenid && couple?.status === 'active' && couple.members?.length === 2
    ? { selfOpenid, coupleId: couple.coupleId, partnerOpenid: '' } : null;
  if (identity && (!next || next.selfOpenid !== identity.selfOpenid || next.coupleId !== identity.coupleId)) stop();
  if (!identity && next) identity = next;
};
const revoke = (message) => {
  stop(); status = 'unbound'; errorText = message; emit();
};
const applyServerState = (doc) => {
  if (!doc || !identity) return;
  if (!doc.active || ![doc.memberA, doc.memberB].includes(identity.selfOpenid)) {
    revoke('情侣绑定已变化，位置共享已停止'); return;
  }
  if (Number(doc.version) < version) return;
  version = Number(doc.version) || 0;
  identity.partnerOpenid = doc.memberA === identity.selfOpenid ? doc.memberB : doc.memberA;
  const own = doc.positions?.[identity.selfOpenid];
  remoteOwnToken = own?.sessionId || '';
  partner = safePoint(doc.positions?.[identity.partnerOpenid]);
  if (sharing && version >= shareVersion && own?.sessionId !== token) {
    shareEpoch += 1; sharing = false; starting = false; token = '';
    stopGPS(); errorText = '位置共享已在其他设备更改，请重新开启';
  }
  // 自己的系统定位比上一份网络快照更及时，避免上传往返使地图跳回旧点。
  if ((!sharing || !self) && !hideOwnSnapshot) self = safePoint(own);
  emit();
};
const configurationError = (error) => /COLLECTION|FORBIDDEN|permission|not.?exist|not.?found|权限/i.test(
  `${error?.code || ''} ${error?.message || ''} ${error?.errMsg || ''}`,
);
const watchFailed = (error, generation, watchGeneration) => {
  if (!active(generation) || watchGeneration !== watchEpoch) return;
  closeWatch();
  // 权限撤销时立即移除他人敏感坐标，不能把失效快照继续当作授权数据展示。
  partner = null;
  if (/COUPLE_|FORBIDDEN/.test(error?.code || '')) { revoke(friendlyError(error)); return; }
  status = 'error'; errorText = friendlyError(error); emit();
  if (!wanted() || configurationError(error) || retries >= MAX_RETRIES) return;
  const delay = 1000 * (2 ** retries) + Math.floor(Math.random() * 250);
  retries += 1;
  status = 'reconnecting'; emit();
  retryTimer = setTimeout(() => { retryTimer = null; connect(); }, delay);
};
const connect = () => {
  if (!wanted() || watcher || opening || retryTimer) return opening || Promise.resolve();
  const generation = epoch;
  const watchGeneration = watchEpoch;
  status = 'connecting'; emit();
  const request = (async () => {
    try {
      await initCloud();
      const data = await api('ensure');
      if (!active(generation) || watchGeneration !== watchEpoch || !wanted()) return;
      if (data.coupleId !== identity.coupleId || data.selfOpenid !== identity.selfOpenid) {
        revoke('情侣绑定已变化，请重新进入位置页'); return;
      }
      applyServerState(data.state);
      if (!active(generation)) return;
      let received = false;
      const nextWatcher = getCloud().database().collection('coupleLocations').doc(identity.coupleId).watch({
        onChange(snapshot) {
          if (!active(generation) || watchGeneration !== watchEpoch || !wanted()) return;
          received = true;
          if (watchTimeout) clearTimeout(watchTimeout);
          watchTimeout = null;
          if (!snapshot.docs?.[0]) { revoke('位置共享已停止，请重新进入位置页'); return; }
          status = 'connected'; retries = 0;
          applyServerState(snapshot.docs[0]);
        },
        onError(error) { watchFailed(error, generation, watchGeneration); },
      });
      if (!active(generation) || watchGeneration !== watchEpoch || !wanted()) { nextWatcher?.close(); return; }
      watcher = nextWatcher;
      if (!received) watchTimeout = setTimeout(() => watchFailed(new Error('watch timeout'), generation, watchGeneration), 15000);
    } catch (error) {
      watchFailed(error, generation, watchGeneration);
    } finally {
      if (opening === request) opening = null;
    }
  })();
  opening = request;
  return request;
};
const scheduleUpload = (delay) => {
  if (uploadTimer) return;
  uploadTimer = setTimeout(() => { uploadTimer = null; flushUpload(); }, Math.max(1, delay));
};
const flushUpload = () => {
  if (!pendingPoint || uploading || !sharing || !foreground || !online || !token) return;
  const wait = MIN_UPLOAD_MS - (Date.now() - lastAttemptAt);
  if (wait > 0) { scheduleUpload(wait); return; }
  const point = pendingPoint;
  pendingPoint = null;
  const generation = epoch;
  const shareGeneration = shareEpoch;
  const locationGeneration = gpsEpoch;
  const currentToken = token;
  lastAttemptAt = Date.now();
  const request = (async () => {
    try {
      const result = await api('publish', { sessionId: currentToken, latitude: point.latitude, longitude: point.longitude, accuracy: point.accuracy });
      if (!active(generation) || shareGeneration !== shareEpoch || locationGeneration !== gpsEpoch || !sharing || !foreground) return;
      if (result.accepted) {
        lastSentAt = Date.now(); lastSentPoint = point; errorText = ''; emit();
      } else {
        pendingPoint = pendingPoint || point;
        scheduleUpload(Math.max(MIN_UPLOAD_MS, Number(result.retryAfterMs) || MIN_UPLOAD_MS));
      }
    } catch (error) {
      if (!active(generation) || shareGeneration !== shareEpoch || locationGeneration !== gpsEpoch) return;
      if (/COUPLE_|FORBIDDEN/.test(error?.code || '')) { revoke(friendlyError(error)); return; }
      if (error?.code === 'SESSION_REPLACED') {
        sharing = false; token = ''; shareEpoch += 1; stopGPS();
      }
      errorText = friendlyError(error); emit();
      // 等待下一次系统位置事件/网络恢复/手动重试，不用网络请求循环兜底。
    } finally {
      if (uploading === request) {
        uploading = null;
        if (pendingPoint && sharing && foreground && online) scheduleUpload(MIN_UPLOAD_MS);
      }
    }
  })();
  uploading = request;
};
const receiveLocation = (raw) => {
  if (!sharing || !foreground || !identity) return;
  const point = safePoint({ ...raw, updatedAt: Date.now() });
  if (!point) return;
  self = point; emit();
  if (!lastSentPoint || metersBetween(lastSentPoint, point) >= MOVE_METERS || Date.now() - lastSentAt >= STILL_UPLOAD_MS) {
    pendingPoint = point;
    flushUpload();
  } else if (pendingPoint) {
    // 移动后又返回原处也必须以最新点覆盖尚未发出的旧点。
    pendingPoint = point;
  }
};
const refreshPermission = async () => {
  const generation = epoch;
  try {
    const setting = await wxCall('getSetting');
    if (!active(generation)) return permission;
    const value = setting.authSetting?.['scope.userLocation'];
    permission = value === true ? 'granted' : value === false ? 'denied' : 'unknown';
    if (permission === 'denied' && sharing) await disableSharing();
    emit();
  } catch (error) { /* 已授权状态以定位接口最终结果为准 */ }
  return permission;
};
const startGPS = () => {
  if (!sharing || !foreground || gpsHandler || gpsStarting) return gpsStarting || Promise.resolve();
  const generation = epoch;
  const gpsGeneration = ++gpsEpoch;
  const valid = () => active(generation) && gpsGeneration === gpsEpoch && sharing && foreground;
  const request = gpsQueue.then(async () => {
    if (!valid()) return;
    if (typeof wx.onLocationChange !== 'function' || typeof wx.offLocationChange !== 'function') throw Object.assign(new Error('定位接口不支持'), { code: 'UNSUPPORTED' });
    let hasLivePoint = false;
    gpsHandler = (point) => { if (valid()) { hasLivePoint = true; receiveLocation(point); } };
    gpsErrorHandler = (error) => { if (valid()) { errorText = friendlyError(error); emit(); } };
    wx.onLocationChange(gpsHandler);
    if (typeof wx.onLocationChangeError === 'function') wx.onLocationChangeError(gpsErrorHandler);
    await wxCall('startLocationUpdate', { type: 'gcj02' });
    if (!valid()) return;
    // 首帧只取一次，后续仅依赖系统持续定位回调。
    wxCall('getLocation', { type: 'gcj02' }).then((point) => {
      if (valid() && !hasLivePoint) receiveLocation(point);
    }).catch(() => {});
  }).catch((error) => {
    if (!valid()) return;
    const oldToken = token;
    shareEpoch += 1; sharing = false; starting = false; token = '';
    errorText = friendlyError(error); stopGPS(); emit();
    endToken(oldToken).catch(() => {});
  }).finally(() => { if (gpsStarting === request) gpsStarting = null; });
  // 队列始终可继续，错误已转为可见状态。
  gpsQueue = request;
  gpsStarting = request;
  return request;
};
const preferenceStopped = () => {
  try {
    const stored = wx.getStorageSync(`${PREFERENCE_KEY}:${identity?.selfOpenid}:${identity?.coupleId}`);
    return stored?.selfOpenid === identity?.selfOpenid && stored?.coupleId === identity?.coupleId && stored.stopped;
  } catch (error) { return false; }
};
const savePreference = (stopped) => {
  if (!identity) return;
  try {
    wx.setStorageSync(`${PREFERENCE_KEY}:${identity.selfOpenid}:${identity.coupleId}`, {
      selfOpenid: identity.selfOpenid, coupleId: identity.coupleId, stopped,
    });
  } catch (error) { /* 不保存坐标 */ }
};
const enableSharing = async ({ automatic = false } = {}) => {
  if (sharing || starting) return;
  if (!identity || !foreground) { status = 'unbound'; errorText = '请先绑定伴侣'; emit(); return; }
  const generation = epoch;
  const shareGeneration = ++shareEpoch;
  const valid = () => active(generation) && shareGeneration === shareEpoch && foreground;
  starting = true; errorText = ''; emit();
  try {
    const settings = await wxCall('getSetting');
    if (!valid()) return;
    if (settings.authSetting?.['scope.userLocation'] === false) {
      permission = 'denied'; throw new Error('scope.userLocation auth denied');
    }
    if (automatic && autoAttempted && !settings.authSetting?.['scope.userLocation']) return;
    // 必需的隐私确认使用原生 agreePrivacyAuthorization 按钮；定位授权仍由微信弹窗完成。
    if (typeof wx.getPrivacySetting === 'function') {
      const privacy = await wxCall('getPrivacySetting');
      if (!valid()) return;
      if (privacy.needAuthorization) {
        permission = 'privacy';
        privacyContractName = privacy.privacyContractName || '用户隐私保护指引';
        emit(); return;
      }
    }
    if (!settings.authSetting?.['scope.userLocation']) {
      autoAttempted = true;
      await wxCall('authorize', { scope: 'scope.userLocation' });
    }
    if (!valid()) return;
    permission = 'granted';
    const data = await api('begin');
    if (!valid()) { endToken(data.sessionId).catch(() => {}); return; }
    if (data.coupleId !== identity.coupleId || data.selfOpenid !== identity.selfOpenid) {
      endToken(data.sessionId).catch(() => {}); revoke('情侣绑定已变化，请重新进入位置页'); return;
    }
    if (Number(data.state?.version) < version && remoteOwnToken !== data.sessionId) {
      endToken(data.sessionId).catch(() => {});
      throw Object.assign(new Error('共享会话已经变化'), { code: 'SESSION_REPLACED' });
    }
    token = data.sessionId;
    hideOwnSnapshot = false;
    shareVersion = Number(data.state?.version) || 0;
    sharing = true;
    savePreference(false);
    lastSentPoint = null; lastSentAt = lastAttemptAt = 0;
    applyServerState(data.state);
    retries = 0;
    if (!watcher) await connect();
    if (valid()) await startGPS();
  } catch (error) {
    if (valid()) {
      if (/auth deny|auth denied|authorize:fail/i.test(String(error?.errMsg || error?.message || ''))) permission = 'denied';
      errorText = friendlyError(error); emit();
    }
  } finally {
    if (active(generation) && shareGeneration === shareEpoch) { starting = false; emit(); }
  }
};
const autoEnable = () => {
  if (!pageOpen || preferenceStopped()) return Promise.resolve();
  return enableSharing({ automatic: true });
};
const disableSharing = async () => {
  const generation = epoch;
  const oldToken = token || remoteOwnToken;
  savePreference(true);
  shareEpoch += 1; token = ''; sharing = starting = false;
  const stopGeneration = shareEpoch;
  remoteOwnToken = ''; hideOwnSnapshot = true;
  self = null; lastSentPoint = null;
  stopGPS();
  emit();
  try {
    await endToken(oldToken);
    if (active(generation) && stopGeneration === shareEpoch) { errorText = ''; emit(); }
  } catch (error) {
    if (active(generation) && stopGeneration === shareEpoch) { errorText = '本机已停止定位，云端位置清除失败，请联网后重试'; emit(); }
  }
  if (!pageOpen && stopGeneration === shareEpoch) closeWatch();
};
const bindNetwork = () => {
  if (networkBound || typeof wx.onNetworkStatusChange !== 'function') return;
  networkBound = true;
  wx.onNetworkStatusChange(({ isConnected }) => {
    const wasOnline = online;
    online = Boolean(isConnected);
    if (online && !wasOnline) flushEnds();
    if (!identity || !foreground) return;
    if (!online) { closeWatch(); status = 'offline'; emit(); }
    else if (!wasOnline) { retries = 0; connect(); if (sharing && pendingPoint) flushUpload(); }
  });
};
const openPage = async (session) => {
  syncSession(session);
  pageOpen = true;
  bindNetwork();
  if (!identity) { status = 'unbound'; self = partner = null; emit(); return; }
  await refreshPermission();
  return connect();
};
const closePage = () => {
  pageOpen = false;
  if (starting && !sharing) { shareEpoch += 1; starting = false; }
  if (!sharing) closeWatch();
};
const onAppHide = () => {
  foreground = false;
  if (starting && !sharing) { shareEpoch += 1; starting = false; }
  closeWatch(); stopGPS();
  if (identity) { status = 'paused'; emit(); }
};
const onAppShow = async () => {
  foreground = true;
  flushEnds();
  if (!identity) return;
  retries = 0;
  await refreshPermission();
  await connect();
  if (sharing) await startGPS();
};
const retry = async () => {
  closeWatch(); retries = 0; errorText = '';
  await flushEnds();
  if (pendingEnds.size) errorText = '本机已停止定位，云端位置清除失败，请联网后重试';
  await connect();
  if (sharing) {
    await refreshPermission();
    await startGPS();
    if (self) { pendingPoint = self; flushUpload(); }
  }
};
module.exports = { getState, subscribe, openPage, closePage, autoEnable, enableSharing, disableSharing, refreshPermission, syncSession, stop, onAppShow, onAppHide, retry };
