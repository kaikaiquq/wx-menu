<p align="center">
  <img alt="两人菜单" width="160" src="./couple-menu-avatar.svg.png">
</p>

<h1 align="center">两人菜单</h1>

<p align="center">一个用于情侣之间点单、回应和记录共同心愿的微信小程序。</p>

## 项目简介

两人菜单支持视频、甜点、饮料、正餐、小食和约会惊喜等自定义内容。点单条件不局限于金额，也可以是“一个抱抱”“你来选电影”等情侣之间的约定。

项目基于微信原生小程序、TDesign Miniprogram 和微信云开发实现。用户数据、个人内容库、情侣共同空间、心愿单和点单记录均保存到云端。

## 主要功能

- 微信身份登录，自主选择头像、昵称和性别。
- 女性粉色主题与男性灰蓝主题。
- 独立个人内容库，管理自己喜欢的分类和点单内容。
- 邀请码绑定情侣，可复制邀请码或直接分享邀请卡片。
- 未过期的邀请码保存在云端，再次进入页面无需重新生成。
- 两人绑定后创建全新的空白共同空间。
- 从个人内容库勾选内容并加入共同空间。
- 新建共同内容时，先保存到个人库，再关联到共同空间。
- 共享留言簿，双方均可修改。
- 共同心愿单、点单、回应和“完成心愿”状态闭环。
- 内容管理支持分类和菜单的新增、编辑、删除及本地图片上传。
- 解绑前进行不可恢复确认；解绑后共同空间清空，双方个人内容不受影响。
- 根据版本号处理多人同时编辑产生的数据冲突。

## 数据模型

项目明确区分个人数据和共同数据：

### 个人内容库

- 每个微信用户拥有独立的 `userConfigs`。
- 绑定、解绑或更换伴侣都不会修改个人内容。
- 个人内容只有在用户主动选择后才会进入共同空间。

### 情侣共同空间

- 每次成功绑定都会创建新的 `coupleId`。
- 初始菜单、心愿单、留言和订单均为空。
- 两位成员可以共同编辑配置、点单和回应。
- 解绑后共同菜单、留言、心愿单和订单会清空且无法恢复。

## 技术栈

- 微信原生小程序：JavaScript、WXML、WXSS
- [TDesign Miniprogram](https://github.com/Tencent/tdesign-miniprogram)
- 微信云开发：云函数、云数据库、云存储
- ESLint、Prettier、Husky

## 项目结构

```text
.
├── app.js                       # 小程序入口与云开发初始化
├── app.json                     # 页面、分包和 TabBar 配置
├── app.wxss                     # 全局样式与双主题变量
├── cloudfunctions/
│   ├── authApi/                 # 登录与个人资料
│   ├── coupleApi/               # 邀请、绑定与解绑
│   └── dataApi/                 # 配置、心愿单和订单
├── config/
│   └── cloud.js                 # 云环境 ID
├── custom-tab-bar/              # 自定义底部导航
├── docs/
│   └── cloud-setup.md           # 云开发开通与部署手册
├── model/
│   └── couple-menu.js           # 初始示例数据与前端默认结构
├── pages/
│   ├── auth/                    # 登录、创建空间与加入邀请
│   ├── home/                    # 留言簿、共同心愿与推荐
│   ├── category/                # 点单分类与菜单
│   ├── cart/                    # 心愿单与发送点单
│   ├── usercenter/              # 我们、绑定状态与工具入口
│   ├── admin/                   # 个人/共同内容管理
│   └── admin-menu/              # 菜单管理页面入口
├── utils/
│   ├── auth.js                  # 客户端会话管理
│   ├── cloud.js                 # 云函数和云存储封装
│   ├── couple-config.js         # 共同空间配置
│   ├── personal-config.js       # 个人内容库配置
│   ├── couple-cart.js           # 心愿单与订单
│   └── merge-config.js          # 个人内容导入共同空间
└── project.config.json          # 微信开发者工具项目配置
```

## 开始使用

### 1. 准备环境

- 安装微信开发者工具。
- 注册微信小程序并获取自己的 AppID。
- 开通微信云开发环境。
- 建议使用项目配置的微信基础库版本或更新版本。

### 2. 安装依赖

```bash
npm install
```

使用微信开发者工具打开项目后，执行“工具 → 构建 npm”。

### 3. 配置 AppID 和云环境

1. 在微信开发者工具“详情 → 基本信息”中换成自己的 AppID。
2. 将云开发环境 ID 写入 `config/cloud.js`：

```javascript
module.exports = {
  envId: '你的云环境 ID',
};
```

AppID 与云环境必须属于同一个小程序账号。仓库中的现有值仅适用于原开发环境。

## 云数据库

在“云开发 → 数据库”中创建以下集合：

- `users`
- `userConfigs`
- `userOrders`
- `couples`
- `coupleInvites`
- `coupleConfigs`
- `coupleCarts`
- `orders`
- `mutationRequests`

所有集合权限均应设置为“仅云函数可读写”，不要开放客户端直接写入。

建议创建以下索引：

- `users`：`coupleId`
- `couples`：`members`
- `coupleInvites`：`codeHash` 唯一索引、`coupleId + status`
- `orders`：`coupleId + createdAt`、`coupleId + status + createdAt`
- `userOrders`：`ownerOpenid + createdAt`
- `mutationRequests`：`expiresAt`

更完整的操作步骤见 [微信云开发开通与部署](./docs/cloud-setup.md)。

## 部署云函数

在微信开发者工具中依次右键以下目录，选择“上传并部署：云端安装依赖”：

1. `cloudfunctions/authApi`
2. `cloudfunctions/coupleApi`
3. `cloudfunctions/dataApi`

只上传小程序代码不会自动更新云函数。修改 `cloudfunctions` 后必须重新部署对应函数。

如果出现以下错误：

```text
database collection not exists: userConfigs
```

表示数据库集合尚未创建。请先创建 `userConfigs` 和 `userOrders`，再重新调用接口。

## 核心使用流程

### 个人内容管理

1. 进入“我们 → 我的内容库”。
2. 管理自己的分类、图片、交换条件和点单内容。
3. 点击“保存个人内容库”后写入 `userConfigs`。

### 情侣绑定

1. 一方进入“绑定情侣空间”，生成或复用邀请码。
2. 通过复制邀请码或微信分享卡片发送给对方。
3. 对方打开分享卡片后直接进入接受邀请页面。
4. 选择纪念日并确认后，系统创建全新的空白共同空间。

### 共同空间管理

1. 进入“我们 → 共同空间管理”。
2. 可以从个人内容库勾选已有内容。
3. 也可以选择“新建并加入共同空间”；新内容会先进入个人库。
4. 所有共同空间修改需点击底部“保存共同空间”后生效。

### 解绑

1. 在“我们”页面点击对方头像。
2. 阅读清空提示并点击“清空并解绑”。
3. 共同菜单、留言、心愿单和订单被清空。
4. 双方个人内容库保持不变，之后可以重新绑定其他人。

## 数据安全

- 客户端不能直接读写业务集合。
- 云函数使用微信 `OPENID` 验证用户身份。
- 共同空间写操作会检查成员关系。
- 配置和心愿单使用 `version` 字段检测并发冲突。
- 邀请码具有有效期，使用后立即失效。
- 菜单图片上传至微信云存储。

## 开发与检查

```bash
npm run lint
```

`npm run check` 来自原模板，目前依赖未声明的 `chalk`，修复该脚本依赖前不作为有效检查命令。

项目当前未配置自动化测试。建议发布前至少使用两个不同微信账号完整验证：

1. 登录并分别维护个人内容库。
2. 生成邀请码并通过分享卡片加入。
3. 验证共同空间初始为空。
4. 分别从双方个人库导入内容。
5. 点单、回应并完成心愿。
6. 解绑并确认共同空间清空、个人内容不变。
7. 双方分别重新绑定新空间。

## 发布

1. 在微信开发者工具中上传版本。
2. 在微信公众平台将开发版本设为体验版进行双账号测试。
3. 配置小程序名称、头像、服务类目和用户隐私保护指引。
4. 提交微信审核。
5. 审核通过后发布。

正式发布前应在隐私保护指引中说明昵称、头像、性别、纪念日、留言、点单记录和图片等数据用途。

## 致谢与协议

本项目基于 TDesign 零售行业模板改造，界面组件来自
[TDesign Miniprogram](https://github.com/Tencent/tdesign-miniprogram)。

开源协议见 [LICENSE](./LICENSE)。
