import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createParticipation, scoreMessage } from '../lib/participation.js'

function at(hhmm) {
  const [h, m] = hhmm.split(':').map(Number)
  return new Date(2026, 9, 25, h, m).getTime()
}

function env({ mode = 'chat', participation = {}, now = at('12:00') } = {}) {
  const state = { now }
  const store = {
    modeFor: () => mode,
    chatPreference: () => ({ proactiveUntil: 0, stickers: true }),
    memberPreference: () => ({ name: '', proactiveUntil: 0 }),
  }
  const p = createParticipation({
    config: { participation: { enabled: true, mode: 'block', threshold: 0.55, quietHours: '23:00-08:00', cooldownMs: 120000, dailyWakeLimit: 3, ...participation } },
    store,
    clock: () => state.now,
  })
  return { p, state }
}

const ev = (text, extra = {}) => ({
  chatKey: 'qqbot:1:group:2',
  target: { kind: 'group', groupId: '2' },
  text,
  sender: { id: 'u1', name: 'U' },
  ...extra,
})

test('scoreMessage：问句+长度；@别人/引用别人扣分；仅引用自己加分', () => {
  const q = scoreMessage(ev('这个报错怎么修呀'))
  assert.ok(q.score >= 0.55)
  assert.ok(q.reasons.includes('question'))
  const short = scoreMessage(ev('在吗'))
  assert.ok(short.score < 0.55)
  const atOthers = scoreMessage(ev('这个报错怎么修呀', { atOthers: ['u2'] }))
  assert.ok(atOthers.score < q.score)
  const reply = scoreMessage(ev('这个怎么修', { accountId: 'self', replyTo: { messageId: 'm1', sender: { id: 'self' } } }))
  assert.ok(reply.score > 0.55)
  assert.ok(scoreMessage(ev('这个怎么修', { accountId: 'self', replyTo: { messageId: 'm2', sender: { id: 'other' } } })).score < 0.55)
  assert.ok(scoreMessage(ev('这个怎么修', { replyTo: { messageId: 'unknown' } })).score < 0.55)
})

test('block：高分唤醒、低分/安静/work/冷却/日上限不唤醒', () => {
  const env1 = env()
  assert.equal(env1.p.shouldWake(ev('这个报错怎么修呀')), true)
  assert.equal(env1.p.shouldWake(ev('这个报错怎么修呀')), false, '冷却')

  const quiet = env({ now: at('23:30') })
  assert.equal(quiet.p.shouldWake(ev('这个报错怎么修呀')), false)

  const work = env({ mode: 'work' })
  assert.equal(work.p.shouldWake(ev('这个报错怎么修呀')), false)

  const low = env()
  assert.equal(low.p.shouldWake(ev('在吗')), false)

  const daily = env({ participation: { dailyWakeLimit: 1 } })
  assert.equal(daily.p.shouldWake(ev('这个报错怎么修呀')), true)
  daily.state.now += 200000
  assert.equal(daily.p.shouldWake(ev('这个报错怎么修呀')), false, '日上限')
})

test('log：只记录，永不唤醒', () => {
  const env1 = env({ participation: { mode: 'log' } })
  assert.equal(env1.p.shouldWake(ev('这个报错怎么修呀')), false)
  assert.equal(env1.p.evaluate(ev('这个报错怎么修呀')).skipped, 'log')
  const snap = env1.p.snapshot()
  assert.equal(snap.mode, 'log')
  assert.equal(snap.recent.length, 2)
  assert.equal(snap.recent[0].skipped, 'log')
})

test('明确静默：对话暂停/成员暂停时不唤醒', () => {
  const env1 = env()
  const now = env1.state.now
  env1.p.store = undefined
  const paused = {
    modeFor: () => 'chat',
    chatPreference: () => ({ proactiveUntil: now + 60000, stickers: true }),
    memberPreference: () => ({ name: '', proactiveUntil: 0 }),
  }
  const p1 = createParticipation({
    config: { participation: { enabled: true, mode: 'block', threshold: 0.55, quietHours: '23:00-08:00' } },
    store: paused,
    clock: () => now,
  })
  p1.observeReply({ chatKey: ev('').chatKey, senderId: 'u1', messageId: 'ours' })
  assert.equal(p1.shouldWake(ev('这个报错怎么修呀')), false)

  const memberPaused = {
    modeFor: () => 'chat',
    chatPreference: () => ({ proactiveUntil: 0, stickers: true }),
    memberPreference: () => ({ name: '', proactiveUntil: now + 60000 }),
  }
  const p2 = createParticipation({
    config: { participation: { enabled: true, mode: 'block', threshold: 0.55, quietHours: '23:00-08:00' } },
    store: memberPaused,
    clock: () => now,
  })
  p2.observeReply({ chatKey: ev('').chatKey, senderId: 'u1', messageId: 'ours' })
  assert.equal(p2.shouldWake(ev('这个报错怎么修呀')), false)
})

test('成功回复开启有限参与者续聊，引用其他群友不会抢话', () => {
  const { p, state } = env({ participation: { dailyWakeLimit: 0 } })
  const chatKey = ev('').chatKey
  assert.equal(p.evaluate(ev('这个报错怎么修呀')).wake, true)
  p.observeReply({ chatKey, senderId: 'u1', messageId: 'ours-1' })
  state.now += 5000
  assert.equal(p.evaluate(ev('确实，我也这么想', { replyTo: { messageId: 'ours-1' } })).wake, true, '发送回执识别自身引用，绕过旁观冷却')
  assert.equal(p.evaluate(ev('这个报错怎么修呀', { replyTo: { messageId: 'theirs', sender: { id: 'u2' } } })).skipped, 'addressed-other')
  assert.equal(p.evaluate(ev('这个报错怎么修呀', { atOthers: ['u2'] })).skipped, 'addressed-other')
  assert.equal(p.evaluate(ev('确实，我也这么想', { sender: { id: 'u2' } })).wake, false, '旁人没有因同群窗口被自动唤醒')
  assert.equal(p.evaluate(ev('这就是我刚才说的')).wake, true, '参与者短消息可续聊')
  assert.equal(p.evaluate(ev('继续聊这个')).skipped, 'continuation-limit', '包括初次插话在内最多连续自主唤醒三次')
  p.observeReply({ chatKey, senderId: 'u1', messageId: 'ours-explicit', explicit: true })
  assert.equal(p.evaluate(ev('那我接着说了')).wake, true, '新的明确召唤可重新开始')
})

test('续聊按完整chatKey隔离，窗口过期/结束语/人数上限生效', () => {
  const { p, state } = env({ participation: { dailyWakeLimit: 0, cooldownMs: 0 } })
  const chatKey = ev('').chatKey
  p.onReply({ chatKey, senderId: 'u1', messageId: 'ours' })
  assert.equal(p.evaluate(ev('确实如此', { chatKey: 'mock:1:group:2' })).wake, false)
  assert.equal(p.evaluate(ev('确实如此', { chatKey: 'qqbot:other:group:2' })).wake, false)
  assert.equal(p.evaluate(ev('谢谢')).skipped, 'conversation-ended')
  assert.equal(p.evaluate(ev('确实如此')).wake, false, '结束语关闭该参与者续聊')
  p.onReply({ chatKey, senderId: 'u1', messageId: 'ours-2' })
  state.now += 60001
  assert.equal(p.evaluate(ev('确实如此')).wake, false, '过期后短句不再自动续聊')
  for (let i = 1; i <= 5; i++) p.observeReply({ chatKey, senderId: `u${i}`, messageId: `reply-${i}` })
  assert.equal(p.evaluate(ev('确实如此')).wake, false, '仅保留最近四名参与者')
  assert.equal(p.evaluate(ev('确实如此', { sender: { id: 'u5' } })).wake, true)
})

test('续聊仍受日预算/静默约束，log不消耗续聊额度', () => {
  const daily = env({ participation: { dailyWakeLimit: 1 } })
  daily.p.observeReply({ chatKey: ev('').chatKey, senderId: 'u1', messageId: 'ours' })
  assert.equal(daily.p.evaluate(ev('确实如此')).wake, true)
  assert.equal(daily.p.evaluate(ev('那我接着说')).skipped, 'daily-limit')
  const log = env({ participation: { mode: 'log' } })
  log.p.observeReply({ chatKey: ev('').chatKey, senderId: 'u1', messageId: 'ours' })
  for (let i = 0; i < 5; i++) assert.equal(log.p.evaluate(ev('确实如此')).skipped, 'log')
  log.p.evaluate(ev('谢谢'))
  assert.deepEqual(log.p.evaluate(ev('确实如此')).reasons, ['continuation'], 'log不得改变原免@对话的窗口')
})

test('群友只按真实ID与对话关系处理，同名角色不触发身份特判', () => {
  const { p } = env({ participation: { dailyWakeLimit: 0 } })
  p.observeReply({ chatKey: ev('').chatKey, senderId: 'other-fish', messageId: 'ours' })
  assert.equal(p.evaluate(ev('你先别给自己找这个长期项目', { sender: { id: 'other-fish', name: '大肥鱼' } })).wake, true)
  assert.equal(p.evaluate(ev('你先别给自己找这个长期项目', { sender: { id: 'unrelated', name: '大肥鱼' } })).wake, false)
})
