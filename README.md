# dsh-qq

把 QQ 接入 DeepSeek Harness（DSH）的渠道插件：在 QQ 里直接和 DSH 对话、收发图片文件、切换模型、处理审批。
本仓库只包含**官方 QQBot 路线**（合规路线）；第三方个人号协议不在本仓库范围内。

## 功能

- **登录**：QQ 号扫码登录（推荐，手机 QQ 扫码自动绑定）或 QQBot AppID + AppSecret
- **协议可插拔**：`router` / `bridge` / `control` 里**没有任何协议特定分支**；能力差异（markdown / 按钮 / typing / 媒体）统一由 `capabilities()` 表达
- **双向对话**：私聊、群 @机器人、QQ 频道；每个 QQ 对话对应一个独立的 DSH 会话，重启后自动恢复
- **图片与文件**：QQ 发来的图片/文件会进入会话，模型可以直接看图；DSH 也能把图片/文件/语音/视频发回 QQ
- **语音**：优先使用 QQ 内置语音转写，可另配外部 STT
- **远程控制**：在 QQ 里切换模型、调整推理强度、新建/切换/重命名会话、停止生成
- **审批**：DSH 执行敏感操作时把审批推到 QQ，点按钮「允许 / 拒绝」即可（也支持文字回复 `approve` / `deny`）
- **权限**：陌生用户需管理员批准（`/qq-approve`），命令权限与聊天权限分开控制
- **群记忆**：环境缓冲 + 动态上下文 + 群笔记三层，**零额外模型调用**（见下）
- **Web 控制台**：插件自带的自包含页面（信号链、告警条、活动量、身份授权、配置即改即生效、亮/暗主题）
- **掉线提醒**：线路挂了会在控制台顶部显示告警条；可选 QQ 私聊通知（`alerts.notify`）
- **主动通知**：安装后 `de_channel_send` / `de_notify` 可直接把文本/图片/文件发到 QQ

## 安装

前置条件：

1. 已安装并可启动 DSH（含 `web` profile）；
2. Node.js ≥ 22；
3. 一个 QQ 机器人应用：到 [q.qq.com](https://q.qq.com) 注册，记下 AppID 与 AppSecret，并开通单聊（C2C）、群 @ 等事件权限。

```bash
# 从 GitHub 安装
dsh plugin --profile web add github:qiufengqing06/dsh-qq

# 或从本地目录安装（开发调试 / 离线环境）
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

私聊直接发消息；群聊需要 @机器人（`mentionRequired` 默认 true，可用 `freeReplyGroups` 给某些群免 @）。
直接发图片或文件即可，模型能看到内容。

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
| `/qq-config` | 查看当前配置摘要与 Web 配置页地址 |
| `/qq-approve <openid>` | 批准某个用户的配对申请 |
| `qq_group_note`（工具，非命令） | 机器人用来维护当前群的长期记忆；只记约定/称呼/梗/群知识，不记闲聊流水 |

审批消息里的「说明」优先用 DSH 提供的本地化文案（`displayReason`，例如
「允许本次操作使用 danger-full-access 权限：…」）；没有该字段的旧宿主会回落到审计原因（`reason`）。

### 4. 群记忆（长期约定 / 梗 / 群知识）

群里聊得再热闹，机器人也不该忘事，同时也不该把上下文撑爆。插件用三层解决，**全程零额外模型调用**：

| 层 | 内容 | 存放 |
|---|---|---|
| 环境缓冲 | 所有入站群消息（**含没有 @ 机器人的**）按群进一个有界环形缓冲 | 内存（默认每群 100 条，重启即空） |
| 动态上下文 | 机器人被 @ 时，上一轮之后群里发生的事会被注入这一轮（有字符预算） | 同上 |
| 群记忆 | 本群的长期约定、称呼、梗、群知识——由机器人用 `qq_group_note` 工具维护，你也可以直接编辑 | `~/.dsh/qq-adapter/groups/<群>.md`（人可读，跨重启） |

- 热闹群不会因此多花钱：未 @ 机器人的消息**只进缓冲**，不进模型、不建会话；只有被叫到时才带上最近一段上下文；
- 群记忆有**硬容量上限**（默认 2000 字）：写满时工具会拒绝并提示模型自己合并/删除，不会无界增长；
- 群事实**不会**写进你的 `daily` / `project` / `key` 记忆——那是工作区的记忆，群聊内容混进去就是污染；
- 显式不做「全量归档」：真实的群一天几千条 + 媒体 MB 级，落盘等于无界增长，与「一条命令装卸」的插件定位冲突。

### 5. Web 控制台

插件自带一个控制台，不用翻 YAML。地址：`http://127.0.0.1:3080/dsh-qq`（端口与你的 DSH Web 一致；在 QQ 里发 `/qq-config` 也能拿到链接）。页面只监听本机回环地址。

- **信号链**：官方网关 → 插件连接画成一条链路，断了的那一段直接标红，修复按钮就在旁边；顶部一句话说明真实状态。这一屏回答的是「通道通没通，断在哪」。
- **数字卡**：在线线路 / DSH 会话 / 待批配对 / 已授权用户；下面一条**近 7 天活动量**柱状图（按天统计入站消息，保留 30 天，重启不清零）。
- **登录与凭据**：AppID / AppSecret **只写不回显**，或直接扫码登录（绑定链接会显示在页面里）；凭据只写入 DSH credentials seam，不落配置、不进聊天记录。
- **身份与授权**：主人（home channel）、已授权用户、待批配对（批准 / 拒绝）。
- **配置**：群聊策略、模型与记忆、高级选项按组呈现；「渠道默认模型」的 provider 与模型是**下拉选择**（按 DSH 里已配置的 provider/模型动态列出，选 provider 后模型跟着过滤），保存时后端会按 DSH 模型目录再校验一次；底部粘性保存栏。保存走 DSH 的 `configEditor`（先校验完整配置 → 原子写 profile 的 `cordis.patch.yml` → **自动热重载**，不用重启 DSH）；留空 = 恢复继承。
- **掉线提醒**：通道是后台服务，线路挂了需要主动报告。控制台顶部会显示红色告警条（持续时长、最后错误、一键重连）；如果配置了 `alerts.notify`（默认开），还会用 QQ 私聊通知主人。防抖与节流：连续掉线超过 `alerts.downAfterMs`（默认 60 秒）才提醒，两次提醒至少间隔 `alerts.cooldownMs`（默认 10 分钟），恢复只通知一次；`no-credentials` 不算掉线（那是配置问题，页面已有提示）。
- **主题**：亮 / 暗两套（跟随系统，也可手动切换，记住选择）。

**入口**：DSH Web 左侧栏底部有一个「QQ 控制台」按钮（插件自带的客户端半，零构建），点开会在弹窗里内嵌控制台页面——不用记 URL。

**为什么是一个独立页面而不是 DSH 里的 Tab**：官方客户端插件要求 tsdown 构建产物 + React（要引入构建管线），与「零依赖、无构建」的立场冲突，且易随 DSH rc 版本的客户端模块系统漂移；插件自带 HTTP 路由 + 自包含 HTML 可以在不引入构建链的前提下做到同样的能力。

**安全**：所有写操作要求页面请求头（挡 CSRF）+ 同源校验；页面不显示 token/secret；webServer 未挂载时自动跳过（`/qq-config` 会如实说明）。字体自托管（Geist / Geist Mono，SIL OFL 1.1，见 `lib/fonts/OFL.txt`），页面不引用任何外部资源。

### 6. 可选配置

在 profile 的插件行里按需覆盖（全部有默认值，不配也能用）：

```yaml
- id: dsh-qq
  name: 'dsh-qq'
  config:
    pairingPolicy: pairing      # pairing（需批准）| open（所有人）| allowlist
    agentOptions:               # 本渠道的默认模型（只在对话没有「用户显式选择」时生效）
      provider: deepseek-official
      model: deepseek-flash
      reasoningEffort: low
    controlPolicy:              # 谁能用哪些命令
      chat: authorized          # 普通对话
      sessionControl: owner     # 会话管理类命令
      modelControl: owner       # 模型/推理命令
      approvals: owner          # 登录与审批
    markdown: auto              # auto（按平台能力）| on | off
    maxFileBytes: 26214400      # 单文件上限（字节）
    midTurnDelivery: steer      # steer（默认，后面的消息进入正在跑的回合）| queue（各自排队）
    alerts:                     # 掉线提醒
      enabled: true
      notify: true              # 是否额外用 QQ 私聊通知主人
      downAfterMs: 60000        # 连续掉线多久才提醒
      cooldownMs: 600000        # 同一条线两次提醒的最小间隔
    groupMemory:                # 群记忆（全部有默认值；enabled=false 可整体关掉）
      bufferMessages: 100       # 每群环境缓冲条数（含未 @ 机器人的消息）
      contextMaxChars: 1200     # 被 @ 时注入的「群最近消息」字符预算
      notesMaxChars: 2000       # 群笔记容量上限（写满即拒绝，逼模型自己收敛）
    stt:                        # 外部语音转写（可选）
      baseUrl: https://open.bigmodel.cn/api/coding/paas/v4
      model: glm-asr
```

外部语音转写需要 API Key：用 `QQ_STT_API_KEY` 写入 DSH 凭据服务或环境变量。

模型选择的优先级是：**该对话里用户显式选过的模型**（`/qq-model`、`/qq-reasoning` 会记住）
→ **本渠道配置的 `agentOptions`** → **DSH 全局默认模型**。
默认值不会写回对话记录，所以改了 `agentOptions` 之后，没显式选过模型的对话下次就跟着变。

### 7. 代理（WSL / 企业网络）

QQ 网关在国内 WSL 环境常需要代理，设置环境变量后重启 DSH 即可（HTTP 与 WebSocket 都会走代理）：

```bash
WSS_PROXY=http://127.0.0.1:7890 dsh web
```

### 8. 收不到回复时

1. 在 QQ 里发 `/qq-status` 看是否「已连接」；
2. 未连接时发 `/qq-reconnect`，仍失败通常是没有可用网络出口（需要代理）或凭据已失效；
3. 群聊里请确认 @了机器人；陌生用户需要管理员先 `/qq-approve`。

## 许可

MIT（见 `LICENSE`）。第三方与协议参考说明见 `NOTICE.md`。
