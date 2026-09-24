# NOTICE / 第三方与参考说明

## 协议实现参考

`dsh-qq` 的 QQ 官方机器人（QQBot API v2）协议实现是**独立重写**，不包含 Hermes 代码。
开发期间以 Hermes（`hermes-agent`，`gateway/platforms/qqbot/`）作为**行为参照（behavior
oracle）**用于确认协议语义、边界条件与错误码，包括：

- 扫码登录端点与密文布局（`q.qq.com/lite/create_bind_task`、`/lite/poll_bind_result`；
  AES-256-GCM：`IV(12) ‖ ciphertext ‖ AuthTag(16)`）
- WebSocket 生命周期与 close code 语义（4004 刷 token、4006/4007/4900-4913 会话重置、
  4008 限流、4001/4002/4010-4014/4914/4915 致命、<5s 连断计次）
- intents 组合 `(1<<25) | (1<<30) | (1<<12) | (1<<26)`、心跳间隔 80% 折减
- 消息与媒体 API 形状（`/v2/{users|groups}/{id}/messages`、`/files`、
  `upload_prepare` → 分片 PUT → `upload_part_finish` → `files{upload_id}`）
- InlineKeyboard 结构（`content.rows[].buttons[]`）与交互 ACK（`PUT /interactions/{id}`）

上述内容属于**协议事实与接口形状**（QQ 官方文档的公开定义），实现为本项目原创。
若后续需要逐段采用 Hermes 的具体实现细节，请先完成其许可证（见其仓库 LICENSE）核对与署名。

## 运行时依赖

| 依赖 | 用途 | 是否必需 |
|---|---|---|
| Node.js ≥ 22 | 内置 `fetch` 与全局 `WebSocket` | 必需 |
| `ws` + `https-proxy-agent` | 配置了 `*_PROXY` 时的 WebSocket 代理连接 | 可选（代理场景必需） |
| `undici` | 配置了代理时的 HTTP dispatcher（`ProxyAgent`/`EnvHttpProxyAgent`） | 可选（缺失时 HTTP 直连并告警） |

三者均声明为 `optionalDependencies`：未安装时直连路径完全正常，插件不会因缺少它们而加载失败。

## 商标与平台条款

QQ、QQ 机器人开放平台等名称与接口归腾讯所有。使用本插件需要你在
[q.qq.com](https://q.qq.com) 注册机器人应用并遵守其开放平台条款与频率限制。
