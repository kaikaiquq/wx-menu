/**
 * 全局聊天未读：
 * - 暂时关闭全局轮询（getUnreadSummary），避免后台一直打云函数
 * - 仅消息页内自行轮询；读消息时用 syncFromConversations 更新角标
 * - watch chatSignals 仍可尝试（失败不影响）
 */
const { ensureChatSignal, getUnreadSummary } = require('./chat');
const { getCloud, initCloud } = require('./cloud');
const { getSelfOpenid, isLoggedOut } = require('./auth');

const POLL_MS = 3000;
const UNREAD_STORAGE_KEY = 'couple.menu.chatUnread';

/** 临时开关：全局未读轮询（true 才在任意 Tab 轮询） */
const ENABLE_GLOBAL_POLL = false;

let totalUnread = Math.max(0, Number(wx.getStorageSync(UNREAD_STORAGE_KEY) || 0));
let started = false;
let refreshing = false;
let pendingRefresh = false;
let signalWatcher = null;
let signalWatchReady = false;
let pollTimer = null;
let usingWatch = false;
let watchedOpenid = '';
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
    const app = getApp();
    if (app?.globalData) app.globalData.chatUnread = count;
  } catch (error) {
    // ignore
  }

  try {
    const pages = getCurrentPages() || [];
    pages.forEach((page) => {
      if (!page || typeof page.getTabBar !== 'function') return;
      const tabBar = page.getTabBar();
      if (!tabBar) return;
      if (typeof tabBar.setChatUnread === 'function') {
        tabBar.setChatUnread(count);
      } else {
        tabBar.setData({ chatUnread: count });
      }
    });
  } catch (error) {
    // 非 Tab 页忽略
  }
};

const setTotal = (count, { forceTab = false, reason = '' } = {}) => {
  const next = Math.max(0, Number(count) || 0);
  const changed = next !== totalUnread;
  totalUnread = next;
  try {
    wx.setStorageSync(UNREAD_STORAGE_KEY, next);
  } catch (error) {
    // ignore
  }
  if (changed || forceTab) applyToTabBar(next);
  if (changed) emit({ type: 'total', reason, total: next });
  return next;
};

const syncTabBar = () => applyToTabBar(totalUnread);

const sumUnread = (conversations = []) =>
  conversations.reduce((sum, item) => sum + Math.max(0, Number(item.unreadCount || 0)), 0);

/** 用本地会话列表立刻校正角标（读消息清未读时） */
const syncFromConversations = (conversations = []) =>
  setTotal(sumUnread(conversations), { forceTab: true, reason: 'local' });

const refresh = async (reason = 'poll') => {
  if (refreshing) {
    pendingRefresh = true;
    return totalUnread;
  }
  if (isLoggedOut()) {
    setTotal(0, { forceTab: true, reason: 'logout' });
    return 0;
  }
  const openid = getSelfOpenid();
  if (!openid) return totalUnread;

  refreshing = true;
  try {
    const data = await getUnreadSummary();
    const next = Math.max(0, Number(data?.total || 0));
    setTotal(next, { forceTab: true, reason });
    emit({ type: 'poll', reason, total: next, byId: data?.byId || {} });
    return next;
  } catch (error) {
    console.warn('chat unread refresh failed', error?.message || error);
    return totalUnread;
  } finally {
    refreshing = false;
    if (pendingRefresh) {
      pendingRefresh = false;
      refresh('queued');
    }
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
  watchedOpenid = '';
};

const stopPolling = () => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
};

const startPolling = () => {
  // 暂时关闭全局轮询：仅消息页内轮询
  if (!ENABLE_GLOBAL_POLL) return;
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    refresh('interval');
  }, POLL_MS);
};

const handleSignal = (conversationId) => {
  emit({ type: 'signal', conversationId: conversationId || '' });
  // 全局轮询关闭时，信标只通知订阅方（消息页），不主动打 getUnreadSummary
  if (ENABLE_GLOBAL_POLL) {
    refresh('signal');
  }
};

const startSignalWatch = (openid) => {
  if (!openid) return false;
  try {
    const cloud = getCloud();
    if (!cloud?.database) return false;
    const db = cloud.database();
    stopSignalWatch();
    signalWatchReady = false;
    watchedOpenid = openid;
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
        console.warn('global chatSignals watch failed', error);
        stopSignalWatch();
        // 不再因 watch 失败开启全局轮询
        // startPolling();
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
    if (openid !== watchedOpenid) {
      startSignalWatch(openid);
    }
    // startPolling();
    // refresh('restart');
    return;
  }
  started = true;
  syncTabBar();

  try {
    await initCloud();
  } catch (error) {
    console.warn('chat-unread initCloud failed', error);
  }

  // try {
  //   await ensureChatSignal();
  // } catch (error) {
  //   console.warn('ensureChatSignal failed', error?.message || error);
  // }

  // startPolling();
  startSignalWatch(openid);
  // refresh('start');
};

const stop = () => {
  started = false;
  stopSignalWatch();
  stopPolling();
  pendingRefresh = false;
  setTotal(0, { forceTab: true, reason: 'stop' });
};

/** App / Tab 回到前台：暂不触发未读轮询 */
const onAppShow = () => {
  if (isLoggedOut() || !getSelfOpenid()) return;
  if (!started) {
    start();
    return;
  }
  syncTabBar();
  // startPolling();
  // refresh('appShow');
};

module.exports = {
  getTotal,
  onAppShow,
  refresh,
  start,
  stop,
  subscribe,
  syncFromConversations,
  syncTabBar,
};
