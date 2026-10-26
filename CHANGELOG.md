# CHANGELOG

本项目遵循「一个版本一条中文 commit」的发布习惯；从 0.7.6 起把面向用户的变更记在这里。
更早的历史见 `git log`。

## v0.7.49

- 修复配置页所有开关点不动：.switch span 盖住了透明 checkbox，补 pointer-events:none，点击落到 input。
- 验证 elementFromPoint 命中的是 INPUT 而不是 SPAN。

## v0.7.48

- 表情包视觉打标：默认 deepseek-account/deepseek-flash，80 张/天；输出 kind/tags/desc。
- 表情包加自动标签；截图/图表/照片识别为 other 后自动进回收站（可恢复，默认开）。
- 配置页可关视觉打标、换 provider/model、关自动回收；失败只记日志，不影响入库/消息。
- 图片会以附件形式发给视觉模型（README 已披露）。

## v0.7.47

- 私聊图片也自动进表情库（visibility=local，只在该私聊可见），群图仍默认跨群共享。
- 群聊默认对群成员开放（groupOpen=true），不再逐个配对；DM 仍按 pairingPolicy，allowlist 保持严格。
- 图片页说明“自动收藏所有图片，不区分表情包/截图”，候选增加“不是表情包”直接丢回收站。
- 配置页可开关表情自动收藏/跨群共享、配置禁止跨群的群号。

## v0.7.46

- 关系统计（熟识度）默认关：relations.json，只统计活跃天数/发言/被点名/发图；不存正文、不影响权限/礼貌。
- 控制台「关系」页可查看/按群清除；配置页可开启/保留天数。
- 只在 chat 模式群聊统计。

## v0.7.45

- 聊天控制页增加定时任务列表：类型/时间/社交/错误/删除。
- 新增 /api/schedules（remove）；state 增加 schedules。

## v0.7.44

- 聊天模式回复 260 字硬上限：按句子边界截断，防止模型把工作模式长报告搬进聊天。
- 与全局工具守卫配合：读文件可以，但只简短回应；不写/不跑命令。

## v0.7.43

- 聊天模式全局工具守卫：不再只依赖 agentCtx.tools；旧 agent/未注入 tools 的会话也会在聊天模式拦截工作工具。
- 聊天提示词收紧：1–3 句/尽量 ≤80 字；用户要求建人设/改配置/总结文件时只用人设化短句带过，不描述尝试过程/工具/磁盘/进程/方案。

## v0.7.42

- 控制台「聊天控制」页：参与判断最近判定（分数/跳过原因，不存正文）+ 每个对话主动/表情状态；可直接暂停 1 小时/恢复/开关表情。
- 新增 /api/preferences；participation.snapshot() 观察数据。

## v0.7.41

- 聊天模式允许 `read`：用户发来的文件/链接可以看一眼，但只按聊天场景简短回应一两句；
  仍拒绝写文件/跑命令/完整总结/改写/任务/子代理；不提示切模式。

## v0.7.40

- 聊天模式不再向用户提示“切工作模式/系统限制”；工具拒绝理由改为内部提示，要求模型按当前人设自然带过/转移话题。
- 聊天提示词移除“说明得切工作模式”，改为“不要提模式切换/系统限制/工具名”。
- 工具边界不变（仍不读文件/不跑命令）。

## v0.7.39

- 聊天模式工具边界：agentCtx.tools.guard 只放行 web_fetch/web_search/send_sticker/list_stickers/qq_group_note/schedule_task；
  read/write/edit/bash/run_code/任务/子代理等一律拒绝，并提示切 /qq-mode work。
- 聊天提示词同步说明：要总结文件/改代码/跑测试时像人一样说明需切工作模式；链接可看但只聊一两句。

## v0.7.38

- 明确偏好/静默：store.preferences（对话 proactiveUntil/stickers、成员 name/proactiveUntil）。
- `/qq-pref show|name|pause|resume|stickers|member-pause|member-resume`；暂停只影响主动/参与判断，@ 和固定提醒不受影响。
- 参与判断、定时社交主动、表情包发送都检查偏好；成员称呼作为一行上下文注入，不写长期记忆。

## v0.7.37

- 参与判断（Phase 2）：未 @ 群聊按确定性规则评分；默认 enabled=false，mode=log 只记录，block 才唤醒。
- 配置：participation.enabled/mode/threshold/quietHours/cooldownMs/dailyWakeLimit；控制台「配置 → 群聊」可改。
- 只在 chat 模式 + 群聊生效；命令/审批优先；官方线只能 @，个人线才能旁观插话。
- 阈值/安静/冷却/日上限；低分仍进群缓冲。

## v0.7.36

- 控制台「表情包」页面：网格预览、候选/收藏/回收站筛选、标签编辑、收藏/回收/恢复/删除。
- state 增加 stickers 统计/条目；新增 /api/stickers 与图片预览路由。

## v0.7.35

- 切人设/改默认人设/改提示词时递增 promptRevision；旧人设下排队未发的气泡作废。
- `/qq-schedule list` 显示任务的 lastError（官方线主动消息被拒收时能直接看到原因）。

## v0.7.34

- 表情包图库：chat 模式群图自动收藏（SHA-256 去重、候选/收藏/回收站、按群 noShare 例外、跨群共享）。
- 新增 `list_stickers` / `send_sticker` 工具；`/qq-sticker list|keep|trash|restore|tag|send|delete` 管理命令。
- 发送闸门：仅 chat、media=image、同对话冷却、每日上限、同图 TTL；没有合适候选就不发。
- 图库文件在 dataDir/stickers，不上传外部；自动收藏只处理群聊图片。

## v0.7.33

- schedule_task 的 list/remove 不再依赖 lastTarget；目标暂缺时仍可查看/删除任务，只有 add 要求可发送目标。

## v0.7.32

- 定时提醒/主动任务：`store.schedules` + `lib/scheduler.js`（30s tick、安静时段、每日上限、忙时跳过、错过不补）。
- 新增 `schedule_task` 工具与 `/qq-schedule list|remove`；固定提醒 work/chat 都可用，社交主动仅 chat。
- 官方线/个人线都按 transport capabilities 检查主动消息；失败写 lastError，不无限重试。
- 人设库增加最近使用/收藏：页面人设选择按收藏/最近排序，人设卡可收藏/取消收藏。

## v0.7.31

- chat 拆分修复：两段短回复（总长 ≤80）现在也会拆成两条；单段短句仍保持一条。
- 群笔记按模式分文件：work 用旧文件名，chat 用 `.chat.md`；注入与 `qq_group_note` 都按当前模式读写。
- 页面群记忆列表会同时显示两种模式的笔记；容量上限不变。

## v0.7.30

- 人设按模式绑定：同一对话的 work/chat 可各选人设（`personaModeBindings`）；旧绑定迁移到当前模式。
- 群记忆缓冲按模式分水位：work 看不到 chat 期间记下的群聊上下文，反之亦然。
- 控制台「按对话绑定」每行改成「工作 / 聊天」两个人设下拉；`/qq-persona use/clear` 只作用于当前模式。
- 修复“切回 work 后仍引用聊天内容/人设”的串线问题。

## v0.7.29

- work/chat 会话隔离：每个模式各自绑定一个 DSH session；切模式时恢复对应会话，没有则下一条消息新建。
- `/qq-mode` 与页面模式下拉都走 `control.setMode` → `bridge.activateMode`，不再只改提示词。
- 旧数据迁移：已有 currentSessionId 归入当前模式，其余旧会话归 work；不会丢历史。
- `/qq-sessions`/`/qq-switch` 只列/切当前模式的会话。

## v0.7.28

- Phase 0：聊天模式发送代际。`/qq-stop`、切模式、 `/qq-new`/`/qq-switch` 会让旧代际的
  未发气泡失效；每次等待结束/交给 transport 前复查。
- 补停止/切模式回归测试。

## v0.7.27

- 修复控制台「读取状态失败：modeSupported is not defined」：变量只声明在 renderPersonaBlock，
  renderPrompts 的行渲染引用时抛 ReferenceError；作用域已修正，并补页面结构回归。

## v0.7.26

- 修复「切到聊天、过一会又变回工作」的假象：页面已更新但宿主进程还是旧代码时，
  /api/mode 返回 404，页面现在会明确提示重启并禁用模式下拉，不再显示成功。
- 模式切换失败会立即重渲染回真实状态。

## v0.7.25

- 控制台「会话提示词 → 按对话绑定」每行新增「工作 / 聊天」下拉，可直接切换某个群/私聊
  的模式，不用去 QQ 里发命令；state 透传 `modes`，新增 `POST /api/mode`。
- README 补聊天模式与页面切换说明。

## v0.7.24

- 双模式：`/qq-mode work|chat`（按对话持久化）。chat 模式把回复拆成最多 3 条短消息，
  条间 0.6–1.8 秒随机延迟，官方线先发 typing，并注入「像群友一样短句」的聊天风格提示。
- 工作模式保持整段回复、无延迟；聊天模式不改变入站 @/免 @ 规则。
- 拆分规则：短文本/代码块不拆，超长合并；延迟/随机可注入，测试不依赖真实时钟。

## v0.7.23

- 命名人设库：新增 `personas` / `defaultPersonaId` / `personaBindings`；生效顺序
  对话绑定 → 旧对话提示词 → 默认人设 → 旧默认提示词。人设文本 `interpolate:false`，
  不会被当作变量模板。
- 新增 `/qq-persona list|show|use <id>|clear|set <id> <文本>`；use/clear 需会话管理权限，
  set 需管理命令权限。
- 控制台「会话提示词」卡片新增人设库：新建/编辑/删除/设为默认，以及按对话绑定的下拉框；
  旧提示词编辑保留，写旧提示词会解除绑定、绑定人设会清旧提示词。

## v0.7.22

- 修复 Clash/mihomo fake-IP：198.18.0.0/15 是代理解析域名时返回的虚拟公网地址，不再当私网拦截；
  否则所有走代理的 QQ 图片/文件下载都会报「媒体 URL 解析到私网/回环地址」。
- 媒体拦截错误带上主机名与解析地址，便于把真实自建源加入 `media.allowedHosts`。
- 媒体获取失败时明确提示模型：原图未取到，不要读取本机其他附件或历史文件代替。

## v0.7.21

- 修复 `agentPresets.mount` 解绑调用：真实服务是类方法，内部依赖 `this.retain()`；
  解绑后重启会报 `Cannot read properties of undefined (reading 'retain')`，导致所有 QQ 会话
  新建/恢复失败（控制台显示「DSH 会话创建失败」）。

## v0.7.20

- 媒体下载边界：默认拒绝回环/私网/链路本地/云元数据地址；重定向改为手动跟随、逐跳校验，
  跨源重定向剥离鉴权头。
- 新增 `media.allowedHosts`（自建/私网源白名单）、`media.allowPrivateHosts`、
  `media.tokenHosts`（鉴权头白名单）、`media.maxRedirects`，控制台可改。
- QQBot 的鉴权头默认只发给自身源站或 tokenHosts。

## v0.7.19

- 多线路路由：出站支持显式 `transportKind/accountId` 提示；同一 target 跨线路时不再静默猜，
  返回可读错误；审批通知、配对通知、批准补答都带线路，重启后可从 chatKey/store 恢复 target。
- 媒体：`downloadHttp` 改流式读取并按字节上限中止（缺 Content-Length 也不会全量读进内存）。

## v0.7.18

- 群记忆：同一笔记的「读 → 改 → 写」按文件串行，临时文件名加随机后缀；页面编辑与模型
  工具并发写不再互相覆盖。
- 分片上传：signal 中止时如实失败，不再带着缺失分片去 complete 并返回 ok。
- 控制台：提示词编辑器补 aria-label；README 注明不发布 npm。
- 移除 `qqbot.js` 的死代码（`chatKeyOf` / `_reloadCredentials`）。

## v0.7.17

- 修复 `pairingPolicy: allowlist` 退化成 pairing：陌生人现在直接拒绝，不写待批、不通知管理员。
- 修复新建/切换会话后旧 Agent 监听未释放：迟到的 idle 不再回发到新会话，监听器不泄漏。
- 修复多线路冷启动路由：兼容 store 里实际持久化的渠道 target（p2p/group + id），重载后
  主动消息仍能发回原线路；同一 ID 出现在多条线路时告警。
- 控制台：默认提示词编辑器不再把 `@default` 当 chatKey 提交（此前无法保存）；测试消息的
  成功/失败颜色改用已定义的变量；provider 选空时一并清掉旧 model。

## v0.7.16

- 控制台前端纯函数（数字缩写/chatKey 解析/时间格式化）集中到 page.html 的标记块，新增
  `test/page-format.test.js` 用 vm 抽取同一份源码单测；页面仍然自包含、刷新即生效。
- 修测试偶发：e2e 等待消息真正进入会话（create 与 followup 不同 tick）。

## v0.7.15

- 控制台「运行信息」新增「最近问题」：展示启动失败与会话恢复失败（出错会话、记录时间），
  持续掉线时可直接在控制台排查，不用翻状态文件。

## v0.7.14

- 继续拆分 `control.js`：模型选择（会话级安装/默认回退/不可用自愈）抽到 `lib/model-selection.js`，
  control 从 1022 行降到 758 行；新增 page-structure 断言防止 `api(path, {})` 把 GET 发成 POST。

## v0.7.13

- 拆分 `control.js`：审批转发与配对申请抽到 `lib/approvals.js`（审批 answerer、等待决策、
  文本/按钮入口、配对通知），control 从 1269 行降到 1022 行；行为不变。

## v0.7.12

- 修复控制台侧边栏高亮错位（活动量/Token 消耗卡片顺序与导航不一致；scroll-spy 改为按文档位置判定）。
- 新增 `scripts/clean-temp-dirs.mjs`：清理测试遗留的 `/tmp/dsh-qq-*` 目录（默认 dry-run）。

## v0.7.11

- 控制台支持按会话设置 system prompt（默认 / 按群 / 按私聊，保存后下一回合生效）。

## v0.7.10

- 修复控制台「群记忆 → 编辑」报「文件名不合法」（页面把 GET 误发成 POST）。
- 抽出共享 HTTP 工具（脱敏、超时合并、媒体下载），两条线路共用一套行为。
- store 微批写：同轮次多次保存合并成一次原子写（`await` 仍保证落盘），添加强制刷盘接口。

## v0.7.9

- 控制台新增「群记忆」编辑、按线路发测试消息、最近审批记录。
- Token 消耗支持可选价格表（元/百万 token），换算「约 ¥x.xx」。

## v0.7.8

- 连接层修复：关闭码合法化、op9 会话重置、后台 Promise 兜底、媒体下载超时合并、
  重连计数复位、迟到的 close 不再清空新连接。
- 配置页覆盖身份与权限、群聊、模型与语音、高级项；线路可在页面启停。
- 轮询加后台标签页/输入焦点保护；`GET /api/state` 不再回显管理 token。

## v0.7.7

- 新增「Token 消耗」：按人/按群统计，今日/近 7 天/近 30 天切换，近 14 天堆叠柱，保留 30 天。

## v0.7.6

- 官方线显示机器人头像与昵称（机器人资料接口，缓存 5 分钟，失败退回文字占位）。

## v0.7.5 / v0.7.4

- 控制台入口与 DSH 侧栏设计令牌对齐；DSH 侧栏新增「QQ 控制台」按钮（iframe 弹窗）。
