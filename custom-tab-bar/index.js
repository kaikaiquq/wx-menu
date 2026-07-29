import TabMenu from './data';
Component({
  data: {
    active: 0,
    list: TabMenu,
    themeClass: 'theme-female',
  },

  methods: {
    onChange(event) {
      this.setData({ active: event.detail.value });
      wx.switchTab({
        url: this.data.list[event.detail.value].url.startsWith('/')
          ? this.data.list[event.detail.value].url
          : `/${this.data.list[event.detail.value].url}`,
      });
    },

    init() {
      const page = getCurrentPages().pop();
      const route = page ? page.route.split('?')[0] : '';
      const active = this.data.list.findIndex(
        (item) =>
          (item.url.startsWith('/') ? item.url.substr(1) : item.url) ===
          `${route}`,
      );
      const gender = wx.getStorageSync('couple.menu.gender');
      this.setData({ active, themeClass: gender === 'male' ? 'theme-male' : 'theme-female' });
    },
  },
});
