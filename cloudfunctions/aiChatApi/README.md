# 小伴 AI 云函数

部署 `aiChatApi` 时选择“云端安装依赖”，并将云函数运行超时设为至少 40 秒。在云函数的服务端环境变量中配置 `OPENAI_API_KEY`，不要把密钥写入项目、前端配置或日志。`OPENAI_MODEL` 可选，默认 `gpt-5.6-luna`；覆盖的模型需支持 Responses API、纯文本和 `reasoning.effort: none`。

函数固定通过 HTTPS 访问 `api.openai.com/v1/responses`，单次网络请求最长 25 秒，不自动重试。需要云函数能够访问该地址。不需要新增数据库集合或索引；沿用 `users` 的“仅云函数可读写”权限。

## 调用合同

```js
// wx.cloud.callFunction({ name: 'aiChatApi', data: ... })
{ action: 'reply', messages: [{ role: 'user', content: '你好，小伴' }] }
```

`messages` 仅允许 `user`、`assistant` 两种角色，最后一条必须为 `user`。最多 20 条，每条最多 4000 个 JavaScript 字符，总计最多 20000 个字符；空白消息不接受。客户端不能指定 `system`、`instructions`、模型或密钥。身份来自 `cloud.getWXContext().OPENID`，并要求 `users` 中已有对应用户。

成功返回 `{ ok: true, data: { text, model } }`；失败返回 `{ ok: false, code, message }`，`message` 为固定的中文提示，不包含上游错误、数据库错误或密钥。

上游失败可额外返回脱敏的 `details`，仅允许以下字段，不包含 IP、域名、URL、请求头、正文、原始错误或密钥，也不写日志：

| 诊断字段 | 允许值与含义 |
| --- | --- |
| `stage` | `network`：传输失败或超时；`http`：非成功 HTTP 状态；`response`：响应解析、空输出或拒绝回答等异常 |
| `networkPhase` | `dns`：等待解析；`tcp`：解析已完成，等待 TCP 连接；`tls`：等待 TLS 握手；`response_headers`：TLS 已就绪，等待响应头；`response_body`：已收到响应头，处理或读取响应体 |
| `elapsedMs` | HTTPS 调用开始至失败的总毫秒数，为非负安全整数，不包含此前的账号和用量事务 |
| `httpStatus` | 收到响应头后保留的 HTTP 状态整数，范围为 100～599；读取响应体失败时也保留成功状态，例如 `200` |
| `networkCode` | 仅内置白名单中的网络错误码，例如 `ENOTFOUND`、`ECONNRESET`、`ETIMEDOUT`；未知值省略 |

`networkPhase` 根据 socket 的 `lookup`、`connect`、`secureConnect` 及响应事件单向推进；复用连接直接进入等待响应头阶段。尚未获得 socket 时省略该字段，避免把请求创建失败或连接池等待误判为 DNS 故障。请求结束后移除 socket 监听，迟到事件不会改变结果。

25 秒是整个 HTTPS 请求的截止时间，不会因进入新阶段而重置。诊断示例：`{ stage: 'network', networkPhase: 'response_body', httpStatus: 200, networkCode: 'ETIMEDOUT', elapsedMs: 25000 }` 表示已连接并收到成功状态，但响应体未在截止时间前读完；`networkPhase: 'tcp'` 且没有 `httpStatus` 则表示 TCP 连接尚未完成。实际云端验证记录见 [小伴排查文档](../../docs/ai-chat.md#排查与验证)。

| 错误码 | 含义 |
| --- | --- |
| `INVALID_REQUEST` | 消息格式或长度不符合要求 |
| `UNAUTHORIZED` | 未登录或不存在用户记录 |
| `AI_NOT_CONFIGURED` | 未设置服务端密钥，或配置格式无效 |
| `AI_DAILY_LIMIT` | 当日已提交 100 次请求 |
| `AI_TOO_FREQUENT` | 距上次请求不足 3 秒 |
| `AI_BUSY` | 该用户上一次请求仍在进行 |
| `AI_TIMEOUT` | 上游请求超过 25 秒 |
| `AI_RATE_LIMITED` | 上游限流 |
| `AI_AUTH_ERROR` | 上游密钥或访问权限异常 |
| `AI_REFUSED` | 上游拒绝回答 |
| `AI_EMPTY_RESPONSE` | 未生成文本 |
| `AI_UNAVAILABLE` | 上游请求、连接或响应异常 |
| `SERVER_ERROR` | 应用服务端异常 |

## 用量与数据

`users.aiChatUsage` 在事务中维护 `day`、`count`、`lastRequestAt`、`leaseId`、`leaseUntil`。按北京时间自然日限制每人 100 次请求尝试；上游失败仍计入次数。未配置、未登录、输入不合法和已被限流的请求不消耗次数。请求之间至少间隔 3 秒，且同一用户只允许一个请求进行；进程异常退出后，35 秒租约到期可恢复。释放租约时核对令牌，旧请求不能清除新请求的租约。

应用云端只保存用量元数据，不保存聊天正文。每次请求发送调用方提供的有限上下文，使用 `store: false`，不创建 OpenAI Conversation，不传递伴侣、位置或其他应用数据；输出最多 800 tokens。`store: false` 不等同于供应商的零数据保留承诺，供应商的数据处理适用其政策。

本地测试：`node --test tests/ai-chat-api.test.js`，使用模拟 HTTPS 和事务数据库，不访问真实服务。

参考：[GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna)、[Responses API](https://developers.openai.com/api/reference/typescript/resources/responses/methods/create)。
