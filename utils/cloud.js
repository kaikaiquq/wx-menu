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

module.exports = {
  callCloud,
  uploadCloudImage,
};
