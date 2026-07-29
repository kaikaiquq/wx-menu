const TabMenu = require('./data');

const getStoredThemeClass = () => {
  const gender = wx.getStorageSync('couple.menu.gender');
  if (gender === 'male') return 'theme-male';
  if (gender === 'female') return 'theme-female';
  return '';
};

Component({
  data: {
    active: 0,
    list: TabMenu,
    themeClass: getStoredThemeClass(),
  },

  methods: {
    onChange(event) {
      const index = Number(event.currentTarget.dataset.index);
      if (index === this.data.active) return;
      this.setData({ active: index });
      wx.switchTab({ url: this.data.list[index].url });
    },

    init() {
      const page = getCurrentPages().pop();
      const route = page ? page.route.split('?')[0] : '';
      const active = this.data.list.findIndex((item) => item.url.slice(1) === route);
      this.setData({
        active: active < 0 ? 0 : active,
        themeClass: getStoredThemeClass(),
      });
    },
  },
});
