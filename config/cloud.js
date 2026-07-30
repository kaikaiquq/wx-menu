/**
 * 云开发配置
 *
 * resourceAppid：云环境所属的「小程序」AppID（project.config.json 里的 appid）
 * envId：云开发环境 ID
 * mobileAppId：微信开放平台「移动应用」AppID（不是多端应用 ID！）
 *   - 推荐：唤起小程序登录 → 留空，用 wx.cloud.init
 *   - 仅当使用「移动应用微信登录」(wx.weixinAppLogin) 时才填写，并做环境共享
 *
 * 注意：多端应用 ID（如 wxeca6b43520cb20fb）不要填到 mobileAppId。
 */
module.exports = {
  envId: 'cloud1-d9g766l8j95653d04',
  resourceAppid: 'wx4e667c42d7b8543b',
  mobileAppId: '',
};
