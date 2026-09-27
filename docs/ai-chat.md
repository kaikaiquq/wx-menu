# 小伴 AI 聊天

消息页左侧在对象会话下方固定显示「小伴」。已登录但尚未绑定伴侣的用户也能使用。进入后可以发文字和表情，等待回复或在失败后重试；AI 会话不提供图片和语音输入。

## 部署

1. 上传 `cloudfunctions/aiChatApi`，选择“云端安装依赖”。
2. 在云控制台中给 **aiChatApi** 设置服务端环境变量：
   - `OPENAI_API_KEY`：自己的 OpenAI API Key。
   - `OPENAI_MODEL`：`gpt-5.6-luna`（省略时使用该默认值）。
3. 将函数执行超时设为至少 **40 秒**，保存配置。函数内部给 OpenAI 请求的截止时间为 25 秒，剩余时间用于鉴权和用量事务。
4. 重新编译小程序，打开“消息 → 小伴”，发送一条简短消息确认收到真实回复。

不需要新增数据库集合、索引或客户端数据库权限。已有 `users` 集合仍应设置为仅云函数可读写；AI 只额外写入当前用户的 `aiChatUsage` 用量字段。前端不直连 OpenAI，也不需要把 OpenAI 域名加入小程序 request 合法域名。

本机私有配置可以放在 `cloudfunctions/.secrets/aiChatApi.env`，该目录已被 Git 忽略，整个 `cloudfunctions` 也已排除出小程序包。**本机文件不会自动变成云端环境变量**，不要把它复制进待部署的函数目录。环境变量格式：

```dotenv
OPENAI_API_KEY=<在本机私有文件或云控制台填写，不提交到代码库>
OPENAI_MODEL=gpt-5.6-luna
```

`node scripts/check-ai-connection.cjs` 会读取上述私有文件，向 OpenAI 官方 Responses API 发一条最小测试请求，只打印是否成功、HTTP 状态和脱敏的错误码。也可用进程环境变量传入配置。此检查只代表本机网络，不能代替云函数的出网验证。

`node scripts/probe-ai-network.cjs` 不读取密钥，只对比 OpenAI 默认连接、IPv4 连接和腾讯云网站的公共 HTTPS 连通性。加 `--dns` 可对比系统 DNS 与公共 DoH 解析；加 `--dnspod-route` 可单次测试 DNSPod 解析出的地址，仍使用 `api.openai.com` 的主机名、SNI 和正常证书校验。此脚本只用于诊断，不改变系统 DNS 或云函数路由，也不把解析出的 IP 固定到生产配置。

## 会话和用量

- 小伴历史按登录账号保存在当前设备，最多保留 60 条；清理本地缓存后会丢失，不在不同手机之间同步。
- 每次只发送小伴会话最近最多 20 条、总计最多 20000 字符的上下文。对象聊天、好友聊天、位置、头像和用户资料不会加入 AI 上下文。
- 调用使用 `store: false`，应用云端只保存用量，不存聊天正文。该选项不代表供应商的零数据保留承诺。
- 每个账号每天最多 100 次请求尝试，按北京时间换日；上游失败也计入次数。相邻请求至少间隔 3 秒，同一账号同时只能生成一条回复。
- 切换会话或离开消息页不会把小伴回复写到真人会话；请求完成后保存在原账号的小伴历史中。失败重试会复用原用户气泡。

## 排查与验证

`AI_NOT_CONFIGURED` 表示云端未设置密钥；`AI_AUTH_ERROR` 表示 OpenAI 返回了 401/403；`AI_RATE_LIMITED` 表示上游返回 429（检查 API 额度、账单或速率限制）；`AI_TIMEOUT` 表示上游请求在 25 秒内未完成。该截止时间包括 DNS、TCP、TLS、等待响应头及读取响应体，不能仅凭此错误认定无法建立连接。密钥配置正确也需要部署区域能够访问 OpenAI 官方接口。不要向不明代理转发密钥。

开发者工具 Network 面板中的 `aiChatApi` 失败返回值可带以下脱敏 `details`；页面仍只显示固定中文提示：

| 字段 | 说明 |
| --- | --- |
| `stage` | `network` 为传输失败或超时，`http` 为非成功 HTTP 状态，`response` 为响应解析、空输出或拒绝回答等异常 |
| `networkPhase` | `dns`：等待域名解析；`tcp`：解析已完成，等待 TCP 连接；`tls`：等待 TLS 握手；`response_headers`：TLS 已就绪，等待响应头；`response_body`：已收到响应头，处理或读取响应体 |
| `elapsedMs` | 从本次 HTTPS 调用开始到失败的总毫秒数，不包含此前的账号和用量校验 |
| `httpStatus` | 已收到响应头时保留的 HTTP 状态整数；即使读取响应体超时，也可包含 `200` |
| `networkCode` | 内置白名单中的网络错误码，例如 `ENOTFOUND`、`ECONNRESET`、`ETIMEDOUT`；未知值省略 |

阶段由 socket 的 `lookup`、`connect`、`secureConnect` 和响应事件确定；复用已建立的连接直接进入等待响应头阶段。尚未取得 socket 时省略 `networkPhase`，不猜测 DNS 状态。返回值不包含 IP、域名、URL、请求头、正文、原始错误或密钥，也不新增日志。

云端实测记录：requestID `57163429-d7c7-497e-a5fe-e36c991ee0e2` 返回 `networkPhase: tcp`、`elapsedMs: 25004`、`networkCode: ETIMEDOUT`，未收到 HTTP 状态。这说明此次请求完成了解析，但在 TCP 连接阶段达到截止时间；尚不能据此判断密钥和模型是否有效。需要先恢复云函数到官方接口的网络连通，再验证真实回复。

本机对照实测：腾讯云网站约 104 毫秒返回 HTTP 200；OpenAI 默认和 IPv4 连接均在 TCP 阶段超时；DNSPod DoH 能返回解析结果，但用该结果访问官方接口仍在 TCP 阶段超时。解析结果存在差异不直接证明 DNS 污染，以上结果也不能单独确定云网络、运营商或上游哪一方阻断了连接。

本地自动化测试：`npm test`。AI 专项覆盖账号隔离、上下文边界、重复发送、失败重试、页面切换、密钥脱敏、上游失败及事务并发。真实验收还需检查：云端配置已保存、手机能收到回复、等待时切回对象聊天不串消息、再次进入小伴能恢复历史。

接口细节见 [aiChatApi 合同](../cloudfunctions/aiChatApi/README.md)。模型参数依据 [OpenAI GPT-5.6 Luna 文档](https://developers.openai.com/api/docs/models/gpt-5.6-luna)。
