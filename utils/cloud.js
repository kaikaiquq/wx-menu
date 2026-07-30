const { envId, resourceAppid, mobileAppId } = require('../config/cloud');

let cloudInstance = null;
let initPromise = null;
let multiEndLoginPromise = null;
let multiEndLoggedIn = false;

/** 是否多端 App 运行时（非微信小程序容器） */
const isMultiEndRuntime = () => {
  try {
    if (typeof wx !== 'undefined' && wx.miniapp) return true;
  } catch (error) {
    // ignore
  }
  return false;
};

/** 是否走「移动应用身份」云实例（需真实移动应用 AppID + 环境共享） */
const useMobileCloudInstance = () => Boolean(mobileAppId && typeof wx.cloud?.Cloud === 'function');

/**
 * 多端下先建立微信登录态，云开发才能拿到 OPENID。
 * 使用「唤起小程序登录」；已登录时尽量静默。
 */
const ensureMultiEndLogin = (interactive = false) => {
  if (!isMultiEndRuntime()) return Promise.resolve(false);
  if (multiEndLoggedIn) return Promise.resolve(true);
  if (multiEndLoginPromise) return multiEndLoginPromise;

  multiEndLoginPromise = (async () => {
    // 已有系统登录态时，静默拿小程序 code 即可
    if (typeof wx.getMiniProgramCode === 'function') {
      try {
        await new Promise((resolve, reject) => {
          wx.getMiniProgramCode({
            success: (res) => (res?.code ? resolve(res) : reject(res)),
            fail: reject,
          });
        });
        multiEndLoggedIn = true;
        return true;
      } catch (error) {
        if (!interactive) {
          const err = new Error('请先完成微信登录');
          err.code = 'NEED_MULTI_END_LOGIN';
          throw err;
        }
      }
    }

    if (!interactive) {
      const err = new Error('请先完成微信登录');
      err.code = 'NEED_MULTI_END_LOGIN';
      throw err;
    }

    if (typeof wx.weixinMiniProgramLogin !== 'function') {
      // 模拟器或部分环境没有该 API，交给后续云调用报错
      return false;
    }

    await new Promise((resolve, reject) => {
      wx.weixinMiniProgramLogin({
        redirectPath: 'pages/auth/index',
        success: (res) => {
          if (res?.code) resolve(res);
          else reject(new Error(res?.errMsg || '多端微信登录失败'));
        },
        fail: (error) => {
          reject(new Error(error?.errMsg || '多端微信登录失败'));
        },
      });
    });

    multiEndLoggedIn = true;
    return true;
  })()
    .catch((error) => {
      multiEndLoginPromise = null;
      throw error;
    })
    .then((result) => {
      multiEndLoginPromise = null;
      return result;
    });

  return multiEndLoginPromise;
};

/**
 * 初始化云开发。多端必须显式指定资源小程序 AppID + 环境 ID。
 * 可重复调用，只会真正初始化一次。
 *
 * 注意：移动应用 Cloud 实例的 init() 必须在 weixinAppLogin 成功后再调；
 * 本项目默认走「唤起小程序登录」，用 wx.cloud.init，避免 operateWXData 报错。
 */
const initCloud = async () => {
  if (cloudInstance) return cloudInstance;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    if (!wx.cloud) {
      throw new Error('CLOUD_UNAVAILABLE');
    }
    if (!envId || !resourceAppid) {
      throw new Error('请先在 config/cloud.js 配置 envId 与 resourceAppid');
    }

    // 仅「移动应用微信登录」才用 Cloud 实例；appid 必须是开放平台移动应用 AppID
    if (useMobileCloudInstance()) {
      const cloud = new wx.cloud.Cloud({
        appid: mobileAppId,
        resourceAppid,
        resourceEnv: envId,
      });
      cloudInstance = cloud;
      // init 推迟到 ensureMobileCloudReady（登录后）
      return cloudInstance;
    }

    // 小程序 / 多端「唤起小程序登录」：显式带上资源 AppID + 环境
    wx.cloud.init({
      appid: resourceAppid,
      env: envId,
      envid: envId,
      traceUser: true,
    });
    cloudInstance = wx.cloud;
    return cloudInstance;
  })()
    .catch((error) => {
      initPromise = null;
      throw error;
    });

  return initPromise;
};

/** 移动应用登录模式下，登录成功后再 init Cloud 实例 */
const ensureMobileCloudReady = async () => {
  await initCloud();
  if (!useMobileCloudInstance()) return cloudInstance;
  const cloud = cloudInstance;
  if (cloud.__inited) return cloud;
  if (typeof cloud.init === 'function') {
    await cloud.init();
  }
  cloud.__inited = true;
  return cloud;
};

/** 获取已初始化的云实例；未初始化时回退 wx.cloud（兼容旧调用） */
const getCloud = () => {
  if (cloudInstance) return cloudInstance;
  if (!wx.cloud) {
    const error = new Error('CLOUD_UNAVAILABLE');
    throw error;
  }
  return wx.cloud;
};

const callCloud = async (name, action, data = {}, { interactiveLogin = false } = {}) => {
  if (isMultiEndRuntime() && !useMobileCloudInstance()) {
    await ensureMultiEndLogin(interactiveLogin);
  }

  await initCloud();
  if (useMobileCloudInstance()) {
    await ensureMobileCloudReady();
  }

  const cloud = getCloud();
  if (!cloud?.callFunction) {
    throw new Error('CLOUD_UNAVAILABLE');
  }

  const { result } = await cloud.callFunction({
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

  await initCloud();
  const cloud = getCloud();
  if (!missing.length || !cloud?.getTempFileURL) return map;

  try {
    const { fileList: result } = await cloud.getTempFileURL({ fileList: missing });
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
  await initCloud();
  const cloud = getCloud();
  const extension = guessExtension(filePath);
  const root = scope === 'personal' ? `users/${ownerId}/personal` : `couples/${ownerId}/menu`;
  const cloudPath = `${root}/${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`;
  const { fileID } = await cloud.uploadFile({
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

/** 通用上传（聊天语音/图片等） */
const uploadFileToCloud = async (filePath, cloudPath) => {
  await initCloud();
  const cloud = getCloud();
  const { fileID } = await cloud.uploadFile({ cloudPath, filePath });
  if (!fileID) throw new Error('文件上传失败，请重试');
  return fileID;
};

module.exports = {
  callCloud,
  clearTempUrlCache,
  ensureMultiEndLogin,
  getCloud,
  initCloud,
  isLocalFilePath,
  isMultiEndRuntime,
  isPersonalCloudFile,
  resolveCloudFileUrl,
  resolveCloudFileUrls,
  uploadCloudImage,
  uploadFileToCloud,
};
