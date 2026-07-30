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

/** 小程序本地文件路径（含部分被写成 https://usr 的情况） */
const isLocalFilePath = (path = '') => {
  const value = String(path || '').trim();
  if (!value) return false;
  if (value.startsWith('wxfile://')) return true;
  if (value.startsWith(wx.env?.USER_DATA_PATH || '___never___')) return true;
  if (/^https?:\/\/(tmp|usr|store)\b/i.test(value)) return true;
  if (value.startsWith('http://127.0.0.1')) return true;
  if (value.startsWith('/') && !value.startsWith('//')) return true;
  return false;
};

const isRemoteHttpUrl = (path = '') => {
  const value = String(path || '').trim();
  if (!value.startsWith('https://') && !value.startsWith('http://')) return false;
  return !isLocalFilePath(value);
};

const isPersonalCloudFile = (path = '') => {
  const value = String(path || '').trim();
  return value.startsWith('cloud://') && /\/users\//.test(value) && !/\/couples\//.test(value);
};

const guessExtension = (path = '') => {
  const raw = String(path).split('.').pop().toLowerCase().split('?')[0];
  return /^[a-z0-9]{1,5}$/.test(raw) ? raw : 'jpg';
};

const uploadLocalFile = async (filePath, ownerId, scope = 'couple') => {
  const extension = guessExtension(filePath);
  const root = scope === 'personal' ? `users/${ownerId}/personal` : `couples/${ownerId}/menu`;
  const cloudPath = `${root}/${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`;
  const { fileID } = await wx.cloud.uploadFile({
    cloudPath,
    filePath,
  });
  if (!fileID) throw new Error('图片上传失败，请重试');
  return fileID;
};

/** 把已有 cloud 文件拷到目标目录（用于个人库图片进入共同空间） */
const copyCloudImageToScope = async (fileID, ownerId, scope = 'couple') => {
  const tempUrl = await resolveCloudFileUrl(fileID);
  if (!tempUrl) {
    throw new Error('无法读取个人库图片，请重新选择图片后再保存共同空间');
  }
  const downloaded = await new Promise((resolve, reject) => {
    wx.downloadFile({
      url: tempUrl,
      success: resolve,
      fail: reject,
    });
  });
  if (downloaded.statusCode && downloaded.statusCode >= 400) {
    throw new Error('个人库图片下载失败，请重新选择图片');
  }
  if (!downloaded.tempFilePath) {
    throw new Error('个人库图片下载失败，请重新选择图片');
  }
  return uploadLocalFile(downloaded.tempFilePath, ownerId, scope);
};

/**
 * 上传/规范化图片到云存储。
 * 共同空间保存时，会把个人库 cloud:// 复制到 couples/，避免权限与路径问题导致保存失败或对方看不到图。
 */
const uploadCloudImage = async (localPath, ownerId, scope = 'couple') => {
  const path = String(localPath || '').trim();
  if (!path) return '';

  if (path.startsWith('cloud://')) {
    if (scope === 'couple' && isPersonalCloudFile(path)) {
      return copyCloudImageToScope(path, ownerId, scope);
    }
    return path;
  }

  if (isRemoteHttpUrl(path)) {
    return path;
  }

  return uploadLocalFile(path, ownerId, scope);
};

module.exports = {
  callCloud,
  clearTempUrlCache,
  isLocalFilePath,
  isPersonalCloudFile,
  resolveCloudFileUrl,
  resolveCloudFileUrls,
  uploadCloudImage,
};
