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
import { toChannelTarget, wantsMarkdown } from './transport.js'
import { resolveSttApiKey, transcribeAudio } from './stt.js'

/** 单次回复的最大字符数（超出由 transport 分段）。 */
export const MAX_REPLY_CHARS = 8000

/** plugin 来源的上下文摘要上限（与 DSH CONTEXT_SUMMARY_MAX_CHARS 一致）。 */
const SUMMARY_MAX_CHARS = 120

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
export function createBridge({ ctx, config, store, transport, scope, logger = null, clock = () => Date.now(), onAgentReady = null }) {
  /** chatKey → 运行时状态 */
  const runtime = new Map()
  /** sessionId → chatKey */
  const sessionIndex = new Map()
  const attachDisposers = []

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
  async function resolveComposition({ storedPreset = undefined } = {}) {
    const presets = ctx.get?.('agentPresets')
    if (presets === undefined || presets === null || typeof presets.resolve !== 'function') {
      return { agentPreset: storedPreset, setup: undefined }
    }
    const wanted = storedPreset ?? (config.agentPreset !== '' ? config.agentPreset : presets.defaultId)
    try {
      const preset = await presets.resolve(wanted)
      const presetId = typeof preset?.id === 'string' && preset.id !== '' ? preset.id : wanted
      return {
        agentPreset: presetId,
        setup:
          typeof presets.mount === 'function'
            ? async agentCtx => {
                await presets.mount(agentCtx, presetId)
              }
            : undefined,
      }
    } catch (error) {
      log.warn(`dsh-qq: 解析 agent preset「${wanted}」失败：${error instanceof Error ? error.message : String(error)}`)
      return { agentPreset: storedPreset, setup: undefined }
    }
  }

  async function createAgent(chatKey) {
    const sessionId = `qq-${randomUUID()}`
    const composition = await resolveComposition()
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
    const composition = await resolveComposition({ storedPreset })
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
  function attach(agent, state) {
    if (state.attached) return
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
        if (transport.capabilities().typing === true && state.target !== null) {
          void transport.sendTyping(state.target).catch(() => {})
        }
        return
      }
      if (payload.status === 'idle') void onIdle(agent, state)
    })

    state.attached = true
    attachDisposers.push(disposeFeed, disposeStatus)
  }

  /** 消费一条会话事件：维护本轮回复缓冲与失败原因。 */
  function consumeSessionEvent(state, session, event, agent) {
    if (session !== undefined && session !== null && session !== agent.session) return
    if (event === null || typeof event !== 'object') return
    if (event.type === 'turn/start') {
      state.replyParts = []
      state.turnError = null
      return
    }
    if (event.type === 'assistant/message') {
      const text = assistantTextOf(event)
      if (text !== '') state.replyParts.push(text)
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
        try {
          await transport.sendText(target, `⚠️ DSH 本轮执行失败：${failure}`)
        } catch (error) {
          log.warn(`dsh-qq: 失败提示回发异常：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return
    }
    const trimmed = text.length > MAX_REPLY_CHARS ? `${text.slice(0, MAX_REPLY_CHARS)}\n…（内容过长已截断）` : text
    try {
      await transport.sendText(target, trimmed, { markdown: wantsMarkdown(config.markdown, transport.capabilities()) })
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
    const content = await buildContent(ev, { ctx, config, transport, scope, log })
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
        if (state.target !== null) return toChannelTarget(state.target)
      }
      // 优先当前 transport 的历史对话：切换传输后，旧传输的 id 在新传输里
      // 可能是无意义的标识，直接拿去发会失败。
      const prefix = `${config.transport}:`
      const keys = store.chatKeys()
      const ordered = [...keys.filter(key => key.startsWith(prefix)), ...keys.filter(key => !key.startsWith(prefix))]
      for (const chatKey of ordered) {
        const chat = store.chat(chatKey)
        if (chat.lastTarget !== null && chat.lastTarget !== undefined) return chat.lastTarget
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
      const agent = await createAgent(chatKey)
      if (agent === null) return null
      state.agent = agent
      state.sessionId = sessionOf(agent)?.id ?? ''
      state.pending = 0
      state.steered = 0
      state.attached = false
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
      state.agent = null
      state.sessionId = entry.sessionId
      state.pending = 0
      state.steered = 0
      state.attached = false
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
      return sessionIndex.get(sessionId) ?? null
    },

    /** 目标 chat 的结构化 target（审批回发用）。 */
    targetForChat(chatKey) {
      return runtime.get(chatKey)?.target ?? null
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
      while (attachDisposers.length > 0) {
        const dispose = attachDisposers.pop()
        try {
          if (typeof dispose === 'function') dispose()
          else if (typeof dispose?.dispose === 'function') dispose.dispose()
        } catch {
          /* ignore */
        }
      }
      for (const state of runtime.values()) state.attached = false
    },
  }

  if (scope !== undefined && scope !== null) {
    scope.add(() => bridge.dispose(), 'dsh-qq: bridge subscriptions')
  }

  return bridge
}

/** AttachmentStore 允许的图片媒体类型（服务端会按字节复核）。 */
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
async function buildContent(ev, { ctx, config, transport, scope, log }) {
  const blocks = []
  if (ev.replyTo !== null && ev.replyTo !== undefined && ev.replyTo.text !== '') {
    blocks.push({ type: 'text', text: `[引用消息] ${ev.replyTo.text}` })
  }
  // 群聊一个会话多人发言：给送进模型的内容加说话人前缀（展示层职责，
  // 不能放在 transport 里——那会破坏命令解析），私聊不加。
  // 昵称完全由外部用户控制，必须 sanitize（换行/控制字符/结构字符会被用来伪造身份），
  // 并带上平台侧不可伪造的 QQ 号，让模型/审计始终能对齐真实身份。
  const head = ev.target?.kind === 'group' ? speakerTag(ev.sender) : ''
  if (ev.text !== '') blocks.push({ type: 'text', text: `${head}${ev.text}` })

  const rawMedia = Array.isArray(ev.media) ? ev.media : []
  const items = rawMedia.slice(0, config.maxMediaPerMessage)
  if (rawMedia.length > items.length) {
    blocks.push({
      type: 'text',
      text: `[已忽略 ${rawMedia.length - items.length} 个附件：单条消息最多处理 ${config.maxMediaPerMessage} 个]`,
    })
  }
  if (items.length > 0) {
    const attachments = ctx.get?.('attachments') ?? null
    const canDownload = typeof transport.downloadMedia === 'function'
    for (const item of items) {
      // 语音：优先 QQ 内置 ASR（免费），其次外部 STT，最后如实降级
      if (item.kind === 'audio') {
        if (typeof item.asrText === 'string' && item.asrText !== '') {
          blocks.push({ type: 'text', text: `[语音转写] ${item.asrText}` })
          continue
        }
        const sttKey = await resolveSttApiKey(ctx)
        if (sttKey !== '' && config.stt.baseUrl !== '' && canDownload) {
          const downloaded = await transport.downloadMedia(item.url, { maxBytes: config.maxFileBytes, signal: scope?.signal })
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
      const downloaded = await transport.downloadMedia(item.url, { maxBytes: config.maxFileBytes, signal: scope?.signal })
      if (!downloaded.ok) {
        blocks.push({ type: 'text', text: `[${describeMedia(item)} 获取失败：${downloaded.error}]` })
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
