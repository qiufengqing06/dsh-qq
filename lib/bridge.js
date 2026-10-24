/**
 * QQ ↔ DSH 会话双向桥（执行文档 §5.5）。
 *
 * 入站：归一化事件 → chatKey 指针（store）→ agents.create / agents.resume →
 *      有界 inbox → agent.followup(user message)。
 * 出站：订阅 agent/status（running → typing；idle → 收集本轮 assistant 文本 → 回发 QQ）。
 *
 * 与协议无关：只依赖 transport 契约（sendText/sendTyping/capabilities）。
 *
 * 消息形状：DSH 的 createUserMessage 就是 `{...input, role:'user', id}` 且深度冻结，
 * 插件不能 import @deepseek-ai/*（profile 的 node_modules 不提供这些包），因此
 * 这里用等价的最小实现（同形状、同冻结语义）。
 */

import { randomUUID } from 'node:crypto'
import { parseChatKey, toChannelTarget, wantsMarkdown } from './transport.js'
import { resolveSttApiKey, transcribeAudio } from './stt.js'

/** 单次回复的最大字符数（超出由 transport 分段）。 */
export const MAX_REPLY_CHARS = 8000

/** plugin 来源的上下文摘要上限（与 DSH CONTEXT_SUMMARY_MAX_CHARS 一致）。 */
const SUMMARY_MAX_CHARS = 120

/** 渠道纯文本提示在系统提示词里的 section 名（幂等用：同名只加一次）。 */
const CHANNEL_PLAINTEXT_SECTION = 'dsh-qq/channel-plaintext'

/** 群记忆提示的 section 名（只加给群会话）。 */
const GROUP_MEMORY_SECTION = 'dsh-qq/group-memory'

/**
 * 群会话的系统提示：告知「群记忆 + 群最近消息」两段上下文的来源与写法。
 * 明确要求群事实写进 qq_group_note，而不是 daily/project——后者是用户工作区的记忆。
 */
const GROUP_MEMORY_NOTE = [
  '当前是 QQ **群**会话。除了你的消息，你还会收到两段上下文（都由 dsh-qq 提供）：',
  '1. 群记忆：本群的长期约定、称呼、梗、群知识——由你之前用 qq_group_note 记下的内容，以及人工整理的条目；',
  '2. 群最近消息：你上次被叫到之后群里发生的事（**含没有 @ 你的发言**），只有最近的，超出预算的会标注省略。',
  '群里学到长期有用的东西时，用 qq_group_note 记进群记忆（add/replace/remove）。',
  '不要把它写进 daily / project / key 记忆——那是用户工作区的记忆，群聊内容混进去就是污染。',
  '回答当下问题优先看群最近消息；涉及以前的约定、称呼、梗时先看群记忆。',
].join('\n')

/**
 * 无 Markdown 渲染能力时的渠道提示（写进该会话的系统提示词）。
 *
 * 为什么要在源头说：模型默认按 DSH Web 的习惯输出 `**加粗**`、``` 围栏、Markdown 表格，
 * 甚至 dsh-ui 卡片围栏；不支持 Markdown 的客户端不渲染这些，用户看到的是
 * 一堆杂乱符号和一大段 JSON（真机反馈 2026-09-24）。事后清理只能兜底，源头少生成更省 token。
 */
const CHANNEL_MARKDOWN_SECTION = 'dsh-qq/channel-markdown'
/** Markdown 渠道的说明：能渲染 Markdown，但 dsh-ui 围栏只属于 DSH Web。 */
const MARKDOWN_CHANNEL_NOTE = [
  '当前渠道：QQ（官方 QQBot，支持 Markdown 渲染）。',
  '注意：```dsh-ui 卡片围栏只用于 DSH Web 界面，QQ 里**不会渲染成卡片**，只会显示成一大段 JSON 代码块。',
  '所以请用普通 Markdown（标题 / 列表 / 表格 / 代码围栏）表达内容；**不要输出 ```dsh-ui 围栏**。',
].join('\n')

const PLAINTEXT_CHANNEL_NOTE = [
  '当前渠道：QQ。QQ 客户端**不渲染 Markdown，也没有卡片、表格与按钮**。',
  '所以回复请写成纯文本：',
  '1. 不要用 `**加粗**`、`#` 标题、``` 代码围栏、Markdown 表格、dsh-ui 围栏；',
  '2. 不要输出 JSON 或卡片代码块——在 QQ 里它们只会变成一大段符号与括号；',
  '3. 需要分点时用「1. 2. 3.」或「- 」开头的中文短句；代码直接写出来（缩进即可，不加围栏）；',
  '4. 链接直接给完整 URL，不要用 [文字](url) 语法。',
].join('\n')

/**
 * 某个 target 所属线路的能力表。
 * 单线路部署等同于 transport.capabilities()；多线路时官方线（支持 Markdown / typing）
 * 与个人号（纯文本）的能力不能互相冒充。
 * @param {object} transport - 单 transport 或多线路注册表
 * @param {object} target
 * @returns {object} capabilities
 */
function capabilitiesOf(transport, target, route = null) {
  return typeof transport.capabilitiesFor === 'function' ? transport.capabilitiesFor(target, route) : transport.capabilities()
}

/** chatKey → 显式路由提示（多线路同 ID 时让 register 不再猜）。 */
function routeOfChatKey(chatKey) {
  try {
    const parsed = parseChatKey(chatKey)
    return { transportKind: parsed.transportKind, accountId: parsed.accountId }
  } catch {
    return {}
  }
}

/**
 * 下载媒体用 target 所属线路的实现（两条线的媒体地址处理方式不同）。
 * @param {object} transport
 * @param {object} target
 * @param {string} url
 * @param {object} opts
 * @returns {Promise<object>}
 */
function downloadMediaOf(transport, target, url, opts) {
  return typeof transport.downloadMediaFor === 'function' ? transport.downloadMediaFor(target, url, opts) : transport.downloadMedia(url, opts)
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return Object.freeze(value)
}

/**
 * 构造与 DSH `createUserMessage` 同形状的用户消息。
 * @param {object} spec
 * @param {string} spec.text
 * @param {Array<object>} [spec.content] - 直接给定 content blocks（优先于 text）。
 * @param {object} [spec.source]
 * @returns {object} 冻结消息
 */
export function createUserMessage({ text = '', content = null, source = undefined } = {}) {
  const blocks = content ?? (text === '' ? [] : [{ type: 'text', text }])
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: blocks,
    source: source ?? { kind: 'user' },
  })
}

/** 构造 plugin 来源的上下文摘要（notice 形态）。 */
export function noticeSource(summary) {
  const bounded = summary.length <= SUMMARY_MAX_CHARS ? summary : `${summary.slice(0, SUMMARY_MAX_CHARS - 1)}…`
  return { kind: 'plugin', plugin: 'dsh-qq', form: 'notice', summary: bounded }
}

/**
 * 从**单个** `assistant/message` 事件里取可见文本（与 extractAssistantText 同源的
 * 载体兼容：`data.message.content` 与 `data.content`）。
 * @param {object} event
 * @returns {string} 无文本返回空串
 */
export function assistantTextOf(event) {
  if (event === null || typeof event !== 'object' || event.type !== 'assistant/message') return ''
  const data = event.data ?? {}
  const content = Array.isArray(data.message?.content)
    ? data.message.content
    : Array.isArray(data.content)
      ? data.content
      : []
  const chunks = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text !== '') chunks.push(block.text)
  }
  return chunks.join('\n\n').trim()
}

/**
 * 从会话事件里抽取指定 seq 之后的 assistant 可见文本。
 * 兼容 `data.content`（user/assistant 直挂）与 `data.message.content`（assistant/message）。
 * @param {Array<object>} events
 * @param {number} fromSeq - 只取 seq > fromSeq 的事件。
 * @returns {{text: string, lastSeq: number}}
 */
export function extractAssistantText(events, fromSeq = 0) {
  let lastSeq = fromSeq
  const chunks = []
  for (const event of Array.isArray(events) ? events : []) {
    if (event === null || typeof event !== 'object') continue
    const seq = typeof event.seq === 'number' ? event.seq : 0
    if (seq > lastSeq) lastSeq = seq
    if (event.type !== 'assistant/message' || seq <= fromSeq) continue
    const data = event.data ?? {}
    const content = Array.isArray(data.message?.content) ? data.message.content : Array.isArray(data.content) ? data.content : []
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text !== '') chunks.push(block.text)
    }
  }
  return { text: chunks.join('\n\n').trim(), lastSeq }
}

/**
 * 从会话事件里取本轮 `turn/end` 的失败原因（无失败返回 null）。
 * 用途：回合在建会话/组装提示词/请求模型阶段就失败时，assistant 没有产出，
 * 若不显式上报，QQ 侧会完全静默。
 * @param {Array<object>} events
 * @param {number} fromSeq - 只看 seq > fromSeq 的事件。
 * @returns {string|null}
 */
export function extractTurnError(events, fromSeq = 0) {
  let message = null
  for (const event of Array.isArray(events) ? events : []) {
    if (event === null || typeof event !== 'object' || event.type !== 'turn/end') continue
    const seq = typeof event.seq === 'number' ? event.seq : 0
    if (seq <= fromSeq) continue
    const reason = event.data?.reason
    if (reason?.kind !== 'error') continue
    message = String(reason.error?.message ?? reason.error ?? '未知错误')
  }
  return message === null ? null : message.slice(0, 300)
}

/** 会话事件的最大 seq（用于跳过历史）。 */
export function lastEventSeq(events) {
  let last = 0
  for (const event of Array.isArray(events) ? events : []) {
    if (typeof event?.seq === 'number' && event.seq > last) last = event.seq
  }
  return last
}

/**
 * 创建桥。
 * @param {object} deps
 * @param {object} deps.ctx - Cordis 上下文（agents/on/logger）。
 * @param {object} deps.config
 * @param {object} deps.store
 * @param {object} deps.transport
 * @param {object} deps.scope - ResourceScope。
 * @param {object} [deps.logger]
 * @param {() => number} [deps.clock]
 * @returns {object} bridge
 */
export function createBridge({
  ctx,
  config,
  store,
  transport,
  scope,
  logger = null,
  clock = () => Date.now(),
  onAgentReady = null,
  /**
   * 群上下文提供者（群记忆）：被 @ 时返回本群的长期记忆与「上次之后」的群消息。
   * 由 index.js 接到 lib/group-memory.js；这里只负责把它拼进模型可见内容，
   * 返回 null 表示本次没有可注入的上下文。
   * @type {null | ((ev: object) => Promise<{notes?: string, recent?: string, omitted?: number}|null>)}
   */
  ambientContext = null,
  /** 回合失败回调：control 用它做模型不可用自愈，返回给用户看的提示（可空）。 */
  onTurnError = null,
}) {
  /** chatKey → 运行时状态 */
  const runtime = new Map()
  /** sessionId → chatKey */
  const sessionIndex = new Map()

  const log = {
    info: message => {
      try {
        logger?.info?.(message)
      } catch {
        /* ignore */
      }
    },
    warn: message => {
      try {
        logger?.warn?.(message)
      } catch {
        /* ignore */
      }
    },
  }

  /**
   * 本渠道是否需要纯文本化：能力表说没有 Markdown 渲染。
   * 官方 QQBot 声明 markdown=true，走渲染路径，不受影响。
   */
  const needsPlainText = target => wantsMarkdown(config.markdown, capabilitiesOf(transport, target)) === false

  /** 该 chat 是不是群（群记忆只对群生效；私聊本来句句对着机器人）。 */
  const isGroupChat = state => {
    if (state?.target?.kind === 'group') return true
    const chatKey = state?.chatKey
    if (typeof chatKey !== 'string' || chatKey === '') return false
    const last = store.chat(chatKey).lastTarget
    return last !== null && last !== undefined && last.kind === 'group'
  }

  const stateOf = (chatKey, target = null) => {
    let state = runtime.get(chatKey)
    if (state === undefined) {
      const chat = store.chat(chatKey)
      state = {
        chatKey,
        sessionId: chat.currentSessionId,
        agent: null,
        pending: 0,
        steered: 0,
        replyParts: [],
        turnError: null,
        target: target ?? null,
        typing: false,
        attached: false,
        /** 该 chat 当前 agent 的订阅释放器（新建/切换会话前必须清空）。 */
        disposers: [],
        replyChain: Promise.resolve(),
        /** 入站串行链：保证同一 chat 的消息按到达顺序投递（见 handleUserMessage）。 */
        intake: Promise.resolve(),
      }
      runtime.set(chatKey, state)
    }
    if (target !== null) state.target = target
    return state
  }

  const sessionOf = agent => agent?.session ?? null

  const liveAgent = sessionId => {
    if (!sessionId) return null
    try {
      return ctx.agents.get(sessionId) ?? null
    } catch {
      return null
    }
  }

  /** 为 chat 解析/创建 Agent（先 live → resume → create）。 */
  async function ensureAgent(chatKey, state) {
    const existing = state.agent ?? liveAgent(state.sessionId)
    if (existing !== null && existing !== undefined) {
      attach(existing, state)
      // 已经活着的会话（典型：插件重载后宿主里的 agent 还在）也要重新套用「当前」模型选择：
      // 否则配置改了、选择却停在旧值 —— 真机 2026-10-21：官方线会话持久化的 model/selection
      // 还是已失效的 deepseek-official，换 provider 后每条消息都报 no API key。
      if (typeof onAgentReady === 'function') {
        try {
          onAgentReady(existing, chatKey)
        } catch (error) {
          log.warn(`dsh-qq: onAgentReady 失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return existing
    }
    let agent = null
    if (state.sessionId) {
      agent = await resumeAgent(state.sessionId, chatKey)
      if (agent === null) log.warn(`dsh-qq: 会话 ${state.sessionId} 恢复失败，将为 ${chatKey} 新建会话`)
    }
    if (agent === null) {
      agent = await createAgent(chatKey)
    }
    state.agent = agent
    state.sessionId = sessionOf(agent)?.id ?? state.sessionId
    sessionIndex.set(state.sessionId, chatKey)
    await store.setCurrentSession(chatKey, state.sessionId, { title: `QQ ${chatKey.split(':').slice(2).join(':')}` })
    attach(agent, state)
    // 会话就绪钩子：control 用它套用该 chat 持久化的模型/推理选择（P3）
    if (typeof onAgentReady === 'function') {
      try {
        onAgentReady(agent, chatKey)
      } catch (error) {
        log.warn(`dsh-qq: onAgentReady 失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return agent
  }

  /**
   * 组合 QQ 会话的 agent preset（对齐宿主 session-controller.composeAgent，L381-397）：
   * 有 agentPresets 服务时 resolve + 在 setup 里 mount，让 QQ 会话具备与 Web 会话同等的
   * 工具/插件；服务缺失时退化为「无 preset 的会话」并告警。
   * @param {object} [options]
   * @param {string|undefined} [options.storedPreset] - 恢复场景下会话原有的 preset。
   * @returns {Promise<{agentPreset: string|undefined, setup: Function|undefined}>}
   */
  /**
   * 把「这个 QQ 对话的 system prompt」挂到 agent 作用域上。
   *
   * 关键：text 是**函数**，DSH 每次组装系统提示都会重新求值——所以控制台里改完提示词，
   * 正在跑的会话下一个回合就生效，不需要重建会话。
   * @param {object} agentCtx - 未发布的 agent 作用域
   * @param {string} chatKey
   */
  function registerPromptSection(agentCtx, chatKey) {
    const systemPrompt = agentCtx?.systemPrompt
    if (systemPrompt === null || systemPrompt === undefined || typeof systemPrompt.section !== 'function') return
    try {
      const order = typeof systemPrompt.getSectionOrder === 'function'
        ? systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX') + 1
        : 0
      systemPrompt.section({
        name: 'dsh-qq:chat-prompt',
        order,
        // 人设文本由用户/管理员自由填写，不做变量插值：未知 {{...}} 会让整轮组装失败。
        interpolate: false,
        // 动态读取：控制台/命令保存后下一回合生效（空串 = 不注入）
        text: () => store.promptFor(chatKey),
      })
    } catch (error) {
      log.warn(`dsh-qq: 注册会话提示词失败（${chatKey}）：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 组合 QQ 会话的 agent preset 与 system prompt。
   * preset 服务缺失时仍然返回 setup（只挂提示词），不丢会话级人设。
   * @param {object} [options]
   * @param {string|undefined} [options.storedPreset] - 恢复场景下会话原有的 preset。
   * @param {string} [options.chatKey]
   * @returns {Promise<{agentPreset: string|undefined, setup: Function}>}
   */
  async function resolveComposition({ storedPreset = undefined, chatKey = '' } = {}) {
    const presets = ctx.get?.('agentPresets')
    let presetId = storedPreset
    let mount = null
    if (presets !== undefined && presets !== null && typeof presets.resolve === 'function') {
      const wanted = storedPreset ?? (config.agentPreset !== '' ? config.agentPreset : presets.defaultId)
      try {
        const preset = await presets.resolve(wanted)
        presetId = typeof preset?.id === 'string' && preset.id !== '' ? preset.id : wanted
        // 必须保留方法接收者：真实 agentPresets.mount 是类方法，内部会用 this.retain()
        // （解绑调用会报 "Cannot read properties of undefined (reading 'retain')"，
        //  表现为新建/恢复 QQ 会话全部失败）。
        mount = typeof presets.mount === 'function' ? (agentCtx, id) => presets.mount(agentCtx, id) : null
      } catch (error) {
        log.warn(`dsh-qq: 解析 agent preset「${wanted}」失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return {
      agentPreset: presetId,
      setup: async agentCtx => {
        if (mount !== null) await mount(agentCtx, presetId)
        registerPromptSection(agentCtx, chatKey)
      },
    }
  }

  async function createAgent(chatKey) {
    const sessionId = `qq-${randomUUID()}`
    const composition = await resolveComposition({ chatKey })
    const meta = { cwd: config.cwd || process.cwd() }
    if (composition.agentPreset !== undefined && composition.agentPreset !== '') meta.agentPreset = composition.agentPreset
    try {
      const handle = await ctx.agents.create({
        sessionId,
        meta,
        ...(composition.setup === undefined ? {} : { setup: composition.setup }),
        ...(config.agentOptions === null || config.agentOptions === undefined ? {} : { agentOptions: config.agentOptions }),
      })
      return handle?.agent ?? handle
    } catch (error) {
      log.warn(`dsh-qq: 创建会话失败（${chatKey}）：${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  /** 记录恢复/启动类故障到 store（插件日志在宿主 stdout，外部看不到；写进状态文件才可诊断）。 */
  async function recordIssue(patch) {
    try {
      await store.setMeta({ ...patch, lastIssueAt: Date.now() })
    } catch {
      /* 诊断写入失败不影响主流程 */
    }
  }

  async function clearIssue(key) {
    try {
      const meta = store.snapshot().meta ?? {}
      if (meta[key] !== undefined && meta[key] !== null) await store.setMeta({ [key]: null })
    } catch {
      /* ignore */
    }
  }

  async function resumeAgent(sessionId, chatKey) {
    const persistence = ctx.get?.('sessionPersistence')
    if (persistence === undefined || persistence === null) {
      log.warn('dsh-qq: 无 sessionPersistence 服务，无法跨重启恢复会话（将新建）')
      await recordIssue({ lastResumeError: 'sessionPersistence 服务不可用', lastResumeSessionId: sessionId })
      return null
    }
    // 恢复前预检持久化身份（对齐宿主 createOrAdopt，L456-483）：会话不存在则直接新建
    let storedPreset
    const sessionQuery = ctx.get?.('sessionQuery')
    if (sessionQuery !== null && sessionQuery !== undefined && typeof sessionQuery.observeSession === 'function') {
      let observation = null
      try {
        observation = await sessionQuery.observeSession(sessionId)
      } catch (error) {
        if (error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
          // 索引可能滞后于 jsonl：不直接放弃，继续尝试 resume，失败再新建
          log.info(`dsh-qq: 查询索引未命中 ${sessionId}，仍尝试 resume`)
          await recordIssue({ lastResumeError: 'observeSession NOT_FOUND', lastResumeSessionId: sessionId })
        }
        log.warn(
          `dsh-qq: observeSession(${sessionId}) 失败：${error instanceof Error ? error.message : String(error)}（继续尝试 resume）`,
        )
      }
      if (observation !== null && observation !== undefined) {
        const header = observation.header
        if (typeof header?.agentPreset === 'string' && header.agentPreset !== '') storedPreset = header.agentPreset
        try {
          if (typeof observation[Symbol.dispose] === 'function') observation[Symbol.dispose]()
          else if (typeof observation.dispose === 'function') observation.dispose()
        } catch {
          /* 释放失败不影响恢复 */
        }
      }
    }
    const composition = await resolveComposition({ storedPreset, chatKey })
    try {
      // 注意：agents 服务的公开签名是 resume(options) 单参（注册表内部用自己的 ctx
      // 作为 ownerCtx，见 packages/core/agent/src/index.ts:407）。传 ctx 当第一参会把
      // Context 代理当成 options，读 .resumeSessionId 直接抛
      // 「cannot get property "resumeSessionId" without inject」——真机踩过。
      const handle = await ctx.agents.resume({
        resumeSessionId: sessionId,
        ...(composition.setup === undefined ? {} : { setup: composition.setup }),
        ...(config.agentOptions === null || config.agentOptions === undefined ? {} : { agentOptions: config.agentOptions }),
      })
      await clearIssue('lastResumeError')
      return handle?.agent ?? handle
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      log.warn(`dsh-qq: resume ${sessionId} 失败（${chatKey}）：${detail}`)
      await recordIssue({ lastResumeError: detail.slice(0, 500), lastResumeSessionId: sessionId })
      return null
    }
  }

  /**
   * 订阅 agent 状态（running → typing；idle → 回发回复）。
   *
   * 必须挂在 `agent.ctx` 上，不能挂在插件 ctx 上：DSH 的 `agent/status` 是
   * **作用域事件**（`Scoped<Agent>`），只有处于该 agent 作用域祖先链上的监听者能收到；
   * 而 `ctx.agents.create()` 的 owner 上下文是**注册表自己的** ctx
   * （`packages/core/agent/src/index.ts` `create()` 里 `const ownerCtx = this.ctx`），
   * 插件 ctx 只是它的兄弟节点 → 挂在插件 ctx 上收不到任何事件（真机踩过一次：
   * 回合成功却没有任何回发）。
   */
  /**
   * 释放某个 chat 当前 agent 的订阅。
   *
   * 必须在新建/切换会话前调用：旧 agent 的 agent/status、session/event 监听都闭包着
   * 同一个 state 对象，切换后迟到的 idle 会用**新**会话的 target 把旧回复发出去。
   */
  function detach(state) {
    while (state.disposers.length > 0) {
      const dispose = state.disposers.pop()
      try {
        if (typeof dispose === 'function') dispose()
        else if (typeof dispose?.dispose === 'function') dispose.dispose()
      } catch {
        /* ignore */
      }
    }
    state.attached = false
  }

  function attach(agent, state) {
    if (state.attached) return
    // 防御：attached=false 但仍留有旧订阅（例如上次 attach 后没走 detach 就换了 agent）
    detach(state)
    const scoped = typeof agent?.ctx?.on === 'function' ? agent.ctx : null
    if (scoped === null) return
    const on = scoped.on.bind(scoped)

    // ① 会话追加 feed（post-commit）：累积本轮 assistant 文本与回合失败原因。
    //    注意：真实 Session **没有** `.events` 属性（同步读法 snapshotEvents 已 deprecated），
    //    `session/event` 才是官方实时接口（agent 作用域，只收到本会话的事件）。
    const disposeFeed = on('session/event', (session, event) => {
      try {
        consumeSessionEvent(state, session, event, agent)
      } catch (error) {
        log.warn(`dsh-qq: 会话事件消费失败：${error instanceof Error ? error.message : String(error)}`)
      }
    })

    // ② 回合边界：running → typing；idle → 回发
    const disposeStatus = on('agent/status', payload => {
      if (payload?.agent !== agent) return
      if (payload.status === 'running') {
        if (capabilitiesOf(transport, state.target, routeOfChatKey(state.chatKey)).typing === true && state.target !== null) {
          void transport.sendTyping(state.target, routeOfChatKey(state.chatKey)).catch(() => {})
        }
        return
      }
      if (payload.status === 'idle') {
        void onIdle(agent, state).catch(error => log.warn(`回合结束处理失败：${error instanceof Error ? error.message : String(error)}`))
      }
    })

    // ③ 渠道提示写进该会话的系统提示词：
    //    ① 渲染能力：真机反馈（2026-09-24）部分 QQ 客户端**不渲染 Markdown**，模型照 Web 的
    //       习惯输出 `**加粗**`、``` 围栏、甚至 dsh-ui 卡片围栏 → QQ 里全是杂乱符号和一大段 JSON。
    //       在源头告诉模型「本渠道是纯文本」，比事后清理更省 token、也不丢结构意图。
    //    ② 群记忆：告诉模型群记忆落在哪、怎么写（用 qq_group_note），以及**不要**写进
    //       daily/project 记忆——那是用户工作区的记忆，群聊闲聊混进去就是污染。
    const extraSections = []
    if (needsPlainText(state.target)) {
      extraSections.push({ name: CHANNEL_PLAINTEXT_SECTION, text: PLAINTEXT_CHANNEL_NOTE, interpolate: false })
    } else {
      extraSections.push({ name: CHANNEL_MARKDOWN_SECTION, text: MARKDOWN_CHANNEL_NOTE, interpolate: false })
    }
    if (isGroupChat(state) && config.groupMemory?.enabled === true) {
      extraSections.push({ name: GROUP_MEMORY_SECTION, text: GROUP_MEMORY_NOTE, interpolate: false })
    }
    const noteDisposer =
      extraSections.length === 0
        ? null
        : on('system-prompt/assemble', async (_assembly, _context, next) => {
            const assembled = await next()
            if (assembled === null || typeof assembled !== 'object') return assembled
            const sections = Array.isArray(assembled.sections) ? assembled.sections : []
            const missing = extraSections.filter(extra => !sections.some(section => section?.name === extra.name))
            if (missing.length === 0) return assembled
            return { ...assembled, sections: [...sections, ...missing] }
          })

    state.disposers.push(disposeFeed, disposeStatus)
    if (noteDisposer !== null) state.disposers.push(noteDisposer)
    state.attached = true
  }

  /** 消费一条会话事件：维护本轮回复缓冲与失败原因。 */
  function consumeSessionEvent(state, session, event, agent) {
    if (session !== undefined && session !== null && session !== agent.session) return
    if (event === null || typeof event !== 'object') return
    if (event.type === 'user/message') {
      // 被 steer 的消息在「下一个步边界」被模型消费时会补一条 user/message 事件：
      // 此刻它已经不在途，必须释放配额。否则 steered 只增不减（只在回合结束时清零），
      // 一轮里连着发 8 条就会把第 9 条误判成「在途消息过多」直接拒掉——真机实测
      // 2026-09-24：10 连发丢了第 9 条，pending 1 + steered 7 = 8 正好撞上默认上限。
      state.steered = Math.max(0, state.steered - 1)
      return
    }
    if (event.type === 'turn/start') {
      state.replyParts = []
      state.turnError = null
      return
    }
    if (event.type === 'assistant/message') {
      const text = assistantTextOf(event)
      if (text !== '') state.replyParts.push(text)
      // token 用量：一轮可能有多条 assistant/message（每步一条），逐条累加到该对话。
      // chatKey 自带目标（私聊 = 某个人 / 群聊 = 某个群），所以控制台能按人/按群统计。
      const usage = event.data?.usage
      if (usage !== null && usage !== undefined && typeof store?.recordUsage === 'function') {
        try {
          void store.recordUsage(state.chatKey, usage)?.catch?.(() => {})
        } catch {
          /* 记账失败不影响回复链路 */
        }
      }
      return
    }
    if (event.type === 'turn/end') {
      const reason = event.data?.reason
      if (reason?.kind === 'error') {
        const detail = reason.error?.message ?? reason.error ?? '未知错误'
        state.turnError = String(detail).slice(0, 300)
      }
    }
  }

  /** 回合结束：把本轮 assistant 文本回发 QQ；回合失败则如实上报，不静默。 */
  async function onIdle(agent, state) {
    state.pending = Math.max(0, state.pending - 1)
    state.steered = 0
    const target = state.target
    const parts = Array.isArray(state.replyParts) ? state.replyParts : []
    const failure = state.turnError ?? null
    state.replyParts = []
    state.turnError = null
    if (target === null) return
    const text = parts.join('\n\n').trim()

    if (text === '') {
      if (failure !== null) {
        // 模型不可用（缺凭据/路由不存在）时先自愈：清掉失效选择、本次运行回退全局默认，
        // 并把「下一步怎么办」告诉用户，而不是只甩一坨英文错误。
        let hint = null
        if (typeof onTurnError === 'function') {
          try {
            hint = await onTurnError(state.chatKey, failure)
          } catch (error) {
            log.warn(`dsh-qq: 模型失败自愈异常：${error instanceof Error ? error.message : String(error)}`)
          }
        }
        const suffix = typeof hint === 'string' && hint !== '' ? `\n${hint}` : ''
        try {
          await transport.sendText(target, `⚠️ DSH 本轮执行失败：${failure}${suffix}`, routeOfChatKey(state.chatKey))
        } catch (error) {
          log.warn(`dsh-qq: 失败提示回发异常：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return
    }
    const trimmed = text.length > MAX_REPLY_CHARS ? `${text.slice(0, MAX_REPLY_CHARS)}\n…（内容过长已截断）` : text
    const route = routeOfChatKey(state.chatKey)
    const markdown = wantsMarkdown(config.markdown, capabilitiesOf(transport, target, route))
    // dsh-ui 卡片围栏只属于 DSH Web：QQ 端（无论是否支持 Markdown）都没有对应渲染，
    // 原样发过去只会变成一大段 JSON 代码块（真机反馈 2026-10-21：评审意见在 QQ 里显示成原始 JSON）。
    const rendered = markdown ? stripDshUiFences(trimmed) : toPlainText(trimmed)
    // 整条回复可能只有 dsh-ui 卡片围栏（Web 端渲染成卡片，QQ 里没有内容）：
    // ① 先把卡片里的结构化内容摘成文字版发出去（评审意见、表格结论往往都在卡片里）；
    // ② 实在没有可提取内容才回一句说明，不静默发空消息。
    const fallbackText = rendered === '' ? dshUiFencesToText(trimmed) : ''
    const body =
      rendered !== ''
        ? rendered
        : fallbackText !== ''
          ? fallbackText
          : '（本轮回复只有卡片内容，当前渠道不渲染卡片；换个问法我再答一次）'
    try {
      await transport.sendText(target, body, { markdown, ...route })
    } catch (error) {
      log.warn(`dsh-qq: 回发失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 单条入站消息的真正投递：配额 → 会话 → 内容 → followup / steer。
   * 由 handleUserMessage 按 chat 串行调用，不直接暴露。
   * @param {object} ev - 归一化入站事件。
   * @param {object} state - 该 chat 的运行时状态。
   * @returns {Promise<{accepted: boolean, reason?: string, reply?: string}>}
   */
  async function deliver(ev, state) {
    const inFlight = state.pending + state.steered
    if (inFlight >= config.maxQueuedMessagesPerChat) {
      return {
        accepted: false,
        reason: 'over-queue',
        reply: `当前会话在途消息过多（${inFlight} 条），请等待本轮完成或发送 /qq-stop。`,
      }
    }
    const agent = await ensureAgent(ev.chatKey, state)
    if (agent === null) {
      return { accepted: false, reason: 'no-agent', reply: 'DSH 会话创建失败，请查看日志。' }
    }
    state.target = ev.target
    await store.touch(ev.chatKey, { target: toChannelTarget(ev.target), at: clock() })
    const content = await buildContent(ev, { ctx, config, transport, scope, log, ambientContext })
    const message = createUserMessage({ content, source: { kind: 'user' } })
    // 投递语义（DSH 契约，packages/core/agent/src/runtime-types.ts）：
    //   followup = 独占一个新回合（本轮没跑完就得等，用户看到的是「排在队列里」）；
    //   steer    = 空闲时开一个新回合，运行中则在**本回合的下一个步边界**交给模型。
    // QQ 连续发消息（先发文件再补一句「这个文档内容是什么」）属于后者：
    // 第二句应该立刻进入正在跑的那一轮，而不是干等到轮末。
    const running = agent.status === 'running'
    const wantsSteer = running && config.midTurnDelivery === 'steer'
    const steered = wantsSteer && typeof agent.steer === 'function'
    if (steered) {
      state.steered += 1
      agent.steer(message)
    } else {
      // 想 steer 却不支持（换实现/老宿主）时如实告警：这条消息会排到本轮之后。
      if (wantsSteer) log.warn('dsh-qq: 当前 agent 不支持 steer，退回 followup（本条将排在本轮之后）')
      state.pending += 1
      agent.followup(message)
    }
    return { accepted: true }
  }

  const bridge = {
    /**
     * 入站消息 → DSH 会话。
     *
     * 同一 chat 的入站按到达顺序串行投递：媒体消息要先下载/转码（buildContent），
     * 若并行处理，第二条消息会在第一条还没开回合时就看到「空闲」，于是各自开一个
     * 回合——真机表现就是先发文档、再补一句「这个文档内容是什么」时，第二句被当成
     * 排队消息干等（甚至先于文档被回答）。串行后第二条必然看到 status=running，
     * 走 steer 进入同一回合的下一个步边界。
     */
    async handleUserMessage(ev) {
      const state = stateOf(ev.chatKey, ev.target)
      const intake = state.intake.then(() => deliver(ev, state), () => deliver(ev, state))
      state.intake = intake.then(
        () => undefined,
        () => undefined,
      )
      return intake
    },

    /** 渠道注册表 recentChat：最近交互对话。 */
    recentChat() {
      for (const state of runtime.values()) {
        if (state.target !== null) return { ...toChannelTarget(state.target), ...routeOfChatKey(state.chatKey) }
      }
      // 优先当前 transport 的历史对话：切换实现后旧协议的
      // openid 在新协议里是无意义的 id，直接拿去发会失败。
      const prefix = `${config.transport}:`
      const keys = store.chatKeys()
      const ordered = [...keys.filter(key => key.startsWith(prefix)), ...keys.filter(key => !key.startsWith(prefix))]
      for (const chatKey of ordered) {
        const chat = store.chat(chatKey)
        if (chat.lastTarget !== null && chat.lastTarget !== undefined) {
          return { ...chat.lastTarget, ...routeOfChatKey(chatKey) }
        }
      }
      return null
    },

    /** 该 chat 的当前会话 id。 */
    currentSession(chatKey) {
      const state = runtime.get(chatKey)
      return state?.sessionId || store.chat(chatKey).currentSessionId
    },

    /** 该 chat 的最近会话列表（store 持久化）。 */
    sessions(chatKey) {
      return store.sessions(chatKey)
    },

    /** 为 chat 新建会话（老会话保留在最近列表）。 */
    async newSession(chatKey) {
      const state = stateOf(chatKey)
      const previousSessionId = state.sessionId
      // 先解绑旧 agent，再换指针：旧回合迟到的 idle 不能再用新状态回发
      detach(state)
      const agent = await createAgent(chatKey)
      if (agent === null) return null
      state.agent = agent
      state.sessionId = sessionOf(agent)?.id ?? ''
      state.pending = 0
      state.steered = 0
      if (previousSessionId !== '' && previousSessionId !== state.sessionId) sessionIndex.delete(previousSessionId)
      sessionIndex.set(state.sessionId, chatKey)
      await store.setCurrentSession(chatKey, state.sessionId, { title: `QQ ${chatKey}` })
      attach(agent, state)
      return state.sessionId
    },

    /** 切换 chat 的当前会话（按 store 列表序号）。 */
    async switchSession(chatKey, index) {
      const state = stateOf(chatKey)
      const entry = await store.switchSession(chatKey, index)
      if (entry === null) return null
      const previousSessionId = state.sessionId
      detach(state)
      state.agent = null
      state.sessionId = entry.sessionId
      state.pending = 0
      state.steered = 0
      if (previousSessionId !== '' && previousSessionId !== entry.sessionId) sessionIndex.delete(previousSessionId)
      sessionIndex.set(entry.sessionId, chatKey)
      const agent = await ensureAgent(chatKey, state)
      return agent === null ? null : entry
    },

    /** 停止当前回合并清空排队（评审 §12.1）。 */
    async stop(chatKey, { keepQueue = false } = {}) {
      const state = stateOf(chatKey)
      const agent = state.agent ?? liveAgent(state.sessionId)
      if (!keepQueue) {
        state.pending = 0
        state.steered = 0
      }
      if (agent === null || agent === undefined) return false
      try {
        // AgentCancelCause 是对象联合，不是字符串（dsh-session types.ts L188）
        agent.cancel?.({ kind: 'user' })
      } catch (error) {
        log.warn(`dsh-qq: cancel 失败：${error instanceof Error ? error.message : String(error)}`)
        return false
      }
      return true
    },

    /** sessionId → chatKey（审批回发用）。 */
    chatKeyForSession(sessionId) {
      const hit = sessionIndex.get(sessionId)
      if (hit !== undefined) return hit
      // 重启后内存索引为空：按 store 里的会话指针反查（审批回发不能因为重启就消失）
      try {
        for (const chatKey of store.chatKeys()) {
          if (store.chat(chatKey).currentSessionId === sessionId) return chatKey
          if (store.sessions(chatKey).some(entry => entry.sessionId === sessionId)) return chatKey
        }
      } catch {
        /* store 不可用时按未知处理 */
      }
      return null
    },

    /** 目标 chat 的结构化 target（审批回发用）。 */
    targetForChat(chatKey) {
      const live = runtime.get(chatKey)?.target ?? null
      if (live !== null) return live
      // 重启后 runtime 为空：chatKey 本身就是 kind:account:targetKey，可直接还原
      try {
        return parseChatKey(chatKey).target
      } catch {
        return null
      }
    },

    /** 运行时状态快照（/qq-status、渠道 status 槽位）。 */
    status() {
      return {
        chats: runtime.size,
        pending: [...runtime.values()].reduce((sum, state) => sum + state.pending, 0),
        sessions: sessionIndex.size,
      }
    },

    /** 释放所有订阅（ResourceScope 兜底之外的第二道保险）。 */
    async dispose() {
      for (const state of runtime.values()) detach(state)
    },
  }

  if (scope !== undefined && scope !== null) {
    scope.add(() => bridge.dispose(), 'dsh-qq: bridge subscriptions')
  }

  return bridge
}

/**
 * 去掉回复里的 ```dsh-ui 卡片围栏（含围栏体）。
 *
 * 为什么无论如何都要剥：dsh-ui 是 DSH Web 的 UI 渲染语法，QQ 客户端没有对应物；
 * 官方 QQBot 虽然支持 Markdown，但 dsh-ui 围栏会被当成普通代码块原样显示——
 * 用户看到的就是一坨 JSON。剥掉后剩下的文字仍然完整。
 * @param {string} text
 * @returns {string}
 */
/**
 * 把 dsh-ui 围栏里的规格转成可读文字（卡片在 QQ 里不渲染时的兜底）。
 *
 * 为什么需要：剥掉围栏后回复可能为空（模型整段话都写在卡片里）。只回一句
 * 「只有卡片内容」对用户没有价值——卡片里的 callout/表格/列表/步骤往往正是正文。
 * 这里只做「结构化内容 → 纯文本」的无损摘取，不做样式还原；解析失败的围栏直接跳过。
 * @param {string} text
 * @returns {string} 文字版（没有可提取内容时为空串）
 */
export function dshUiFencesToText(text) {
  const source = String(text ?? '')
  if (source === '') return ''
  const lines = []
  for (const match of source.matchAll(/```dsh-ui[^\n]*\n([\s\S]*?)```/g)) {
    let spec = null
    try {
      spec = JSON.parse(match[1])
    } catch {
      continue
    }
    const block = specToPlainLines(spec)
    if (block.length > 0) lines.push(block.join('\n'))
  }
  return lines.join('\n\n').trim()
}

/** 单条卡片规格 → 文字行（常见容器与叶子类型；未知类型尽量取 text/content）。 */
function specToPlainLines(spec) {
  const out = []
  const push = value => {
    const text = String(value ?? '').trim()
    if (text !== '') out.push(text)
  }
  if (spec === null || typeof spec !== 'object') return out
  if (Array.isArray(spec)) {
    for (const child of spec) out.push(...nodeToLines(child))
    return out
  }
  push(spec.title)
  for (const child of Array.isArray(spec.items) ? spec.items : []) out.push(...nodeToLines(child))
  return out
}

/** 单个组件节点 → 若干文字行。 */
function nodeToLines(node) {
  const out = []
  const push = value => {
    const text = String(value ?? '').trim()
    if (text !== '') out.push(text)
  }
  const joinRow = row => (Array.isArray(row) ? row.map(cell => String(cell ?? '').trim()).filter(cell => cell !== '').join(' ｜ ') : String(row ?? ''))
  if (node === null || typeof node !== 'object') return out
  switch (node.type) {
    case 'callout':
      push(node.title)
      push(node.content)
      break
    case 'table':
      if (Array.isArray(node.columns) && node.columns.length > 0) push(joinRow(node.columns))
      for (const row of Array.isArray(node.rows) ? node.rows : []) push(joinRow(row))
      break
    case 'list':
      for (const entry of Array.isArray(node.items) ? node.items : []) push(`• ${String(entry ?? '').trim()}`)
      break
    case 'steps':
      ;(Array.isArray(node.steps) ? node.steps : []).forEach((step, index) => {
        const title = String(step?.title ?? '').trim()
        const desc = String(step?.desc ?? '').trim()
        push(`${index + 1}. ${title}${desc === '' ? '' : `：${desc}`}`)
      })
      break
    case 'keyvalue':
      for (const pair of Array.isArray(node.pairs) ? node.pairs : []) push(`${String(pair?.key ?? '').trim()}：${String(pair?.value ?? '').trim()}`)
      break
    case 'stat':
      push(`${String(node.label ?? '').trim()}：${String(node.value ?? '').trim()}`)
      break
    case 'row':
    case 'col':
    case 'grid':
    case 'card':
      for (const child of Array.isArray(node.children) ? node.children : []) out.push(...nodeToLines(child))
      break
    case 'divider':
    case 'spacer':
      break
    default:
      if (typeof node.content === 'string') push(node.content)
      else if (typeof node.text === 'string') push(node.text)
  }
  return out
}

export function stripDshUiFences(text) {
  let out = String(text ?? '')
  if (out === '') return ''
  out = out.replace(/```dsh-ui[^\n]*\n[\s\S]*?```/g, '')
  out = out.replace(/\n{3,}/g, '\n\n')
  return out.trim()
}

/** AttachmentStore 允许的图片媒体类型（服务端会按字节复核）。 */
/**
 * 把 Markdown/卡片风格的回复降级成纯文本（无渲染能力的渠道专用）。
 *
 * 真机反馈（2026-09-24）：个人 QQ 客户端不渲染 Markdown，用户看到的是
 * `**加粗**`、`### 标题`、``` 围栏，以及 dsh-ui 卡片围栏里的一大段 JSON——观感很糟。
 *
 * 只做「渲染语法 → 纯文本」的等价降级，不改写内容、不打乱顺序：
 *   ① dsh-ui 围栏整块删除（那是 DSH Web 的卡片，纯文本渠道里没有对应物）；
 *   ② 其他代码围栏去掉围栏行、保留代码本身；
 *   ③ 行内强调/行内代码标记去掉（`**x**` / `*x*` / `~~x~~` / `` `x` ``）；
 *   ④ `### 标题` → `标题`；⑤ `[文字](url)` → `文字（url）`；
 *   ⑥ 表格分隔行（`|---|---|`）删掉，避免一串竖线和横线。
 * @param {string} text
 * @returns {string}
 */
export function toPlainText(text) {
  let out = String(text ?? '')
  if (out === '') return ''
  out = out.replace(/```dsh-ui[^\n]*\n[\s\S]*?```/g, '')
  out = out.replace(/^[ \t]*```[^\n]*\n?/gm, '')
  out = out.replace(/```/g, '')
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '$1')
  out = out.replace(/__([^_\n]+)__/g, '$1')
  out = out.replace(/~~([^~\n]+)~~/g, '$1')
  out = out.replace(/`([^`\n]+)`/g, '$1')
  out = out.replace(/(^|[\s（(])\*([^*\n]+)\*(?=[\s）)。，、,.!！?？:：]|$)/g, '$1$2')
  out = out.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
  out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1（$2）')
  out = out.replace(/^[ \t]*\|?[ \t:|-]*-[ \t:|-]*\|[ \t:|-]*$/gm, '')
  // 表格数据行：去掉首尾竖线，单元格之间用全角竖线分隔，比一串半角竖线好读
  out = out.replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_match, cells) =>
    String(cells)
      .split('|')
      .map(cell => cell.trim())
      .filter(cell => cell !== '')
      .join(' ｜ '),
  )
  out = out.replace(/\n{3,}/g, '\n\n')
  return out.trim()
}

const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

const humanBytes = bytes => {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return ''
  if (value < 1024) return `${value}B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KB`
  return `${(value / 1024 / 1024).toFixed(1)}MB`
}

/** 人类可读的附件描述（不含带鉴权的原始 URL）。 */
export function describeMedia(item) {
  const kindLabel = { image: '图片', file: '文件', audio: '语音', video: '视频' }[item.kind] ?? '附件'
  const name = item.fileName === undefined || item.fileName === '' ? '' : ` ${item.fileName}`
  const size = item.size === undefined ? '' : ` (${humanBytes(item.size)})`
  return `${kindLabel}${name}${size}`
}

/** 客户端声明的 content-type 归一到 AttachmentStore 允许的类型。 */
export function normalizeImageType(raw) {
  const type = String(raw ?? '').toLowerCase().split(';')[0].trim()
  if (ALLOWED_IMAGE_TYPES.has(type)) return type
  if (type === 'image/jpg') return 'image/jpeg'
  return null
}

/** 把归一化事件转成模型可见的 content blocks（文本 + 媒体；P5 起支持附件入库）。 */
async function buildContent(ev, { ctx, config, transport, scope, log, ambientContext = null }) {
  const blocks = []
  // 群记忆上下文（只对群、且只在被 @ 走到这里时注入）：
  //   ① 群记忆——本群长期约定/梗/知识（落盘，跨重启，可人工编辑，模型用 qq_group_note 维护）；
  //   ② 群最近消息——「上次之后」群里发生的事，**含未 @ 机器人的发言**（内存环形缓冲 + 字符预算）。
  // 两段都零额外 LLM 调用：只是把已经收到的东西在下一轮里带上，热闹群也不会因此多花钱。
  if (ambientContext !== null && ev.target?.kind === 'group') {
    try {
      const ambient = await ambientContext(ev)
      if (ambient !== null && typeof ambient === 'object') {
        const notes = typeof ambient.notes === 'string' ? ambient.notes.trim() : ''
        if (notes !== '') blocks.push({ type: 'text', text: `[群记忆]\n${notes}` })
        const recent = typeof ambient.recent === 'string' ? ambient.recent.trim() : ''
        if (recent !== '') {
          const omitted = Number(ambient.omitted ?? 0)
          const more = Number.isFinite(omitted) && omitted > 0 ? `\n（更早还有 ${omitted} 条未显示）` : ''
          blocks.push({ type: 'text', text: `[群最近消息（含未 @ 你的）]\n${recent}${more}` })
        }
      }
    } catch (error) {
      // 上下文是增强项：取不到就照常回答，绝不因为群记忆失败而丢消息
      log.warn(`dsh-qq: 群上下文注入失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  // 被引用的消息可能只有附件没有文字（QQ 里文件和文字无法合成一条消息，
  // 群文件的标准用法是「先发文件 → 再引用它提问」）：这时用附件描述当引用标签，
  // 并把被引用的附件一起入库，否则模型只能回「我这边没有附件」（真机 2026-09-24）。
  // 另外一定要标出**被引消息是谁说的**：引用群友消息提问时，模型需要知道出处
  //（真机 2026-09-24：只有原文、没有发送人，机器人答不出「谁发的」）。
  // 昵称同样走 speakerTag 的 sanitize（外部可控数据，不能用来伪造身份）。
  const quotedMedia = Array.isArray(ev.replyTo?.media) ? ev.replyTo.media : []
  const quotedText = typeof ev.replyTo?.text === 'string' ? ev.replyTo.text : ''
  const quoteLabel = quotedText !== '' ? quotedText : quotedMedia.length > 0 ? describeMedia(quotedMedia[0]) : ''
  const quotedHead = speakerTag(ev.replyTo?.sender)
  if (quoteLabel !== '') blocks.push({ type: 'text', text: `[引用消息] ${quotedHead}${quoteLabel}` })
  // 群聊一个会话多人发言：给送进模型的内容加说话人前缀（展示层职责，
  // 不能放在 transport 里——那会破坏命令解析），私聊不加。
  // 昵称完全由外部用户控制，必须 sanitize（换行/控制字符/结构字符会被用来伪造身份），
  // 并带上平台侧不可伪造的 QQ 号，让模型/审计始终能对齐真实身份。
  const head = ev.target?.kind === 'group' ? speakerTag(ev.sender) : ''
  if (ev.text !== '') blocks.push({ type: 'text', text: `${head}${ev.text}` })

  const rawMedia = [...(Array.isArray(ev.media) ? ev.media : []), ...quotedMedia]
  const items = rawMedia.slice(0, config.maxMediaPerMessage)
  if (rawMedia.length > items.length) {
    blocks.push({
      type: 'text',
      text: `[已忽略 ${rawMedia.length - items.length} 个附件：单条消息最多处理 ${config.maxMediaPerMessage} 个]`,
    })
  }
  if (items.length > 0) {
    const attachments = ctx.get?.('attachments') ?? null
    const canDownload = typeof (transport.downloadMediaFor ?? transport.downloadMedia) === 'function'
    for (const item of items) {
      // 语音：优先 QQ 内置 ASR（免费），其次外部 STT，最后如实降级
      if (item.kind === 'audio') {
        if (typeof item.asrText === 'string' && item.asrText !== '') {
          blocks.push({ type: 'text', text: `[语音转写] ${item.asrText}` })
          continue
        }
        const sttKey = await resolveSttApiKey(ctx)
        if (sttKey !== '' && config.stt.baseUrl !== '' && canDownload) {
          const downloaded = await downloadMediaOf(transport, ev.target, item.url, { maxBytes: config.maxFileBytes, signal: scope?.signal, transportKind: ev.transportKind, accountId: ev.accountId })
          if (downloaded.ok) {
            const result = await transcribeAudio({
              data: downloaded.data,
              fileName: item.fileName === undefined || item.fileName === '' ? 'voice.silk' : item.fileName,
              mime: item.mime ?? 'application/octet-stream',
              stt: config.stt,
              apiKey: sttKey,
              signal: scope?.signal,
            })
            blocks.push({
              type: 'text',
              text: result.ok ? `[语音转写] ${result.text}` : `[语音消息（转写失败：${result.error}）]`,
            })
            continue
          }
        }
        blocks.push({ type: 'text', text: '[语音消息（未启用转写）]' })
        continue
      }

      // 图片 / 文件：下载 → 附件服务入库 → 模型可见 block
      const isIngestable = (item.kind === 'image' || item.kind === 'file') && attachments !== null && canDownload
      if (!isIngestable) {
        blocks.push({ type: 'text', text: `[${describeMedia(item)}（当前部署无法入库附件）]` })
        continue
      }
      const downloaded = await downloadMediaOf(transport, ev.target, item.url, { maxBytes: config.maxFileBytes, signal: scope?.signal, transportKind: ev.transportKind, accountId: ev.accountId })
      if (!downloaded.ok) {
        blocks.push({
          type: 'text',
          text: `[${describeMedia(item)} 获取失败：${downloaded.error}]`,
        })
        blocks.push({ type: 'text', text: '（原图未取到：请如实告知用户，不要读取本机其他附件或历史文件来代替这张图。）' })
        continue
      }
      if (item.kind === 'image') {
        const mediaType = normalizeImageType(downloaded.contentType || item.mime)
        if (mediaType === null) {
          blocks.push({ type: 'text', text: `[${describeMedia(item)}（不支持的图片格式，已跳过）]` })
          continue
        }
        try {
          const ref = await attachments.saveImage({
            data: downloaded.data,
            mediaType,
            ...(item.fileName === undefined || item.fileName === '' ? {} : { name: item.fileName }),
          })
          blocks.push({ type: 'image', attachment: ref })
        } catch (error) {
          log.warn(`dsh-qq: 图片入库失败：${error instanceof Error ? error.message : String(error)}`)
          blocks.push({ type: 'text', text: `[${describeMedia(item)} 入库失败]` })
        }
        continue
      }
      try {
        const ref = await attachments.saveFile({
          data: downloaded.data,
          ...(item.fileName === undefined || item.fileName === '' ? {} : { name: item.fileName }),
        })
        blocks.push({ type: 'file', attachment: ref })
      } catch (error) {
        log.warn(`dsh-qq: 文件入库失败：${error instanceof Error ? error.message : String(error)}`)
        blocks.push({ type: 'text', text: `[${describeMedia(item)} 入库失败]` })
      }
    }
  }

  if (blocks.length === 0) blocks.push({ type: 'text', text: '[空消息]' })
  return blocks
}

export default createBridge

/**
 * 构造群聊说话人标签：`[昵称|QQ号] `（私聊或信息缺失时返回空串）。
 *
 * 昵称是**外部可控数据**：去掉换行/控制字符、折叠空白、剔除 `[]<>|` 等结构字符、
 * 限长 32 字符；QQ 号来自平台，作为身份锚点一起给出。
 * @param {{id?: string, name?: string}} sender
 * @returns {string}
 */
export function speakerTag(sender) {
  const id = String(sender?.id ?? '').trim()
  const rawName = String(sender?.name ?? '')
  const name = rawName
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[\[\]<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 32)
  if (name === '' && id === '') return ''
  if (id === '') return `[${name}] `
  if (name === '' || name === id) return `[${id}] `
  return `[${name}|${id}] `
}
