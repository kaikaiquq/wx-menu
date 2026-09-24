const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function setup() {
  const storage = new Map();
  const windows = [];
  const tabs = [];
  const app = { globalData: {} };
  const context = {
    module: { exports: {} },
    getApp: () => app,
    getCurrentPages: () => [{ getTabBar: () => ({ setData: (patch) => tabs.push(patch) }) }],
    wx: {
      getStorageSync: (key) => storage.get(key),
      setStorageSync: (key, value) => storage.set(key, value),
      setBackgroundColor() {},
      setNavigationBarColor: (value) => windows.push(value),
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils/theme.js'), 'utf8'), context);
  return { theme: context.module.exports, storage, windows, tabs, app };
}

test('choosing a gender immediately updates navigation and the already attached tab', () => {
  const h = setup();
  h.theme.syncTheme('female');
  assert.equal(h.tabs.at(-1).themeClass, 'theme-female');
  assert.equal(h.windows.at(-1).backgroundColor, h.theme.getThemeColors('female').background);
  h.theme.syncTheme('male');
  assert.equal(h.tabs.at(-1).themeClass, 'theme-male');
  assert.equal(h.windows.at(-1).backgroundColor, h.theme.getThemeColors('male').background);
  assert.equal(h.theme.getStoredThemeClass(), 'theme-male');
  assert.equal(h.app.globalData.themeClass, 'theme-male');
});

test('no chosen gender uses a complete neutral theme instead of a female flash', () => {
  const h = setup();
  assert.equal(h.theme.getStoredThemeClass(), 'theme-neutral');
  h.theme.applyWindowTheme();
  assert.equal(h.windows.at(-1).backgroundColor, h.theme.getThemeColors('').background);
  assert.notEqual(h.windows.at(-1).backgroundColor, h.theme.getThemeColors('female').background);
});
