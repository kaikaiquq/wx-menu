const TabMenu = require('./data');
const { getTotal } = require('../utils/chat-unread');

const getStoredThemeClass = () => {
  const gender = wx.getStorageSync('couple.menu.gender');
  if (gender === 'male') return 'theme-male';
  if (gender === 'female') return 'theme-female';
  return '';
};

const readUnread = () => {
  try {
    const app = getApp();
    if (typeof app?.globalData?.chatUnread === 'number') {
      return Math.max(0, app.globalData.chatUnread);
    }
  } catch (error) {
    // ignore
  }
  return Math.max(0, Number(getTotal() || 0));
};

Component({
  data: {
    active: 0,
    chatUnread: 0,
    list: TabMenu,
    themeClass: getStoredThemeClass(),
  },

  lifetimes: {
    attached() {
      this.setData({ chatUnread: readUnread() });
    },
  },

  pageLifetimes: {
    show() {
      this.setData({ chatUnread: readUnread() });
    },
  },

  methods: {
    onChange(event) {
      const index = Number(event.currentTarget.dataset.index);
      if (index === this.data.active) return;
      this.setData({ active: index });
      wx.switchTab({ url: this.data.list[index].url });
    },

    setChatUnread(count) {
      const next = Math.max(0, Number(count) || 0);
      if (next === this.data.chatUnread) return;
      this.setData({ chatUnread: next });
    },

    init() {
      const page = getCurrentPages().pop();
      const route = page ? page.route.split('?')[0] : '';
      const active = this.data.list.findIndex((item) => item.url.slice(1) === route);
      this.setData({
        active: active < 0 ? 0 : active,
        chatUnread: readUnread(),
        themeClass: getStoredThemeClass(),
      });
    },
  },
});
