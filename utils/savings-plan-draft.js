/** 页面级草稿控制：确认时计算，串行保存；离页先同步落草稿，再尝试云端提交。 */
const api = require('./savings');
const model = require('./savings-model');
const { getSelfOpenid } = require('./auth');
const copy = value => JSON.parse(JSON.stringify(value));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keyFor = (actor, scope, year) => `couple.menu.savingsDraft.v1:${actor}:${scope}:${year}`;

module.exports = {
  acceptOverview(overview) {
    if (this.data.overview?.scope === overview.scope && overview.version < this.data.overview.version) return;
    this._actor = getSelfOpenid();
    this._confirmedPlan = copy(overview.plan || model.defaults());
    if (!this.data.dirty) {
      this._conflict = null;
      let draft;
      try { draft = wx.getStorageSync(keyFor(this._actor, overview.scope, this.data.year)); } catch (_) {}
      let restored = draft && draft.plan && Array.isArray(draft.plan.people) && draft.plan.people.length === 2 && Array.isArray(draft.plan.budgets);
      if (restored && equal(draft.plan, overview.plan)) {
        restored = false;
        try { wx.removeStorageSync(keyFor(this._actor, overview.scope, this.data.year)); } catch (_) {}
      }
      this._baseVersion = restored ? draft.version : overview.version;
      this._basePlan = copy((restored ? draft.basePlan : overview.plan) || null);
      this.setData({ plan: copy(restored ? draft.plan : (overview.plan || model.defaults())), dirty: Boolean(restored), calcError: '', error: restored ? '已恢复未保存的修改，请确认并更新目标。' : '' });
    }
    this.setData({ overview });
    this.recalculate();
  },

  rememberDraft() {
    if (!this.data.dirty || !this._scope || !this._actor) return;
    try {
      wx.setStorageSync(keyFor(this._actor, this._scope, this.data.year), {
        plan: copy(this.data.plan), version: this._baseVersion,
        basePlan: this._basePlan || null,
      });
    } catch (_) {
      this.setData({ error: '本机草稿保存失败，请保持页面打开并点击确定。' });
    }
  },

  changedPlan() {
    this.setData({ dirty: !equal(this.data.plan, this._basePlan || model.defaults()), calcError: '' });
    if (this.data.dirty) this.rememberDraft();
    else {
      this._conflict = null;
      try { wx.removeStorageSync(keyFor(this._actor, this._scope, this.data.year)); } catch (_) {}
    }
  },

  async savePlan() {
    if (this._conflict) {
      const conflict = this._conflict;
      const scope = this._scope;
      const year = this.data.year;
      if (!await this.confirm('对方已修改年度计划。是否用你当前的草稿覆盖对方的计划？') || scope !== this._scope || year !== this.data.year || !this._visible) return false;
      this._baseVersion = conflict.version;
      this._basePlan = conflict.plan;
      this._conflict = null;
      this.rememberDraft();
    }
    const saved = await this.flushPlan();
    if (saved && this._visible) wx.showToast({ title: '目标已更新' });
    return saved;
  },

  flushPlan() {
    if (this._saveFlight) return this._saveFlight;
    if (!this.data.dirty) return Promise.resolve(true);
    if (!this.data.overview || !this._scope || !this._actor || getSelfOpenid() !== this._actor) return Promise.resolve(false);
    if (this._conflict) return Promise.resolve(false);
    const context = { actor: this._actor, scope: this._scope, year: this.data.year };
    const owns = () => context.actor === getSelfOpenid() && context.actor === this._actor && context.scope === this._scope && context.year === this.data.year;
    const key = keyFor(context.actor, context.scope, context.year);
    this.setData({ savingPlan: true });
    const run = async () => {
      // 用户在请求期间继续修改时，前一笔成功后再提交最新草稿，不丢掉后续输入。
      while (owns() && this.data.dirty) {
        const plan = copy(this.data.plan);
        try { model.calculate(plan, context.year); }
        catch (error) {
          this.rememberDraft();
          if (!this._unloaded) this.setData({ calcError: error.message, error: '修改尚未保存，请检查收入参数与预算。' });
          return false;
        }
        this.rememberDraft();
        let version = this._baseVersion;
        try {
          try {
            await api('savePlan', { ...context, version, plan });
          } catch (error) {
            if (error.code !== 'VERSION_CONFLICT') throw error;
            const latest = await api('overview', { year: context.year, scope: context.scope });
            if (!owns()) return false;
            // 只因记账导致版本递增时可安全重试；对方改了计划则必须保留双方修改。
            if (!equal(latest.plan || null, this._basePlan || null)) {
              this._conflict = latest;
              throw new Error('对方已修改计划。你的草稿已保留，点击确定后选择是否覆盖。');
            }
            version = latest.version;
            await api('savePlan', { ...context, version, plan });
          }
          if (!owns()) return false;
          this._baseVersion = version + 1;
          this._basePlan = plan;
          this._confirmedPlan = plan;
          const dirty = !equal(this.data.plan, plan);
          if (this._unloaded) {
            // onUnload 后不再操作视图；仅清理确实已提交的同一份本地草稿。
            this.data.dirty = dirty;
            try {
              if (dirty) wx.setStorageSync(key, { plan: copy(this.data.plan), version: this._baseVersion, basePlan: plan });
              else { const cached = wx.getStorageSync(key); if (cached && equal(cached.plan, plan)) wx.removeStorageSync(key); }
            } catch (_) {}
            if (dirty) continue;
            return true;
          }
          this.setData({ dirty, calcError: '', error: '', overview: { ...this.data.overview, plan, version: version + 1 } });
          this.recalculate();
          if (dirty) this.rememberDraft();
          else { try { wx.removeStorageSync(key); } catch (_) {} }
        } catch (error) {
          if (owns() && !this._unloaded) this.setData({ error: `${error.message || '保存失败'} 未保存草稿仍保留。` });
          return false;
        }
      }
      return owns();
    };
    const flight = run().finally(() => {
      if (this._saveFlight === flight) {
        this._saveFlight = null;
        if (!this._unloaded) this.setData({ savingPlan: false });
      }
    });
    this._saveFlight = flight;
    return flight;
  },

  async changeTab(event) {
    const tab = Number(event.currentTarget.dataset.tab);
    if (tab === this.data.tab) return;
    const generation = this._generation;
    if (await this.flushPlan() && this.current(generation)) this.setData({ tab });
  },

  async openPerson(event) {
    const personOpen = Number(event.currentTarget.dataset.person);
    if (personOpen === this.data.personOpen) return;
    const generation = this._generation;
    if (await this.flushPlan() && this.current(generation)) this.setData({ personOpen });
  },

  beforeTabLeave() { return this.flushPlan(); },

  onHide() {
    this.rememberDraft();
    this.flushPlan();
    this._visible = false;
    this._generation = (this._generation || 0) + 1;
  },

  onUnload() {
    this.rememberDraft();
    this.flushPlan();
    this._unloaded = true;
    this._visible = false;
    this._generation = (this._generation || 0) + 1;
  },
};
