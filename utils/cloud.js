const callCloud = async (name, action, data = {}) => {
  if (!wx.cloud) {
    throw new Error('CLOUD_UNAVAILABLE');
  }

  const { result } = await wx.cloud.callFunction({
    name,
    data: { action, ...data },
  });

  if (!result?.ok) {
    const error = new Error(result?.message || '云端服务暂时不可用');
    error.code = result?.code || 'CLOUD_ERROR';
    error.details = result?.details;
    throw error;
  }
  return result.data;
};

const uploadCloudImage = async (localPath, ownerId, scope = 'couple') => {
  if (!localPath || localPath.startsWith('cloud://') || localPath.startsWith('https://')) {
    return localPath;
  }

  const extension = localPath.split('.').pop().toLowerCase().split('?')[0] || 'jpg';
  const root = scope === 'personal' ? `users/${ownerId}/personal` : `couples/${ownerId}/menu`;
  const cloudPath = `${root}/${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`;
  const { fileID } = await wx.cloud.uploadFile({
    cloudPath,
    filePath: localPath,
  });
  return fileID;
};

/** tempFileURL 一般约 2 小时有效，本地短缓存避免「我们」页反复换链 */
const TEMP_URL_TTL_MS = 50 * 60 * 1000;
const tempUrlCache = new Map();

const getCachedTempUrl = (fileId) => {
  const hit = tempUrlCache.get(fileId);
  if (!hit) return '';
  if (Date.now() > hit.expireAt) {
    tempUrlCache.delete(fileId);
    return '';
  }
  return hit.url;
};

const setCachedTempUrl = (fileId, url) => {
  if (!fileId || !url) return;
  tempUrlCache.set(fileId, { expireAt: Date.now() + TEMP_URL_TTL_MS, url });
};

/** 把 cloud:// 转成可展示的临时 https 链接；避免被当成页面相对路径 */
const resolveCloudFileUrls = async (fileList = []) => {
  const ids = [...new Set(fileList.filter((id) => typeof id === 'string' && id.startsWith('cloud://')))];
  if (!ids.length) return {};

  const map = {};
  const missing = [];
  ids.forEach((id) => {
    const cached = getCachedTempUrl(id);
    if (cached) map[id] = cached;
    else missing.push(id);
  });

  if (!missing.length || !wx.cloud?.getTempFileURL) return map;

  try {
    const { fileList: result } = await wx.cloud.getTempFileURL({ fileList: missing });
    (result || []).forEach((item) => {
      if (item.fileID && item.tempFileURL && item.status === 0) {
        map[item.fileID] = item.tempFileURL;
        setCachedTempUrl(item.fileID, item.tempFileURL);
      }
    });
    return map;
  } catch (error) {
    console.warn('resolveCloudFileUrls failed', error);
    return map;
  }
};

const resolveCloudFileUrl = async (fileId) => {
  if (!fileId || !String(fileId).startsWith('cloud://')) return fileId || '';
  const map = await resolveCloudFileUrls([fileId]);
  return map[fileId] || '';
};

const clearTempUrlCache = () => {
  tempUrlCache.clear();
};

module.exports = {
  callCloud,
  clearTempUrlCache,
  resolveCloudFileUrl,
  resolveCloudFileUrls,
  uploadCloudImage,
};
