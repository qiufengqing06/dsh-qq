# dsh-qq

把 QQ 接入 DeepSeek Harness（DSH）的渠道插件：在 QQ 里直接和 DSH 对话、收发图片文件、切换模型、处理审批。

## 功能

- **登录**：QQ 号扫码登录（推荐，手机 QQ 扫码自动绑定）或 QQBot AppID + AppSecret
- **协议可插拔**：`router` / `bridge` / `control` 里**没有任何协议特定分支**，能力差异（markdown / 按钮 / typing / 媒体）统一由 `capabilities()` 表达，便于接入新的传输实现
- **双向对话**：私聊、群 @机器人、QQ 频道；每个 QQ 对话对应一个独立的 DSH 会话，重启后自动恢复
- **图片与文件**：QQ 发来的图片/文件会进入会话，模型可以直接看图；DSH 也能把图片/文件/语音/视频发回 QQ
- **语音**：优先使用 QQ 内置语音转写，可另配外部 STT
- **远程控制**：在 QQ 里切换模型、调整推理强度、新建/切换/重命名会话、停止生成
- **审批**：DSH 执行敏感操作时把审批推到 QQ，点按钮「允许 / 拒绝」即可
- **权限**：陌生用户需管理员批准（`/qq-approve`），命令权限与聊天权限分开控制
- **主动通知**：安装后 `de_channel_send` / `de_notify` 可直接把文本/图片/文件发到 QQ

## 安装

前置条件：

1. 已安装并可启动 DSH（含 `web` profile）；
2. Node.js ≥ 22；
3. 一个 QQ 机器人应用：到 [q.qq.com](https://q.qq.com) 注册，记下 AppID 与 AppSecret，并开通单聊（C2C）、群 @ 等事件权限。

```bash
# 从 GitHub 安装（推荐）
dsh plugin --profile web add github:qiufengqing06/dsh-qq

# 或者从本地目录安装（开发调试 / 离线环境）
dsh plugin --profile web add /path/to/dsh-qq

# 卸载（依赖、组合包与配置层一并清除）
dsh plugin --profile web remove dsh-qq
```

也可以在 DSH Web 侧边栏的「插件」页安装、启停或删除（安装框里填 `github:qiufengqing06/dsh-qq`）。

> 注意：**不要直接粘贴 `git@github.com:owner/repo.git` 这种 SSH 地址** —— pnpm 会把它解析成
> 「名为 `git` 的包」，DSH 接着会报 `cannot resolve profile bundle "git"`。需要写完整 URL 时用
> `git+ssh://git@github.com/qiufengqing06/dsh-qq.git`。

## 使用

### 1. 登录

首次使用还没有能对话的机器人，所以**先在 DSH 会话里**（Web 界面）执行：

```
/qq-login
```

它会返回一个二维码链接：用**手机 QQ** 打开并完成绑定，凭据会自动保存、插件随即连接 QQ。
之后想看状态执行 `/qq-status`（Web 或 QQ 里都行）。

也可以改用**手动凭据**：在 DSH 的凭据/设置里写入 `QQ_APP_ID` 与 `QQ_CLIENT_SECRET`，再执行 `/qq-reconnect`。
⚠️ AppSecret 请通过配置入口填写，不要发在聊天里。

退出登录：`/qq-logout`。

> 哪些命令能在 Web 里用：`/qq-help` `/qq-status` `/qq-login` `/qq-logout` `/qq-reconnect`；
> 会话相关的（切模型、切会话、停止等）请在对应的 QQ 对话里发送。

### 2. 对话

私聊直接发消息；群聊需要 @机器人。直接发图片或文件即可，模型能看到内容。

连着发多条也没关系：第一条还在跑（例如正在处理你刚发的文档）时，后面的消息会**直接进入这一轮**（DSH 的 steer），在模型的下一个步骤交给它，不会干等到轮末。想改回「各自排队、一轮一条」，把 `midTurnDelivery` 设为 `queue`。

### 3. 命令

| 命令 | 作用 |
|---|---|
| `/qq-help` | 显示全部命令 |
| `/qq-status` | 连接状态、账号、会话与权限概况 |
| `/qq-model [list\|provider/model] [--default]` | 切换本会话模型（加 `--default` 同时设为全局默认） |
| `/qq-reasoning [low\|medium\|high\|default]` | 调整本会话推理强度 |
| `/qq-new` | 新建会话 |
| `/qq-sessions` / `/qq-switch <序号>` | 列出 / 切换本对话的会话 |
| `/qq-title <标题>` | 重命名当前会话 |
| `/qq-stop [--keep]` | 停止当前生成（默认同时清空排队消息） |
| `/qq-login [--force]` / `/qq-logout` / `/qq-reconnect` | 扫码登录 / 清除凭据 / 重连 |
| `/qq-approve <openid>` | 批准某个用户的配对申请 |

在**没有消息按钮**的接入方式下，审批改为直接在对话里回复 `approve` 或 `deny`
（只有该对话确实有待审批请求时才会被识别，不会误吞日常消息）。

### 4. 可选配置

在 profile 的插件行里按需覆盖（全部有默认值，不配也能用）：

```yaml
- id: dsh-qq
  name: 'dsh-qq'
  config:
    pairingPolicy: pairing      # pairing（需批准）| open（所有人）| allowlist
    controlPolicy:              # 谁能用哪些命令
      chat: authorized          # 普通对话
      sessionControl: owner     # 会话管理类命令
      modelControl: owner       # 模型/推理命令
      approvals: owner          # 登录与审批
    markdown: auto              # auto（按平台能力）| on | off
    maxFileBytes: 26214400      # 单文件上限（字节）
    midTurnDelivery: steer      # steer（默认，后面的消息进入正在跑的回合）| queue（各自排队）
    stt:                        # 外部语音转写（可选）
      baseUrl: https://open.bigmodel.cn/api/coding/paas/v4
      model: glm-asr
```

外部语音转写需要 API Key：用 `QQ_STT_API_KEY` 写入 DSH 凭据服务或环境变量。

### 5. 代理（WSL / 企业网络）

QQ 网关在国内 WSL 环境常需要代理，设置环境变量后重启 DSH 即可（HTTP 与 WebSocket 都会走代理）：

```bash
WSS_PROXY=http://127.0.0.1:7890 dsh web
```

### 6. 收不到回复时

1. 在 QQ 里发 `/qq-status` 看是否「已连接」；
2. 未连接时发 `/qq-reconnect`，仍失败通常是没有可用网络出口（需要代理）或凭据已失效；
3. 群聊里请确认 @了机器人；陌生用户需要管理员先 `/qq-approve`。
