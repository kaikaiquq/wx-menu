const TabMenu = require('./data');
const { getTotal, syncTabBar } = require('../utils/chat-unread');

const getStoredThemeClass = () => {
  const gender = wx.getStorageSync('couple.menu.gender');
  if (gender === 'male') return 'theme-male';
  if (gender === 'female') return 'theme-female';
  return '';
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
      this.setData({ chatUnread: getTotal() });
    },
  },

  pageLifetimes: {
    show() {
      this.setData({ chatUnread: getTotal() });
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
        chatUnread: getTotal(),
        themeClass: getStoredThemeClass(),
      });
      syncTabBar();
    },
  },
});
