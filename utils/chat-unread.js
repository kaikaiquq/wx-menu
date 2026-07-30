/**
 * 全局聊天未读：在任意 Tab 都能第一时间更新消息角标。
 * 优先 watch chatSignals；失败则 30s 轮询兜底。
 */
const { listConversations } = require('./chat');
const { getCloud, initCloud } = require('./cloud');
const { getSelfOpenid, isLoggedOut } = require('./auth');

const CHAT_TAB_INDEX = 2;
const POLL_MS = 30000;

let totalUnread = 0;
let started = false;
let refreshing = false;
let signalWatcher = null;
let signalWatchReady = false;
let pollTimer = null;
let usingWatch = false;
const listeners = new Set();

const getTotal = () => totalUnread;

const subscribe = (fn) => {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
};

const emit = (payload) => {
  listeners.forEach((fn) => {
    try {
      fn(payload);
    } catch (error) {
      console.warn('chat-unread listener error', error);
    }
  });
};

const applyToTabBar = (count) => {
  try {
    const pages = getCurrentPages();
    const page = pages[pages.length - 1];
    const tabBar = page && typeof page.getTabBar === 'function' ? page.getTabBar() : null;
    if (tabBar && typeof tabBar.setChatUnread === 'function') {
      tabBar.setChatUnread(count);
    } else if (tabBar) {
      tabBar.setData({ chatUnread: count });
    }
  } catch (error) {
    // 非 Tab 页没有 getTabBar，忽略
  }
};

const setTotal = (count, { forceTab = false } = {}) => {
  const next = Math.max(0, Number(count) || 0);
  const changed = next !== totalUnread;
  totalUnread = next;
  if (changed || forceTab) applyToTabBar(next);
  if (changed) emit({ type: 'total', total: next });
  return next;
};

const syncTabBar = () => applyToTabBar(totalUnread);

const sumUnread = (conversations = []) =>
  conversations.reduce((sum, item) => sum + Math.max(0, Number(item.unreadCount || 0)), 0);

/** 用本地会话列表立刻校正角标（读消息清未读时） */
const syncFromConversations = (conversations = []) => setTotal(sumUnread(conversations));

const refresh = async () => {
  if (refreshing) return totalUnread;
  if (isLoggedOut()) {
    setTotal(0, { forceTab: true });
    return 0;
  }
  const openid = getSelfOpenid();
  if (!openid) return totalUnread;

  refreshing = true;
  try {
    const { conversations } = await listConversations({ includeAvatars: false });
    return setTotal(sumUnread(conversations || []), { forceTab: true });
  } catch (error) {
    console.warn('chat unread refresh failed', error?.message || error);
    return totalUnread;
  } finally {
    refreshing = false;
  }
};

const stopSignalWatch = () => {
  if (signalWatcher && typeof signalWatcher.close === 'function') {
    try {
      signalWatcher.close();
    } catch (error) {
      // ignore
    }
  }
  signalWatcher = null;
  signalWatchReady = false;
  usingWatch = false;
};

const stopPolling = () => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
};

const startPolling = () => {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    refresh();
  }, POLL_MS);
};

const handleSignal = (conversationId) => {
  emit({ type: 'signal', conversationId: conversationId || '' });
  refresh();
};

const startSignalWatch = (openid) => {
  if (!openid) return false;
  try {
    const cloud = getCloud();
    if (!cloud?.database) return false;
    const db = cloud.database();
    stopSignalWatch();
    signalWatchReady = false;
    signalWatcher = db.collection('chatSignals').doc(openid).watch({
      onChange: (snapshot) => {
        if (!signalWatchReady) {
          signalWatchReady = true;
          return;
        }
        const doc =
          (snapshot.docs && snapshot.docs[0]) ||
          (snapshot.docChanges && snapshot.docChanges[0] && snapshot.docChanges[0].doc) ||
          null;
        handleSignal(doc?.conversationId || '');
      },
      onError: (error) => {
        console.warn('global chatSignals watch failed, fallback polling', error);
        stopSignalWatch();
        startPolling();
      },
    });
    usingWatch = true;
    return true;
  } catch (error) {
    console.warn('global chatSignals watch unavailable', error);
    return false;
  }
};

const start = async () => {
  if (isLoggedOut()) return;
  const openid = getSelfOpenid();
  if (!openid) return;

  if (started) {
    syncTabBar();
    refresh();
    return;
  }
  started = true;

  try {
    await initCloud();
  } catch (error) {
    console.warn('chat-unread initCloud failed', error);
  }

  refresh();

  if (startSignalWatch(openid)) {
    // watch 成功时仍保留低频轮询，防止漏推
    startPolling();
  } else {
    startPolling();
  }
};

const stop = () => {
  started = false;
  stopSignalWatch();
  stopPolling();
  setTotal(0, { forceTab: true });
};

/** App / Tab 回到前台时：确保监听在跑并立刻刷新 */
const onAppShow = () => {
  if (isLoggedOut() || !getSelfOpenid()) return;
  if (!started) {
    start();
    return;
  }
  syncTabBar();
  refresh();
  if (!usingWatch && !pollTimer) startPolling();
};

module.exports = {
  CHAT_TAB_INDEX,
  getTotal,
  onAppShow,
  refresh,
  start,
  stop,
  subscribe,
  syncFromConversations,
  syncTabBar,
};
