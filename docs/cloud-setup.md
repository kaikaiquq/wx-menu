# 微信云开发开通与部署

本文按不需要编程经验的操作顺序编写。完成后，登录、情侣绑定、菜单、心愿单和订单才会真正保存到云端。

## 1. 准备自己的小程序

1. 登录[微信公众平台](https://mp.weixin.qq.com/)，注册“小程序”账号。
2. 在“开发管理 → 开发设置”复制 AppID。
3. 用微信开发者工具打开本项目，选择“详情 → 基本信息”，将项目 AppID 换成自己的 AppID。

模板 AppID 不能作为正式项目发布，也通常不能使用你自己的云环境。

## 2. 开通云开发

1. 在微信开发者工具顶部点击“云开发”。
2. 首次使用时选择“开通”，创建一个按量付费环境。
3. 等待环境初始化完成，将该环境设为默认环境。
4. 在云开发控制台复制“环境 ID”，填写到 `config/cloud.js` 的 `envId` 中；如果只保留一个默认环境，也可以留空。

## 3. 创建数据库集合

在“云开发 → 数据库”中依次创建：

- `users`
- `couples`
- `coupleInvites`
- `coupleConfigs`
- `coupleCarts`
- `orders`
- `mutationRequests`

所有集合权限统一选择“仅云函数可读写”。不要开放客户端直接写入。

建议创建以下索引：

- `users`：`coupleId`
- `couples`：`members`
- `coupleInvites`：`codeHash` 唯一索引；`coupleId + status`
- `coupleConfigs`：`coupleId` 唯一索引
- `coupleCarts`：`coupleId` 唯一索引
- `orders`：`coupleId + createdAt`；`coupleId + status + createdAt`
- `mutationRequests`：`expiresAt`

## 4. 部署云函数

在开发者工具文件树中找到 `cloudfunctions`，依次右键：

1. `authApi`
2. `coupleApi`
3. `dataApi`

每一个都选择“上传并部署：云端安装依赖”。部署成功后，云开发控制台会出现同名函数。

部署云函数只会安装后端代码，不会立刻产生业务数据。用户首次微信登录时会创建 `users` 记录；首次创建空间时，才会创建情侣空间，并把当前示例菜单作为该空间的初始云端数据。因此创建空间后仍看到示例内容是正常的，此后管理页保存的内容均来自云数据库。

## 5. 验证

1. 清除小程序缓存后重新编译。
2. 进入“我们”，点击微信登录并填写昵称、头像。
3. 第一台手机创建情侣空间并复制邀请码。
4. 第二台手机登录后输入邀请码。
5. 任一方修改菜单并保存，另一方重新进入页面应能看到更新。

如果提示“云开发未配置”，优先检查 AppID、环境 ID及三个云函数是否部署成功。
