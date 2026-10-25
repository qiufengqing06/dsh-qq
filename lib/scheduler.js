/**
 * 定时提醒 / 主动任务（Phase 1）。
 *
 * 设计边界：
 *  - 任务存 store（原子 JSON），重启不丢；scheduler 只做 30s tick；
 *  - 固定提醒（social=false）work/chat 都可触发；社交主动（social=true）仅 chat；
 *  - 到点触发时走 bridge 的内部入站事件，命中该 chat 当前模式的会话；
 *  - 忙时跳过，不 steer 人工任务；错过不补发（once 超过宽限直接过期）；
 *  - 官方线/个人线都走 transport；平台不支持主动消息时如实记录 lastError。
 */

const ONCE_GRACE_MS = 10 * 60 * 1000
const DEFAULT_TICK_MS = 30_000

/** 本地时间 HH:MM。 */
export function nowHHMM(now = Date.now()) {
  const d = new Date(now)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 本地日期 YYYY-MM-DD。 */
export function todayKey(now = Date.now()) {
  const d = new Date(now)
  const p = value => String(value).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** "HH:MM" → 分钟数。 */
function minutesOf(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim())
  if (match === null) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return hour * 60 + minute
}

/** 解析 "HH:MM-HH:MM"；跨夜（23:00-08:00）允许。 */
export function parseQuietHours(value) {
  const match = /^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/.exec(String(value ?? '').trim())
  if (match === null) return null
  const start = minutesOf(match[1])
  const end = minutesOf(match[2])
  if (start === null || end === null) return null
  return { start, end }
}

/** 当前本地时刻是否在安静时段内（跨夜区间按两段判断）。 */
export function inQuietHours(value, now = Date.now()) {
  const range = parseQuietHours(value)
  if (range === null) return false
  const d = new Date(now)
  const current = d.getHours() * 60 + d.getMinutes()
  if (range.start === range.end) return false
  if (range.start < range.end) return current >= range.start && current < range.end
  return current >= range.start || current < range.end
}

/** 一次任务是否到期；返回 true 时由调用方决定 quiet/busy/能力。 */
export function isDue(task, now = Date.now()) {
  if (task === null || typeof task !== 'object' || task.enabled === false) return false
  if (task.kind === 'daily') {
    return String(task.time ?? '') === nowHHMM(now) && task.lastRun !== todayKey(now)
  }
  if (task.kind === 'once') {
    return Number.isFinite(task.at) && task.at <= now && task.lastRun === ''
  }
  return false
}

/** 任务是否已超过一次性宽限（不再补发）。 */
export function isExpired(task, now = Date.now()) {
  return task?.kind === 'once' && Number.isFinite(task.at) && now - task.at > ONCE_GRACE_MS
}

/**
 * 启动调度器。
 * @param {object} deps
 * @param {object} deps.store
 * @param {object} deps.bridge
 * @param {object} deps.config
 * @param {object} [deps.logger]
 * @param {() => number} [deps.clock]
 * @param {(task: object) => boolean} [deps.canSend] - 平台能力检查（默认 true）
 * @returns {() => void} stop
 */
export function startScheduler({ store, bridge, config, logger = null, clock = () => Date.now(), canSend = () => true }) {
  const settings = config.schedules ?? {}
  if (settings.enabled === false) return () => {}
  const tickMs = Number.isSafeInteger(settings.tickMs) ? settings.tickMs : DEFAULT_TICK_MS
  /** chatKey → 最近主动发送时间戳（仅本轮进程；用于粗限流） */
  const sentAt = new Map()
  let ticking = false
  let stopped = false

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

  async function fire(task, now) {
    const target = task.target
    if (target === null || target === undefined || typeof target !== 'object') {
      await store.scheduleMark(task.id, { lastError: '目标已失效（没有 lastTarget）' })
      return
    }
    if (bridge.isBusy?.(task.chatKey) === true) return
    if (task.social === true && store.modeFor(task.chatKey) !== 'chat') return
    if (typeof canSend === 'function' && canSend(task) !== true) {
      await store.scheduleMark(task.id, { lastError: '当前线路不支持主动消息' })
      return
    }
    const recent = sentAt.get(task.chatKey) ?? []
    const cutoff = now - 60 * 60 * 1000
    const kept = recent.filter(at => at > cutoff)
    const dailyCap = Number.isSafeInteger(settings.dailyLimitPerChat) ? settings.dailyLimitPerChat : 3
    const today = todayKey(now)
    const sentToday = kept.filter(at => todayKey(at) === today).length
    if (task.social === true && sentToday >= dailyCap) return

    const text = String(task.prompt ?? '').trim()
    if (text === '') {
      await store.scheduleMark(task.id, { lastError: 'prompt 为空' })
      return
    }
    const at = new Date(now)
    const stamp = `${today} ${nowHHMM(now)}`
    const ev = {
      chatKey: task.chatKey,
      transportKind: task.transportKind ?? '',
      accountId: task.accountId ?? '',
      target,
      sender: { id: 'dsh-qq-scheduler', name: '定时任务' },
      text: `[定时任务 ${stamp}] ${text}`,
      media: [],
      mentioned: true,
      messageId: '',
      timestamp: at,
      internal: true,
    }
    // daily 的 lastRun 只记日期（isDue 按日期去重）；once 记 occurrence 便于审计。
    const runKey = task.kind === 'daily' ? today : `${task.id}:${task.at}`
    // 乐观记账：宁可少发，不重复打扰
    await store.scheduleMark(task.id, { lastRun: runKey, lastError: '' })
    try {
      const result = await bridge.handleUserMessage(ev, { internal: true })
      if (result?.accepted !== true) {
        await store.scheduleMark(task.id, { lastError: result?.reason ?? '内部投递被拒绝' })
        return
      }
      kept.push(now)
      sentAt.set(task.chatKey, kept.slice(-50))
      log.info(`dsh-qq: 定时任务已触发 ${task.id}（${task.chatKey}）`)
    } catch (error) {
      await store.scheduleMark(task.id, { lastError: error instanceof Error ? error.message : String(error) })
    }
  }

  async function tick() {
    if (ticking || stopped) return
    ticking = true
    try {
      const now = clock()
      const quiet = inQuietHours(settings.quietHours, now)
      for (const task of store.schedules()) {
        if (!isDue(task, now)) continue
        if (task.kind === 'once' && isExpired(task, now)) {
          await store.scheduleMark(task.id, { lastRun: `expired:${now}`, lastError: '已过期，未发送' })
          continue
        }
        if (quiet) continue
        await fire(task, now)
      }
    } catch (error) {
      log.warn(`dsh-qq: 定时任务 tick 失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      ticking = false
    }
  }

  const timer = setInterval(() => { void tick() }, tickMs)
  timer.unref?.()
  void tick()
  log.info(`dsh-qq: 定时任务已启动（tick=${tickMs}ms，quiet=${settings.quietHours}）`)
  const stop = () => {
    stopped = true
    clearInterval(timer)
  }
  // 测试/诊断用：手动跑一次 tick，不依赖真实定时器。
  stop.tick = tick
  return stop
}

export default startScheduler
