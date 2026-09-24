/**
 * 测试用 fake Cordis 上下文与 fake agents —— 让 dsh-qq 的 P0 模块可以脱离
 * 真实 DSH 宿主跑 `node --test`。
 *
 * 只实现 dsh-qq 真正使用到的宿主表面：
 *   ctx.logger / ctx.on / ctx.emit / ctx.effect / ctx.inject / ctx.get / ctx.agents
 */

/** 收集日志的 logger。 */
export function createLogger() {
  const entries = { info: [], warn: [], error: [] }
  return {
    entries,
    info(message) {
      entries.info.push(String(message))
    },
    warn(message) {
      entries.warn.push(String(message))
    },
    error(message) {
      entries.error.push(String(message))
    },
  }
}

/**
 * 创建一个假 Agent（含 agent.ctx 事件、session.append/requestHeader，供 P3 模型选择测试）。
 * @param {object} spec
 * @param {string} spec.sessionId
 * @param {Array<object>} [spec.events]
 */
export function createFakeAgent({ sessionId, events = [] }) {
  const agent = {
    session: { id: sessionId, events },
    followed: [],
    steered: [],
    cancelled: [],
    appended: [],
    header: undefined,
    _status: 'idle',
    /** 真实契约：status 是 agent 的同步属性（idle|running），插件据此选择 followup/steer。 */
    get status() {
      return agent._status
    },
    /**
     * 真实契约：followup 会唤醒 driver，agent.ts 的 wakeDriver **同步**把相位切到
     * running（setPhase），所以下一条消息必然看到 status=running。fake 里必须复刻
     * 这一步，否则「第二条消息该 steer 还是 followup」的判断会被测试双精度掩盖。
     */
    followup(message) {
      agent.followed.push(message)
      if (agent._status === 'idle') agent._status = 'running'
    },
    /** 真实契约：steer 在空闲时也会开一个回合，运行中则在本回合下一个步边界被消费。 */
    steer(message) {
      agent.steered.push(message)
      if (agent._status === 'idle') agent._status = 'running'
    },
    cancel(cause) {
      agent.cancelled.push(cause)
    },
    /** 测试辅助：追加一条 assistant 回复事件，并经 session/event feed 投递（复刻真实接口）。 */
    reply(text, seq = agent.session.events.length + 1) {
      const event = {
        type: 'assistant/message',
        seq,
        time: Date.now(),
        data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
      }
      appendEvent(event)
      return agent
    },
    /** 测试辅助：一个成功的回合结束（清楚当前缓冲）。 */
    endTurn({ completed = true, error = null, seq = agent.session.events.length + 1 } = {}) {
      appendEvent({
        type: 'turn/end',
        seq,
        time: Date.now(),
        data: { turn: 1, reason: completed ? { kind: 'completed' } : { kind: 'error', error: { message: error ?? '未知错误' } } },
      })
      return agent
    },
  }
  const appendEvent = event => {
    agent.session.events.push(event)
    if (agentAppend !== null) agentAppend(event)
    return event
  }
  agent.session.append = (type, data) => {
    const event = { type, data, seq: agent.session.events.length + 1, time: Date.now() }
    agent.appended.push(event)
    return appendEvent(event)
  }
  agent.session.requestHeader = () => agent.header
  /** 该 agent 作用域内的监听者（复刻 DSH Scoped<Agent>：只有挂在 agent.ctx 上才收得到） */
  const agentListeners = new Map()
  const agentAppendListeners = new Set()
  /** 会话追加 feed 的派发器（agent.ctx 建好后填充）。 */
  const agentAppend = event => {
    for (const listener of [...agentAppendListeners]) listener(agent.session, event)
  }
  agent.ctx = {
    /** 会话追加 feed：与真实 `session/event` 一致（agent 作用域 + 提交后投递）。 */
    session: agent.session,
    emit(event, payload) {
      for (const listener of [...(agentListeners.get(event) ?? [])]) listener(payload)
    },
    /** 常用快捷方式：派发一次状态事件（同时同步 agent.status，与真实 agent 一致）。 */
    emitStatus(status) {
      agent._status = status
      agent.ctx.emit('agent/status', { agent, status })
    },
    on(event, listener) {
      if (event === 'session/event') {
        // 真实接口：注册会话追加监听
        let set = agentAppendListeners
        set.add(listener)
        return () => set.delete(listener)
      }
      let set = agentListeners.get(event)
      if (set === undefined) {
        set = new Set()
        agentListeners.set(event, set)
      }
      set.add(listener)
      return () => set.delete(listener)
    },
    listenerCount(event) {
      return agentListeners.get(event)?.size ?? 0
    },
    /**
     * 运行 waterfall 监听链（模拟 cordis 的 (…args, next) 派发）。
     * @param {string} event
     * @param {Array<unknown>} args - 传给监听器的前置参数。
     * @param {Function} terminal - 最末端的默认实现。
     */
    async runWaterfall(event, args, terminal) {
      const chain = [...(agentListeners.get(event) ?? [])]
      let index = -1
      const next = async () => {
        index += 1
        if (index < chain.length) return chain[index](...args, next)
        return terminal()
      }
      return next()
    },
  }
  return agent
}

/** 创建 fake agents 服务（记录 create/resume 调用）。 */
export function createFakeAgents() {
  const live = new Map()
  const created = []
  const resumed = []
  const resumeCalls = []
  const failed = { create: null, resume: null }
  return {
    created,
    resumed,
    resumeCalls,
    failed,
    live,
    async create({ sessionId, meta, agentOptions, setup }) {
      if (failed.create !== null) throw new Error(failed.create)
      const agent = createFakeAgent({ sessionId })
      live.set(sessionId, agent)
      created.push({ sessionId, meta, agentOptions, setup })
      return { agent, dispose: async () => {} }
    },
    async resume(options = {}) {
      // 真实服务签名是单参 resume(options)；传两个参数（把 ctx 当 options）会读不到
      // resumeSessionId，这里如实复刻同款失败，避免同类误用再次溜过测试。
      if (options === null || typeof options !== 'object' || typeof options.resumeSessionId !== 'string') {
        throw new Error('cannot get property "resumeSessionId" without inject')
      }
      if (failed.resume !== null) throw new Error(failed.resume)
      const { resumeSessionId, agentOptions, setup } = options
      resumeCalls.push({ resumeSessionId, agentOptions, setup })
      const existing = live.get(resumeSessionId)
      if (existing !== undefined) return { agent: existing, dispose: async () => {} }
      const agent = createFakeAgent({ sessionId: resumeSessionId })
      live.set(resumeSessionId, agent)
      resumed.push(resumeSessionId)
      return { agent, dispose: async () => {} }
    },
    get(id) {
      return live.get(id)
    },
    list() {
      return [...live.values()]
    },
  }
}

/**
 * 创建 fake ctx。
 * @param {object} [options]
 * @param {object} [options.services] - ctx.get(name) 可解析的服务（agents/commands/sessionPersistence…）。
 * @param {object} [options.logger]
 */
/**
 * 复刻 cordis `safeCollect` 的合法性判断：只接受函数 / null / undefined /
 * thenable / 可迭代；其它对象（如插件 apply 返回的普通句柄对象）一律抛
 * `TypeError: Invalid effect`——这样假 ctx 才能像真实 cordis 一样拦住这类错误。
 */
export function validateEffect(value, label = '') {
  if (value === null || value === undefined) return value
  if (typeof value === 'function') return value
  if (typeof value === 'object') {
    if (typeof value.then === 'function') return value
    if (Symbol.iterator in value || Symbol.asyncIterator in value) return value
  }
  throw new TypeError(`Invalid effect${label === '' ? '' : ` (${label})`}`)
}

export function createFakeCtx({ services = {}, logger = createLogger() } = {}) {
  const listeners = new Map()
  const disposers = []
  let disposed = false

  const ctx = {
    logger,
    get(name) {
      return services[name]
    },
    on(event, listener) {
      let set = listeners.get(event)
      if (set === undefined) {
        set = new Set()
        listeners.set(event, set)
      }
      set.add(listener)
      const dispose = () => set.delete(listener)
      disposers.push(dispose)
      return dispose
    },
    emit(event, payload) {
      const set = listeners.get(event)
      if (set === undefined) return
      for (const listener of [...set]) listener(payload)
    },
    /** waterfall 派发（approval/request 等）：listener(payload, next)。 */
    async emitWaterfall(event, payload, terminal = async () => 'unavailable') {
      const set = listeners.get(event)
      const chain = set === undefined ? [] : [...set]
      let index = -1
      const next = async () => {
        index += 1
        if (index < chain.length) return chain[index](payload, next)
        return terminal()
      }
      return next()
    },
    listenerCount(event) {
      return listeners.get(event)?.size ?? 0
    },
    effect(fn, label) {
      const result = validateEffect(fn(), label)
      if (typeof result === 'function') disposers.push(result)
      return result
    },
    inject(names, callback) {
      const sub = { ...ctx }
      for (const name of names) {
        if (services[name] !== undefined) sub[name] = services[name]
      }
      const result = validateEffect(callback(sub), `inject(${names.join(',')})`)
      if (typeof result === 'function') disposers.push(result)
      return result
    },
    async dispose() {
      if (disposed) return
      disposed = true
      while (disposers.length > 0) {
        const dispose = disposers.pop()
        try {
          await dispose()
        } catch {
          /* ignore */
        }
      }
      listeners.clear()
    },
  }

  if (services.agents !== undefined) ctx.agents = services.agents
  // 复刻 cordis：ctx.root 指向根上下文（插件常挂 root 以接收作用域事件）
  ctx.root = ctx
  return ctx
}

/** 便捷：造一个已授权用户（owner）的入站事件。 */
export function inboundFor(transport, { user = 'owner-1', name = 'Owner', text = 'hi', target = { kind: 'dm', userId: 'owner-1' }, mentioned = false } = {}) {
  return transport.inject({
    transportKind: 'mock',
    accountId: 'mock',
    target,
    sender: { id: user, name },
    text,
    mentioned,
  })
}
