/**
 * 线路掉线提醒。
 *
 * 定位：这是一个**后台服务**插件，线路挂了没人会发现——页面是你主动打开才看得到，
 * 所以需要主动报告。两类出口：
 * - 页面告警条（始终生效）：控制台顶部显示当前掉线的线路与持续时间；
 * - QQ 私聊通知（可关）：用「另一条还活着的线路」给主人发私聊，两条都挂时先把通知排队，
 *   等任意一条恢复后再补发（带上恢复时间），不会丢消息也不会刷屏。
 *
 * 防抖与节流：
 * - 连续掉线超过 `downAfterMs` 才提醒（默认 60s），避免网络抖动刷屏；
 * - 同一条线两次提醒至少间隔 `cooldownMs`（默认 10 分钟）；
 * - 每条线「掉线→已提醒→恢复」只发一次恢复通知；
 * - `no-credentials` 不算掉线（那是配置问题，页面已有提示，反复提醒只会制造噪音）。
 */

const LABELS = Object.freeze({ qqbot: '官方线', onebot: '个人线' })

/** 不算「掉线」的相位：还没配置凭据 / 初始空闲。 */
const SKIP_PHASES = new Set(['no-credentials', 'idle'])

/** 事件与待发通知的容量上限（内存有界）。 */
const MAX_EVENTS = 20
const MAX_PENDING = 3

const labelOf = kind => LABELS[kind] ?? String(kind)

/** 把 transport status 描述成一句人话（给通知和事件用）。 */
function describe(status) {
  if (status === null || status === undefined) return '状态未知'
  if (status.connected === true) {
    return status.backend ? `已连接（${status.backend}${status.backendVersion ? ' ' + status.backendVersion : ''}）` : '已连接'
  }
  const phase = status.phase ?? 'unknown'
  const error = typeof status.lastError === 'string' && status.lastError !== '' ? `：${status.lastError.slice(0, 120)}` : ''
  return `${phase}${error}`
}

/**
 * 创建告警管理器。
 * @param {object} deps
 * @param {object} deps.config - resolveConfig 结果（读取 alerts 段）。
 * @param {object} deps.store - 取主人私聊目标（homeChannel）。
 * @param {object} deps.transports - 多线路注册表（entries / forKind / getOrigin）。
 * @param {(() => string|null)} [deps.pageUrl] - 控制台地址（通知里带上）。
 * @param {object} [deps.logger]
 * @param {(() => number)} [deps.clock]
 * @returns {object} 告警管理器
 */
export function createAlertManager({ config, store, transports, pageUrl = null, logger = null, clock = () => Date.now() }) {
  const settings = config.alerts ?? {}
  const enabled = settings.enabled !== false
  const notifyEnabled = settings.notify !== false
  const downAfterMs = Number.isFinite(settings.downAfterMs) ? settings.downAfterMs : 60_000
  const cooldownMs = Number.isFinite(settings.cooldownMs) ? settings.cooldownMs : 600_000

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

  /** kind → { downSince, notifiedAt, notifiedForDown } */
  const lines = new Map()
  /** 最近事件（新的在前） */
  const events = []
  /** 两条线都挂时排队等待补发的通知 */
  const pending = []
  /** 最近一次 evaluate 的在线告警（页面直接读这个） */
  let lastActive = []

  const entries = Array.isArray(transports?.entries) ? transports.entries : []
  const statusOf = kind => {
    const entry = typeof transports?.forKind === 'function' ? transports.forKind(kind) : null
    if (entry === null) return null
    try {
      return typeof entry.transport.status === 'function' ? entry.transport.status() : null
    } catch {
      return null
    }
  }

  const pushEvent = (type, text, at) => {
    events.unshift({ at, type, text })
    if (events.length > MAX_EVENTS) events.length = MAX_EVENTS
    if (type === 'up') log.info(`dsh-qq: 告警 ${text}`)
    else if (type === 'down') log.warn(`dsh-qq: 告警 ${text}`)
  }

  /**
   * 把一条通知发给主人：遍历所有在线线路，用第一条「自己在线且配了主人私聊」的线路。
   * 下载 2026-10-21：恢复通知常常发生在「出问题的那条线正好是唯一配了 home channel 的线」，
   * 只尝试固定线路会漏发——所以逐个试。
   * @param {string} text
   * @returns {Promise<boolean>} 是否至少有一条线路送达
   */
  const deliver = async text => {
    if (!notifyEnabled) return false
    for (const entry of entries) {
      let status = null
      try {
        status = entry.transport.status()
      } catch {
        status = null
      }
      if (status?.connected !== true) continue
      const home = typeof store?.homeChannel === 'function' ? store.homeChannel(entry.kind) : ''
      if (typeof home !== 'string' || home === '') continue
      try {
        const result = await entry.transport.sendText({ kind: 'dm', userId: home }, text, {})
        if (result?.ok === true) return true
      } catch (error) {
        log.warn(`dsh-qq: 告警通知发送失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return false
  }

  /** 通知文本。 */
  const textFor = (type, kind, status) => {
    const url = typeof pageUrl === 'function' ? pageUrl() : null
    const suffix = url === null || url === '' ? '' : `\n控制台：${url}`
    if (type === 'down') return `⚠️ dsh-qq：${labelOf(kind)}掉线（${describe(status)}）${suffix}`
    if (type === 'up') return `✅ dsh-qq：${labelOf(kind)}已恢复（${describe(status)}）`
    return `⚠️ dsh-qq：${labelOf(kind)}掉线（补发通知，发送时线路可能已恢复）${suffix}`
  }

  /** 发一条通知：没有可用线路时排队（有界）。 */
  const notify = async (type, kind, status) => {
    const text = textFor(type, kind, status)
    if (!notifyEnabled) {
      pushEvent(type, text, clock())
      return
    }
    const delivered = await deliver(text)
    if (!delivered) {
      pending.push(text)
      if (pending.length > MAX_PENDING) pending.shift()
      pushEvent(type, text + '（暂无可用线路，已排队）', clock())
      return
    }
    pushEvent(type, text, clock())
  }

  /** 任意线路恢复后补发排队中的通知。 */
  const flushPending = async () => {
    if (pending.length === 0) return
    for (const text of pending.splice(0, pending.length)) {
      const delivered = await deliver(text.replace('⚠️ dsh-qq：', '⚠️ dsh-qq：（补发）'))
      if (!delivered) {
        pending.push(text)
        break
      }
    }
  }

  /**
   * 评估一次（index 每 10 秒调用；测试可直接传时间）。
   * @param {number} [at]
   * @returns {Promise<{active: Array<object>, events: Array<object>}>}
   */
  async function evaluate(at = clock()) {
    if (!enabled) {
      lastActive = []
      return snapshot()
    }
    await flushPending()
    const active = []
    for (const entry of entries) {
      const kind = entry.kind
      const status = statusOf(kind)
      if (status === null) continue
      const state = lines.get(kind) ?? { downSince: null, notifiedAt: 0, notifiedForDown: false }
      const phase = status.phase ?? 'unknown'
      const down = status.connected !== true && !SKIP_PHASES.has(phase)
      if (down) {
        if (state.downSince === null) state.downSince = at
        const since = state.downSince
        active.push({ kind, label: labelOf(kind), since, phase, lastError: String(status.lastError ?? '').slice(0, 200) })
        const sustained = at - since
        const cooled = at - state.notifiedAt >= cooldownMs
        if (sustained >= downAfterMs && !state.notifiedForDown && cooled) {
          state.notifiedAt = at
          state.notifiedForDown = true
          await notify('down', kind, status)
        }
      } else {
        active.push(null) // 占位，下面过滤
        if (state.notifiedForDown) {
          state.notifiedForDown = false
          await notify('up', kind, status)
        }
        state.downSince = null
      }
      lines.set(kind, state)
    }
    lastActive = active.filter(Boolean)
    return snapshot()
  }

  /** 页面/诊断用快照：当前在线告警 + 最近事件。 */
  function snapshot() {
    return {
      enabled,
      notify: notifyEnabled,
      active: lastActive.map(entry => ({ ...entry })),
      events: events.map(event => ({ ...event })),
      pending: pending.length,
    }
  }

  return { evaluate, snapshot }
}
