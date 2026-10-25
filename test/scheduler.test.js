import assert from 'node:assert/strict'
import { test } from 'node:test'

import { inQuietHours, isDue, isExpired, parseQuietHours, startScheduler, todayKey, nowHHMM } from '../lib/scheduler.js'

/** 固定本地时间（避免真实时钟/时区飘）。 */
function at(hhmm, day = 25) {
  const [hour, minute] = hhmm.split(':').map(Number)
  return new Date(2026, 9, day, hour, minute, 0, 0).getTime()
}

function fakeEnv({ tasks = [], mode = 'chat', busy = false, now = at('08:00') } = {}) {
  const sent = []
  const marked = []
  const state = { now }
  const env = {
    sent,
    marked,
    state,
    store: {
      schedules: () => tasks.map(task => ({ ...task })),
      scheduleMark: async (id, patch) => {
        marked.push({ id, ...patch })
        const task = tasks.find(item => item.id === id)
        if (task !== undefined) Object.assign(task, patch)
        return true
      },
      modeFor: () => mode,
      chatPreference: () => ({ proactiveUntil: 0, stickers: true }),
    },
    bridge: {
      isBusy: () => busy,
      handleUserMessage: async ev => {
        sent.push(ev)
        return { accepted: true }
      },
    },
  }
  return env
}

test('安静时段：普通区间与跨夜区间', () => {
  assert.deepEqual(parseQuietHours('23:00-08:00'), { start: 23 * 60, end: 8 * 60 })
  assert.equal(inQuietHours('23:00-08:00', at('23:30')), true)
  assert.equal(inQuietHours('23:00-08:00', at('07:30')), true)
  assert.equal(inQuietHours('23:00-08:00', at('08:00')), false)
  assert.equal(inQuietHours('23:00-08:00', at('12:00')), false)
  assert.equal(inQuietHours('09:00-18:00', at('12:00')), true)
  assert.equal(inQuietHours('09:00-18:00', at('08:59')), false)
})

test('到期判断：daily 每天一次、once 过期不补', () => {
  const now = at('09:00')
  assert.equal(nowHHMM(now), '09:00')
  assert.equal(todayKey(now), '2026-10-25')
  assert.equal(isDue({ kind: 'daily', time: '09:00', lastRun: '' }, now), true)
  assert.equal(isDue({ kind: 'daily', time: '09:00', lastRun: '2026-10-25' }, now), false)
  assert.equal(isDue({ kind: 'once', at: now - 1000, lastRun: '' }, now), true)
  assert.equal(isDue({ kind: 'once', at: now + 1000, lastRun: '' }, now), false)
  assert.equal(isExpired({ kind: 'once', at: now - 11 * 60 * 1000 }, now), true)
})

test('scheduler：daily 到点触发一次，重复 tick 不重发', async () => {
  const task = {
    id: 't1', chatKey: 'qqbot:1:group:2', transportKind: 'qqbot', accountId: '1',
    target: { kind: 'group', groupId: '2' }, prompt: '早安', kind: 'daily', time: '09:00',
    at: null, enabled: true, social: false, lastRun: '', lastError: '',
  }
  const env = fakeEnv({ tasks: [task], now: at('08:00') })
  const stop = startScheduler({
    store: env.store, bridge: env.bridge,
    config: { schedules: { enabled: true, tickMs: 1000, quietHours: '23:00-08:00', dailyLimitPerChat: 3 } },
    clock: () => env.state.now,
  })
  env.state.now = at('09:00')
  await stop.tick()
  assert.equal(env.sent.length, 1)
  assert.equal(task.lastRun, '2026-10-25')
  assert.match(env.sent[0].text, /^\[定时任务 2026-10-25 09:00\] 早安/)
  assert.deepEqual(env.sent[0].target, { kind: 'group', groupId: '2' })
  await stop.tick()
  assert.equal(env.sent.length, 1, '同一天不重复')
  stop()
})

test('scheduler：安静时段/work 社交/忙时都不发', async () => {
  const task = {
    id: 't2', chatKey: 'qqbot:1:group:2', transportKind: 'qqbot', accountId: '1',
    target: { kind: 'group', groupId: '2' }, prompt: '聊一句', kind: 'daily', time: '23:30',
    at: null, enabled: true, social: true, lastRun: '', lastError: '',
  }
  const quietEnv = fakeEnv({ tasks: [task], now: at('23:30') })
  const quietStop = startScheduler({
    store: quietEnv.store, bridge: quietEnv.bridge,
    config: { schedules: { enabled: true, tickMs: 1000, quietHours: '23:00-08:00' } },
    clock: () => quietEnv.state.now,
  })
  await quietStop.tick()
  assert.equal(quietEnv.sent.length, 0, '安静时段不发')
  quietStop()

  const workEnv = fakeEnv({ tasks: [task], mode: 'work', now: at('12:00') })
  task.time = '12:00'
  task.lastRun = ''
  const workStop = startScheduler({
    store: workEnv.store, bridge: workEnv.bridge,
    config: { schedules: { enabled: true, tickMs: 1000, quietHours: '23:00-08:00' } },
    clock: () => workEnv.state.now,
  })
  await workStop.tick()
  assert.equal(workEnv.sent.length, 0, 'work 模式社交主动不发')
  workStop()

  const busyEnv = fakeEnv({ tasks: [task], busy: true, now: at('12:00') })
  const busyStop = startScheduler({
    store: busyEnv.store, bridge: busyEnv.bridge,
    config: { schedules: { enabled: true, tickMs: 1000, quietHours: '23:00-08:00' } },
    clock: () => busyEnv.state.now,
  })
  await busyStop.tick()
  assert.equal(busyEnv.sent.length, 0, '忙时跳过')
  busyStop()
})

test('scheduler：对话主动暂停时不发社交消息', async () => {
  const task = {
    id: 't3', chatKey: 'qqbot:1:group:2', transportKind: 'qqbot', accountId: '1',
    target: { kind: 'group', groupId: '2' }, prompt: '早安', kind: 'daily', time: '09:00',
    at: null, enabled: true, social: true, lastRun: '', lastError: '',
  }
  const env = fakeEnv({ tasks: [task], now: at('09:00') })
  env.store.chatPreference = () => ({ proactiveUntil: at('10:00'), stickers: true })
  const stop = startScheduler({
    store: env.store, bridge: env.bridge,
    config: { schedules: { enabled: true, tickMs: 1000, quietHours: '23:00-08:00' } },
    clock: () => env.state.now,
  })
  await stop.tick()
  assert.equal(env.sent.length, 0)
  stop()
})
