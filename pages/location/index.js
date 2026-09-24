const { requireSession } = require('../../utils/auth');
const locationSharing = require('../../utils/location-sharing');
const { getStoredThemeClass, getThemeColors, syncTheme } = require('../../utils/theme');

const STALE_MS = 90 * 1000;
const validPoint = (point) => Boolean(
  point && Number.isFinite(point.latitude) && Number.isFinite(point.longitude)
  && Math.abs(point.latitude) <= 90 && Math.abs(point.longitude) <= 180,
);
const pad = (value) => String(value).padStart(2, '0');
const describePoint = (point, now) => {
  if (!point) return { text: '尚未共享位置', stale: false };
  const updatedAt = Number(point.updatedAt) || 0;
  const age = Math.max(0, now - updatedAt);
  const stale = age > STALE_MS;
  if (!updatedAt) return { text: '更新时间未知，请等待新位置', stale: true };
  const time = new Date(updatedAt);
  const today = new Date(now);
  const dateText = time.toDateString() === today.toDateString()
    ? '' : `${time.getMonth() + 1}月${time.getDate()}日 `;
  const timeText = `${dateText}${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`;
  return { text: `${stale ? '超过 90 秒未更新' : '最近更新'} · ${timeText}`, stale };
};
const markerFor = (point, self, stale, theme) => ({
  id: self ? 1 : 2,
  latitude: point.latitude,
  longitude: point.longitude,
  width: 30,
  height: 38,
  iconPath: `/assets/location/${self ? 'self' : 'partner'}-${theme.key}.png`,
  anchor: { x: 0.5, y: 1 },
  zIndex: self ? 1 : 2,
  callout: {
    content: `${self ? '我' : 'TA'}${stale ? ' · 上次位置' : ''}`,
    display: 'ALWAYS',
    color: '#ffffff',
    fontSize: 12,
    borderRadius: 10,
    padding: 8,
    bgColor: self ? theme.colors.secondary : theme.colors.primary,
  },
});

Page({
  data: {
    themeClass: getStoredThemeClass(),
    loading: true,
    hasPartner: false,
    partnerName: 'TA',
    sharing: false,
    starting: false,
    actionPending: false,
    permissionDenied: false,
    privacyRequired: false,
    privacyContractName: '《用户隐私保护指引》',
    errorText: '',
    connectionText: '',
    hasMap: false,
    hasSelf: false,
    hasPartnerPoint: false,
    markers: [],
    includePoints: [],
    latitude: 0,
    longitude: 0,
    scale: 16,
    followMode: 'partner',
    viewText: '等待 TA 的位置',
    selfUpdateText: '尚未共享位置',
    partnerUpdateText: '尚未共享位置',
    selfStale: false,
    partnerStale: false,
  },

  async onShow() {
    this._visible = true;
    const generation = (this._viewGeneration || 0) + 1;
    this._viewGeneration = generation;
    this._lastState = null;
    this.setData({
      loading: true, actionPending: false, followMode: 'partner', errorText: '',
      hasMap: false, hasSelf: false, hasPartnerPoint: false, hasPartner: false,
      markers: [], includePoints: [], connectionText: '', privacyRequired: false,
    });
    const tabBar = typeof this.getTabBar === 'function' ? this.getTabBar() : null;
    if (tabBar && typeof tabBar.init === 'function') tabBar.init();
    const session = await requireSession({ force: true, requireCouple: false });
    if (!this.isCurrentView(generation)) return;
    if (!session) {
      this.setData({ loading: false, hasMap: false, markers: [], includePoints: [] });
      return;
    }
    const members = session.couple?.members || [];
    const partner = members.find((member) => member.openid !== session.user.openid);
    this._sessionCoupleId = session.couple?.coupleId || '';
    this._sessionPartnerOpenid = partner?.openid || '';
    this.setData({
      themeClass: syncTheme(session.user.gender),
      hasPartner: Boolean(partner),
      partnerName: partner?.nickname || 'TA',
    });
    this._unsubscribe = locationSharing.subscribe((state) => {
      if (this.isCurrentView(generation)) this.renderState(state);
    });
    this._pageOpened = true;
    try {
      await locationSharing.openPage(session);
      if (!this.isCurrentView(generation)) return;
      this.renderState(locationSharing.getState());
      await locationSharing.autoEnable();
      if (!this.isCurrentView(generation)) return;
      this.renderState(locationSharing.getState());
      // This only refreshes elapsed-time labels; it never requests location or cloud data.
      this._clock = setInterval(() => {
        if (this._visible && this._lastState) this.renderState(this._lastState);
      }, 15000);
    } catch (error) {
      if (this.isCurrentView(generation)) {
        this.setData({ loading: false, errorText: error.message || '位置连接失败，请重试' });
      }
    }
  },

  isCurrentView(generation) {
    return this._visible && this._viewGeneration === generation;
  },

  onHide() {
    this.stopPage();
  },

  onUnload() {
    this.stopPage();
  },

  stopPage() {
    this._visible = false;
    this._viewGeneration = (this._viewGeneration || 0) + 1;
    if (this._clock) clearInterval(this._clock);
    this._clock = null;
    if (this._unsubscribe) this._unsubscribe();
    this._unsubscribe = null;
    if (this._pageOpened) locationSharing.closePage();
    this._pageOpened = false;
    this._lastState = null;
  },

  renderState(state) {
    if (!this._visible || !state) return;
    this._lastState = state;
    const hasPartner = Boolean(state.coupleId && (
      state.partnerOpenid || (state.coupleId === this._sessionCoupleId && this._sessionPartnerOpenid)
    ));
    const self = hasPartner && validPoint(state.self) ? state.self : null;
    const partner = hasPartner && validPoint(state.partner) ? state.partner : null;
    const selfDescription = describePoint(self, Date.now());
    const partnerDescription = describePoint(partner, Date.now());
    const themeKey = this.data.themeClass === 'theme-male' ? 'male'
      : this.data.themeClass === 'theme-female' ? 'female' : 'neutral';
    const theme = { key: themeKey, colors: getThemeColors(themeKey) };
    const markers = [];
    if (self) markers.push(markerFor(self, true, selfDescription.stale, theme));
    if (partner) markers.push(markerFor(partner, false, partnerDescription.stale, theme));
    const target = this.data.followMode === 'self' ? self || partner : partner || self;
    const patch = {
      loading: false,
      hasPartner,
      sharing: Boolean(state.sharing),
      starting: Boolean(state.starting),
      permissionDenied: state.permission === 'denied',
      privacyRequired: state.permission === 'privacy',
      privacyContractName: state.privacyContractName || '《用户隐私保护指引》',
      errorText: typeof state.error === 'string' ? state.error : state.error?.message || '',
      connectionText: ['connecting', 'reconnecting'].includes(state.status)
        ? '正在连接位置更新…'
        : ['error', 'disconnected', 'offline'].includes(state.status) ? '连接暂时中断，点击重试' : '',
      hasMap: markers.length > 0,
      hasSelf: Boolean(self),
      hasPartnerPoint: Boolean(partner),
      markers,
      selfUpdateText: selfDescription.text,
      partnerUpdateText: partnerDescription.text,
      selfStale: selfDescription.stale,
      partnerStale: partnerDescription.stale,
      includePoints: this.data.followMode === 'both'
        ? markers.map(({ latitude, longitude }) => ({ latitude, longitude })) : [],
    };
    if (this.data.followMode === 'free') patch.viewText = '自由查看 · 点「看 TA」继续跟随';
    else if (this.data.followMode === 'both') patch.viewText = '同时查看我们的位置';
    else if (this.data.followMode === 'self') patch.viewText = self ? '正在跟随我的位置' : '等待我的位置';
    else patch.viewText = partner ? '正在跟随 TA 的位置' : '等待 TA 的位置 · 暂时展示自己';
    // Keep a dragged map where the user left it, while still moving both markers.
    if (target && this.data.followMode !== 'free' && this.data.followMode !== 'both') {
      patch.latitude = target.latitude;
      patch.longitude = target.longitude;
    } else if (!this.data.hasMap && markers.length) {
      patch.latitude = (partner || self).latitude;
      patch.longitude = (partner || self).longitude;
    }
    if (!partner && !self) patch.viewText = '等待 TA 的位置';
    this.setData(patch);
  },

  onRegionChange(event) {
    const causedBy = event.detail?.causedBy || event.causedBy;
    if (causedBy === 'gesture' || causedBy === 'drag') {
      this.setData({ followMode: 'free', includePoints: [], viewText: '自由查看 · 点「看 TA」继续跟随' });
    }
  },

  showPartner() {
    this.setData({ followMode: 'partner', scale: 16 });
    this.renderState(this._lastState);
    if (!this.data.hasPartnerPoint) wx.showToast({ title: '等待 TA 主动开启位置共享', icon: 'none' });
  },

  showSelf() {
    if (!this.data.hasSelf) {
      wx.showToast({ title: '开启共享后可查看自己的位置', icon: 'none' });
      return;
    }
    this.setData({ followMode: 'self', scale: 16 });
    this.renderState(this._lastState);
  },

  showBoth() {
    if (!this.data.hasSelf || !this.data.hasPartnerPoint) return;
    this.setData({ followMode: 'both' });
    this.renderState(this._lastState);
  },

  async enableSharing() {
    if (this.data.actionPending || this.data.starting || !this.data.hasPartner) return;
    const generation = this._viewGeneration;
    this.setData({ actionPending: true, errorText: '' });
    try {
      await locationSharing.enableSharing();
    } catch (error) {
      if (this.isCurrentView(generation)) this.setData({ errorText: error.message || '开启失败，请重试' });
    } finally {
      if (this.isCurrentView(generation)) this.setData({ actionPending: false });
    }
  },

  async disableSharing() {
    if (this.data.actionPending) return;
    const generation = this._viewGeneration;
    this.setData({ actionPending: true, errorText: '' });
    try {
      await locationSharing.disableSharing();
    } catch (error) {
      if (this.isCurrentView(generation)) this.setData({ errorText: error.message || '停止共享失败，请重试' });
    } finally {
      if (this.isCurrentView(generation)) this.setData({ actionPending: false });
    }
  },

  openLocationSettings() {
    const generation = this._viewGeneration;
    return wx.openSetting({
      success: async () => {
        await locationSharing.refreshPermission();
        if (this.isCurrentView(generation)) await locationSharing.autoEnable();
      },
    });
  },

  onPrivacyAgreed() {
    return this.enableSharing();
  },

  openPrivacyContract() {
    wx.openPrivacyContract({
      fail: () => wx.showToast({ title: '隐私保护指引暂时无法打开', icon: 'none' }),
    });
  },

  retryConnection() {
    locationSharing.retry();
  },

  goBindPartner() {
    wx.switchTab({ url: '/pages/usercenter/index' });
  },
});
