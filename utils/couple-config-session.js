const { getCachedMenuConfig } = require('./couple-config');

let configDraft = null;

const clone = (value) => JSON.parse(JSON.stringify(value));

const startConfigSession = (config = getCachedMenuConfig()) => {
  configDraft = clone(config);
  return clone(configDraft);
};

const getConfigDraft = () => {
  if (!configDraft) {
    return startConfigSession();
  }
  return clone(configDraft);
};

const setConfigDraft = (config) => {
  configDraft = clone(config);
  return getConfigDraft();
};

const clearConfigSession = () => {
  configDraft = null;
};

module.exports = {
  clearConfigSession,
  getConfigDraft,
  setConfigDraft,
  startConfigSession,
};
