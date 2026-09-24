# 微信云开发开通与部署

本文按不需要编程经验的操作顺序编写。完成后，登录、情侣绑定、菜单、心愿单和订单才会真正保存到云端。

## 1. 准备自己的小程序

1. 登录[微信公众平台](https://mp.weixin.qq.com/)，注册“小程序”账号。
2. 在“开发管理 → 开发设置”复制 AppID。
3. 用微信开发者工具打开本项目，选择“详情 → 基本信息”，将项目 AppID 换成自己的 AppID。

模板或他人示例中的 AppID 不能作为正式项目发布，也通常不能使用你自己的云环境。

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
- `userConfigs`
- `userOrders`
- `mutationRequests`
- `contentTemplates`（推荐分类/菜单模板，可选；首次拉取时会自动写入默认模板）
- `conversations`（聊天会话）
- `messages`（聊天消息）
- `friendships`（好友关系）
- `friendRequests`（好友申请）
- `chatSignals`（每个用户一个聊天信标：对方发消息时实时通知，本端按事件读取摘要）
- `coupleLocations`（每对情侣一个位置状态文档，仅保存双方最新共享坐标）

其余集合权限统一选择“仅云函数可读写”。不要开放客户端直接写入。

`chatSignals` 需要支持客户端 `watch`，请单独设置权限为「自定义安全规则」：

```json
{
  "read": "doc._id == auth.openid",
  "write": false
}
```

云函数负责写入信标；客户端只能监听自己的文档，不能写入。**没有轮询降级**：集合或权限未配置时，实时提醒不可用，消息页会显示异常状态；修复后可点击重试。不要把 `chatSignals` 改成所有人可读写。

`coupleLocations` 同样需要客户端 `watch`，单独设置以下自定义安全规则：

```json
{
  "read": "doc.active == true && (doc.memberA == auth.openid || doc.memberB == auth.openid)",
  "write": false
}
```

位置由 `locationApi` 校验当前绑定关系后写入，只有当前文档的双方成员可读。`coupleApi` 解绑时撤销位置文档的访问并清除位置。不要使用“所有用户可读”，也不要允许客户端直接写坐标或成员字段。

建议创建以下索引：

- `users`：`coupleId`；`publicUserId`
- `couples`：`members`
- `coupleInvites`：`codeHash` 唯一索引；`coupleId + status`
- `coupleConfigs`：`coupleId` 唯一索引
- `coupleCarts`：`coupleId` 唯一索引
- `orders`：`coupleId + createdAt`；`coupleId + status + createdAt`
- `userOrders`：`ownerOpenid + createdAt`
- `mutationRequests`：`expiresAt`
- `conversations`：`memberOpenids + _id`（`_id` 升序，用于分页完整汇总）；`coupleId + type`；`directKey + type`（`unreadBy.{openid}` 保存未读数，读取并确认游标后再清零）
- `messages`：`conversationId + createdAt + _id`（会话等值过滤，`createdAt` 与 `_id` 降序，读取最新消息后转为正序展示）
- `friendships`：`memberOpenids`；`pairKey`
- `friendRequests`：`toOpenid`；`fromOpenid`
- `chatSignals`：文档 `_id` 为用户 openid（一般无需额外索引）
- `coupleLocations`：文档 `_id` 为情侣 `coupleId`（按文档 ID 访问，无需额外索引）

修改本次聊天推送逻辑后，需要重新部署 `chatApi` 并更新小程序前端。信标由 `chatApi` 初始化；仅修改前端 `utils/auth.js` 不需要重新部署 `authApi`。首次部署或修改对应云函数源码时，按下一节部署全部或相关函数。索引须等到构建完成后再验收。

完整架构、成本对比、故障恢复和双账号验收见[聊天消息通知评估与实现方案](./chat-notifications.md)。此方案针对小程序前台聊天提醒；退出小程序后的微信服务通知需要另行配置订阅消息模板和用户授权。

## 4. 部署云函数

在开发者工具文件树中找到 `cloudfunctions`，依次右键：

1. `authApi`
2. `coupleApi`
3. `dataApi`
4. `chatApi`
5. `locationApi`

每一个都选择“上传并部署：云端安装依赖”。部署成功后，云开发控制台会出现同名函数。

部署云函数只会安装后端代码，不会立刻产生业务数据。用户首次进入“我的内容库”或生成邀请时，会创建独立的 `userConfigs`；情侣绑定成功后创建的是一份空白共同空间。个人内容不会自动进入共同空间，需要双方在“共同空间管理”中主动导入并保存。

头像展示依赖 `authApi` 在云函数内换取临时链接（云存储默认「仅创建者可读写」时，客户端无法直接读取对方上传的头像）。修改头像相关逻辑后务必重新部署 `authApi`。

本次位置功能需要新部署 `locationApi`，并重新部署包含位置解绑清理的 `coupleApi`。前端新增第三个 Tab「位置」，顺序为「今天 / 点单 / 位置 / 消息 / 我们」。仅更新前端不能完成云端部署。

## 5. 验证

1. 清除小程序缓存后重新编译。
2. 进入“我们”，点击微信登录并填写昵称、头像。
3. 第一台手机创建情侣空间并复制邀请码。
4. 第二台手机登录后输入邀请码。
5. 任一方修改菜单并保存，另一方重新进入页面应能看到更新。

如果提示“云开发未配置”，优先检查 AppID、环境 ID及五个云函数是否部署成功。

聊天额外验证：两个账号互发消息，接收方分别停留首页、心愿单、管理页，应有轻提示和消息 Tab 角标；进入当前会话后内容更新并确认已读。前台无消息静置时不应出现固定周期的消息云函数请求；断网恢复和回前台应自动重新监听。真实推送依赖云端部署与真机环境，本地测试通过不代表已经完成这些检查。

位置功能还有平台配置前提：公众平台「开发管理 → 接口设置」检查 `getLocation`、`onLocationChange`、`startLocationUpdate` 的实际类目准入和开通情况，完善精确位置的隐私用途说明。`app.json` 已包含接口声明和用途描述，但不能替代平台开通或用户同意。双方首次进入位置页会自动进入授权流程，同意后开始共享。用两台真机确认授权、坐标推送、切其他页面继续共享、后台暂停、手动停止清除且不自动重开、解绑撤权。详细限制与测试步骤见[实时位置共享方案](./location-sharing.md)。

## 6. 分享邀请与空间绑定

1. 未绑定伴侣的一方进入“我们 → 绑定情侣空间”，生成邀请码并点击“分享给 TA”。
2. 对方点击分享卡片后，会直接进入邀请确认页；完成登录和个人资料后，邀请码仍会自动保留。
3. 也可以从“我们 → 绑定情侣空间”手动输入对方的 8 位邀请码。
4. 已生成且未过期的邀请码会保存在云端，再次进入绑定页面时会自动显示，不需要重新生成。
5. 绑定成功后共同空间从空白开始，双方个人内容库保持独立；任一方可在“共同空间管理”中把自己的内容导入共同草稿。
6. 共同空间新增内容有两种方式：从个人内容库勾选已有内容；或选择“新建并加入”，新内容会先保存到个人库，再关联到共同空间草稿。

修改邀请或合并逻辑后，需要重新上传并部署 `coupleApi` 云函数；只上传小程序前端不会更新云端绑定逻辑。

## 7. 解除绑定

任一方可以在“我们”页面点击对方头像并确认解绑。确认后，共同空间中的菜单、心愿单、留言、点单记录和共享位置会全部清空且无法恢复，双方个人内容库不发生任何变化。之后无论任何一方重新绑定其他人，都会创建新的空白共同空间。
