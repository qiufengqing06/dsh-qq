# dsh-qq

把 QQ 接入 DeepSeek Harness（DSH）的渠道插件：在 QQ 里直接和 DSH 对话、收发图片文件、切换模型、处理审批。
本仓库只包含**官方 QQBot 路线**（合规路线）；第三方个人号协议不在本仓库范围内。

## 功能

- **登录**：QQ 号扫码登录（推荐，手机 QQ 扫码自动绑定）或 QQBot AppID + AppSecret
- **协议可插拔**：`router` / `bridge` / `control` 里**没有任何协议特定分支**；能力差异（markdown / 按钮 / typing / 媒体）统一由 `capabilities()` 表达
- **双向对话**：私聊、群 @机器人（需官方群权限）、QQ 频道；每个 QQ 对话对应一个独立的 DSH 会话，重启后自动恢复
- **图片与文件**：QQ 发来的图片/文件会进入会话，模型可以直接看图；DSH 也能把图片/文件/语音/视频发回 QQ
- **语音**：优先使用 QQ 内置语音转写，可另配外部 STT
- **远程控制**：在 QQ 里切换模型、调整推理强度、新建/切换/重命名会话、停止生成
- **审批**：DSH 执行敏感操作时把审批推到 QQ，点按钮「允许 / 拒绝」即可（也支持文字回复 `approve` / `deny`）
- **权限**：陌生用户需管理员批准（`/qq-approve`），命令权限与聊天权限分开控制
- **群记忆**：环境缓冲 + 动态上下文 + 群笔记三层，**零额外模型调用**（需官方群权限，见下）
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

### 快速开始（三步）

1. **打开控制台**：DSH Web 左侧栏底部点「QQ 控制台」，弹窗里就是配置页（也可以直接访问 `http://127.0.0.1:3080/dsh-qq`）。
2. **扫码登录**：「登录与凭据」卡片 →「扫码登录」→ 页面显示绑定链接 → 打开链接（本身是二维码页面）→ 手机 QQ 扫码。
3. **发消息试试**：绑定成功后插件自动连接，在 QQ 里给机器人发一句 `ping`。

### 1. 登录

登录有两种入口，效果一样：

- **控制台（推荐）**：DSH Web 左侧栏「QQ 控制台」→「登录与凭据」→「扫码登录 / 换号」（凭据已配置时）或「扫码登录」；
- **DSH 会话里**：发送 `/qq-login`。

两种方式都会向 q.qq.com 申请一个绑定任务，并给出**绑定链接**：在浏览器打开它就是一页二维码，用**手机 QQ** 扫码即可完成绑定。绑定成功后插件自动保存凭据、连接网关，并把这个 QQ 号绑定为「主人」——不需要再发任何命令。页面上的状态会自动变成「已配置 / 已连接」。

也可以改用**手动凭据**：在控制台里填 `AppID` + `AppSecret`（只写不回显），或在 DSH 的凭据/设置里写入 `QQ_APP_ID` 与 `QQ_CLIENT_SECRET`，再执行 `/qq-reconnect`。
⚠️ AppSecret 请通过配置入口填写，不要发在聊天里。

退出登录：`/qq-logout`（会清除本地凭据并断开）。

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

### 4. 群聊与群记忆（需要官方群权限）

QQ 官方机器人**通常不向个人开发者开放群 @ 消息权限**，所以这条路线实际能用的主要是私聊与频道；群聊与群记忆要等拿到群权限之后才有意义。如果以后拿到了权限，插件已经支持，并且会按下面的方式工作：

- **是否回复**：默认必须 @机器人才回应（`mentionRequired`），也可以把群号加进 `freeReplyGroups` 免 @；
- **群记忆**（零额外模型调用）：所有入站群消息按群进一个有界内存缓冲（含未 @ 的）→ 被 @ 时把上一轮之后的消息按字符预算注入这一轮 → 长期约定/称呼/梗由机器人用 `qq_group_note` 工具写进群笔记（`~/.dsh/qq-adapter/groups/<群>.md`，人可读）；
- 未 @ 机器人的消息**只进缓冲**，不进模型、不建会话、不花钱；群笔记有硬容量上限（默认 2000 字），写满即拒绝并提示模型自己收敛，不会无界增长。

### 5. Web 控制台

插件自带一个控制台，不用翻 YAML。

**入口（三选一）**：
- DSH Web 左侧栏底部的「**QQ 控制台**」按钮 → 弹窗内嵌（推荐，不用记地址）；
- 直接访问 `http://127.0.0.1:3080/dsh-qq`（端口与你的 DSH Web 一致）；
- 在 QQ 里发 `/qq-config`，它会返回控制台地址。

页面只监听本机回环地址。**扫码登录**就在「登录与凭据」卡片里：点按钮后页面会显示绑定链接（打开即二维码页），绑定成功自动连接。

- **信号链**：官方网关 → 插件连接画成一条链路，断了的那一段直接标红，修复按钮就在旁边；顶部一句话说明真实状态。这一屏回答的是「通道通没通，断在哪」。
- **数字卡**：在线线路 / DSH 会话 / 待批配对 / 已授权用户；下面一条**近 7 天活动量**柱状图（按天统计入站消息，保留 30 天，重启不清零）。
- **登录与凭据**：AppID / AppSecret **只写不回显**，或直接扫码登录（绑定链接会显示在页面里）；凭据只写入 DSH credentials seam，不落配置、不进聊天记录。
- **身份与授权**：主人（home channel）、已授权用户、待批配对（批准 / 拒绝）。
- **配置**：群聊策略、模型与记忆、高级选项按组呈现；「渠道默认模型」的 provider 与模型是**下拉选择**（按 DSH 里已配置的 provider/模型动态列出，选 provider 后模型跟着过滤），保存时后端会按 DSH 模型目录再校验一次；底部粘性保存栏。保存走 DSH 的 `configEditor`（先校验完整配置 → 原子写 profile 的 `cordis.patch.yml` → **自动热重载**，不用重启 DSH）；留空 = 恢复继承。
- **掉线提醒**：通道是后台服务，线路挂了需要主动报告。控制台顶部会显示红色告警条（持续时长、最后错误、一键重连）；如果配置了 `alerts.notify`（默认开），还会用 QQ 私聊通知主人。防抖与节流：连续掉线超过 `alerts.downAfterMs`（默认 60 秒）才提醒，两次提醒至少间隔 `alerts.cooldownMs`（默认 10 分钟），恢复只通知一次；`no-credentials` 不算掉线（那是配置问题，页面已有提示）。
- **主题**：亮 / 暗两套（跟随系统，也可手动切换，记住选择）。

**实现**：左侧栏按钮来自插件自带的客户端半（零构建，直接往 DSH 的 `sidebar.footer.action` 插槽注册），样式与 DSH 侧栏其它入口使用同一套设计令牌。

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

### 8. 收不到回复 / 常见问题

**收不到回复**
1. 在 QQ 里发 `/qq-status` 看是否「已连接」；
2. 未连接时发 `/qq-reconnect`，仍失败通常是没有可用网络出口（需要代理）或凭据已失效；
3. 群聊里请确认 @了机器人；陌生用户需要管理员先 `/qq-approve`。

**控制台里的红色告警条**
说明线路掉线了：告警条上直接点「重新连接」即可；连续掉线超过 `alerts.downAfterMs`（默认 60 秒）才提醒，恢复后只通知一次。如果配置了 `alerts.notify`（默认开），还会给你的 QQ 发私聊通知。
**控制台打不开**
多半是部署没有挂载 `webServer`（DSH Web 才有）：在 QQ 里发 `/qq-config`，它会如实说明当前能不能用，以及替代的配置方式（直接编辑 profile 的 `cordis.patch.yml`）。

**模型报 no API key**
说明渠道默认模型指向了一个没配凭据的 provider。打开控制台「配置 → 模型与群记忆」，把 provider / 模型这两个**下拉**选成 DSH 里已配置的组合（下拉只列已配置的），保存即热重载生效。

**改了配置要重启吗**
不用。控制台的保存走 DSH 的 `configEditor`：校验 → 原子写 profile patch → 自动热重载。只有插件代码本身的升级需要重启 DSH。

## 许可

MIT（见 `LICENSE`）。第三方与协议参考说明见 `NOTICE.md`。
