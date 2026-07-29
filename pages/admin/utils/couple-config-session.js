const { getCachedMenuConfig } = require('../../../utils/couple-config');

let configDraft = null;
let draftScope = 'shared';

const clone = (value) => JSON.parse(JSON.stringify(value));

const startConfigSession = (config = getCachedMenuConfig(), scope = 'shared') => {
  configDraft = clone(config);
  draftScope = scope;
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
  draftScope = 'shared';
};

const getDraftScope = () => draftScope;

module.exports = {
  clearConfigSession,
  getConfigDraft,
  getDraftScope,
  setConfigDraft,
  startConfigSession,
};
