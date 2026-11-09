/**
 * 应用级聊天通知：每个前台登录会话只监听自己的 chatSignals 文档。
 * 信标是失效通知，首次快照/真实变更才合并读取摘要；不定时查询消息。
 */
const { ensureChatSignal, getUnreadSummary } = require('./chat');
const { getCloud, initCloud } = require('./cloud');
const { getSession, isLoggedOut } = require('./auth');

const STORAGE_KEY = 'couple.menu.chatUnread.v2';
const MAX_RETRIES = 5;
const listeners = new Set();
let totalUnread = 0;
let byId = {};
let userId = '';
let foreground = true;
let online = true;
let started = false;
let status = 'stopped';
let generation = 0;
let watcher = null;
let connecting = null;
let signalEnsured = false;
let retryAttempt = 0;
let retryTimer = null;
let snapshotTimer = null;
let refreshTimer = null;
let refreshFlight = null;
let refreshPending = false;
let notifyPending = false;
let networkBound = false;
let activeConversation = '';
let lastToastAt = 0;
let watchCallbackDepth = 0;

const count = (value) => (Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0);
const getTotal = () => totalUnread;
const getState = () => ({ status, total: totalUnread, byId: { ...byId } });
const subscribe = (fn) => {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const emit = (event) => {
  listeners.forEach((fn) => {
    try { fn(event); } catch (error) { console.warn('chat notification listener failed', error); }
  });
};
const setStatus = (next) => {
  if (status === next) return;
  status = next;
  emit({ type: 'status', status });
};
const syncTabBar = () => {
  try {
    const app = getApp();
    if (app && app.globalData) app.globalData.chatUnread = totalUnread;
    (getCurrentPages() || []).forEach((page) => {
      const tabBar = page.getTabBar?.();
      if (tabBar?.setChatUnread) tabBar.setChatUnread(totalUnread);
    });
  } catch (error) { /* 页面尚未创建时，Tab attached 会读取 getTotal */ }
};
const applySummary = (summary, reason) => {
  const nextById = {};
  Object.keys(summary.byId || {}).forEach((id) => { nextById[id] = count(summary.byId[id]); });
  byId = nextById;
  // byId 是同一服务端快照的完整集合，避免两个来源相互覆盖角标。
  totalUnread = Object.values(byId).reduce((sum, value) => sum + value, 0);
  if (userId) {
    try { wx.setStorageSync(STORAGE_KEY, { openid: userId, byId }); } catch (error) { /* 缓存非必需 */ }
  }
  syncTabBar();
  emit({ type: 'summary', reason, total: totalUnread, byId: { ...byId } });
};
const valid = (epoch) => epoch === generation && started && foreground && online && !isLoggedOut();

const inWatchCallback = (callback) => (...args) => {
  watchCallbackDepth += 1;
  try { return callback(...args); } finally { watchCallbackDepth -= 1; }
};
const closeWatch = (target, defer = watchCallbackDepth > 0) => {
  if (!target?.close) return;
  const close = () => {
    try {
      const result = target.close();
      if (result?.catch) result.catch((error) => console.warn('close chat watch failed', error));
    } catch (error) { console.warn('close chat watch failed', error); }
  };
  // SDK 在通知回调返回后仍会推进内部状态；不能在回调中把它切成 CLOSED。
  // 代际和本地引用立即失效，底层连接在下一任务关闭，迟到事件会被 valid 拦截。
  if (defer) setTimeout(close, 0);
  else close();
};
const closeConnection = () => {
  generation += 1;
  const old = watcher;
  watcher = null;
  connecting = null;
  if (retryTimer) clearTimeout(retryTimer);
  if (snapshotTimer) clearTimeout(snapshotTimer);
  if (refreshTimer) clearTimeout(refreshTimer);
  retryTimer = snapshotTimer = refreshTimer = null;
  refreshFlight = null;
  refreshPending = notifyPending = false;
  closeWatch(old);
};

const notifyNewMessages = (previous) => {
  if (!foreground || Date.now() - lastToastAt < 5000) return;
  const hasOtherUnread = Object.keys(byId).some((id) => id !== activeConversation && byId[id] > count(previous[id]));
  if (!hasOtherUnread) return;
  lastToastAt = Date.now();
  wx.showToast({ title: '收到新消息，请到「消息」查看', icon: 'none', duration: 2500 });
};

const refresh = (reason = 'manual') => {
  if (!started || !foreground || !online || isLoggedOut()) return Promise.resolve(totalUnread);
  if (refreshFlight) {
    refreshPending = true;
    return refreshFlight;
  }
  const epoch = generation;
  const request = (async () => {
    try {
      const summary = await getUnreadSummary();
      if (!valid(epoch)) return totalUnread;
      const previous = byId;
      applySummary(summary || {}, reason);
      retryAttempt = 0;
      if (notifyPending) notifyNewMessages(previous);
      if (!refreshPending) notifyPending = false;
      return totalUnread;
    } catch (error) {
      if (valid(epoch)) {
        console.warn('chat unread summary failed', error?.message || error);
        handleFailure(error, epoch, 'summary');
      }
      return totalUnread;
    } finally {
      if (refreshFlight === request) {
        refreshFlight = null;
        if (refreshPending && valid(epoch)) {
          refreshPending = false;
          scheduleRefresh('queued');
        }
      }
    }
  })();
  refreshFlight = request;
  return request;
};
const scheduleRefresh = (reason) => {
  // 信号在去抖窗口内到达时也要记账，不能让较旧请求先返回后消耗掉新提示。
  if (refreshFlight) refreshPending = true;
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refresh(reason);
  }, 100);
};

const isConfigurationError = (error) => /permission|permission_denied|unauthorized|access.?denied|not.?exist|not.?found|unauthenticated|无权限|权限|集合不存在/i.test(
  `${error?.code || ''} ${error?.errCode || ''} ${error?.message || ''} ${error?.errMsg || ''}`,
);
const handleFailure = (error, epoch, source = 'watch') => {
  if (!valid(epoch)) return;
  console.warn('chat realtime unavailable', source, error?.code || error?.errCode || '', error?.message || error?.errMsg || '');
  closeConnection();
  if (isConfigurationError(error) || retryAttempt >= MAX_RETRIES) {
    setStatus('error');
    return;
  }
  const delay = Math.min(30000, 1000 * (2 ** retryAttempt)) + Math.floor(Math.random() * 300);
  retryAttempt += 1;
  setStatus('reconnecting');
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, delay);
};

const connect = () => {
  if (!started || !foreground || !online || isLoggedOut() || watcher || connecting) return connecting;
  const epoch = generation;
  setStatus(retryAttempt ? 'reconnecting' : 'connecting');
  const request = (async () => {
    let failureSource = 'ensure';
    try {
      await initCloud();
      if (!valid(epoch)) return;
      if (!signalEnsured) {
        await ensureChatSignal();
        if (!valid(epoch)) return;
        signalEnsured = true;
      }
      let first = true;
      let lastFingerprint = '';
      let lastMessageVersion = 0;
      failureSource = 'watch-open';
      const nextWatcher = getCloud().database().collection('chatSignals').doc(userId).watch({
        onChange: inWatchCallback((snapshot) => {
          if (!valid(epoch)) return;
          const doc = snapshot.docs?.[0];
          if (!doc) {
            signalEnsured = false;
            // 空快照不能区分文档缺失和读取规则过滤，重新 ensure 后有界重连。
            const error = Object.assign(new Error('chatSignals snapshot contains no readable document'), { code: 'CHAT_SIGNAL_UNAVAILABLE' });
            handleFailure(error, epoch, 'watch-snapshot');
            return;
          }
          if (snapshotTimer) clearTimeout(snapshotTimer);
          snapshotTimer = null;
          const fingerprint = JSON.stringify([doc.bump, doc.messageVersion, doc.messageId, doc.updatedAt]);
          if (!first && fingerprint === lastFingerprint) return;
          const initial = first;
          const messageVersion = count(doc.messageVersion);
          const isMessage = !initial && (typeof doc.messageVersion === 'number'
            ? messageVersion > lastMessageVersion
            : doc.kind !== 'state');
          first = false;
          lastFingerprint = fingerprint;
          lastMessageVersion = messageVersion;
          setStatus('connected');
          if (!valid(epoch)) return;
          if (isMessage) notifyPending = true;
          emit({ type: 'signal', initial, kind: isMessage ? 'message' : 'state', conversationId: doc.conversationId || '' });
          if (valid(epoch)) scheduleRefresh(initial ? 'snapshot' : 'signal');
        }),
        onError: inWatchCallback((error) => handleFailure(error, epoch, 'watch-error')),
      });
      // 某些 SDK/测试实现可能同步回调 onError，不能把已经失效的 watcher 留下。
      if (!valid(epoch)) {
        closeWatch(nextWatcher, true);
        return;
      }
      watcher = nextWatcher;
      if (first) {
        snapshotTimer = setTimeout(() => handleFailure(new Error('chat watch snapshot timeout'), epoch, 'watch-timeout'), 15000);
      }
    } catch (error) {
      handleFailure(error, epoch, failureSource);
    } finally {
      if (connecting === request) connecting = null;
    }
  })();
  connecting = request;
  return request;
};

const bindNetwork = () => {
  if (networkBound || typeof wx.onNetworkStatusChange !== 'function') return;
  networkBound = true;
  wx.onNetworkStatusChange(({ isConnected }) => {
    const wasOnline = online;
    online = Boolean(isConnected);
    if (!started || !foreground) return;
    if (!online) {
      closeConnection();
      setStatus('offline');
    } else if (!wasOnline) {
      retryAttempt = 0;
      connect();
    }
  });
};
const start = () => {
  if (isLoggedOut()) return Promise.resolve();
  // 只采用本次认证成功的身份，不能使用上一个登录用户遗留的 storage openid。
  const openid = getSession()?.user?.openid;
  if (!openid) return Promise.resolve();
  bindNetwork();
  if (openid !== userId) {
    closeConnection();
    setStatus('stopped');
    userId = openid;
    signalEnsured = false;
    retryAttempt = 0;
    activeConversation = '';
    lastToastAt = 0;
    let cached;
    try { cached = wx.getStorageSync(STORAGE_KEY); } catch (error) { /* 无缓存 */ }
    applySummary(cached?.openid === openid ? cached : {}, 'identity');
  }
  started = true;
  syncTabBar();
  if (!foreground) { setStatus('paused'); return Promise.resolve(); }
  if (!online) { setStatus('offline'); return Promise.resolve(); }
  // 普通页面 start 不重置失败预算；仅手动/前台/网络恢复可重新尝试。
  if (retryTimer || status === 'error') return Promise.resolve();
  return connect() || Promise.resolve();
};
const stop = () => {
  closeConnection();
  started = false;
  userId = '';
  signalEnsured = false;
  activeConversation = '';
  retryAttempt = 0;
  try { wx.removeStorageSync(STORAGE_KEY); } catch (error) { /* 缓存非必需 */ }
  applySummary({}, 'logout');
  setStatus('stopped');
};
const onAppHide = () => {
  foreground = false;
  activeConversation = '';
  closeConnection();
  if (started) setStatus('paused');
};
const onAppShow = () => {
  const resumed = !foreground;
  foreground = true;
  if (resumed || status === 'error') retryAttempt = 0;
  if (status === 'error') setStatus('stopped');
  return start();
};
const retry = () => {
  closeConnection();
  retryAttempt = 0;
  signalEnsured = false;
  setStatus('stopped');
  return start();
};
const setActiveConversation = (id) => { activeConversation = id || ''; };

module.exports = { getTotal, getState, onAppShow, onAppHide, refresh, retry, start, stop, subscribe, syncTabBar, setActiveConversation };
