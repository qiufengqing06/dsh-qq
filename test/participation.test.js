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
  assert.equal(p.evaluate(ev('继续聊这个')).wake, true, '正常接话不消耗自主插话的三次上限')
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
  state.now += 120001
  assert.equal(p.evaluate(ev('确实如此')).wake, false, '过期后短句不再自动续聊')
  for (let i = 1; i <= 5; i++) p.observeReply({ chatKey, senderId: `u${i}`, messageId: `reply-${i}` })
  assert.equal(p.evaluate(ev('确实如此')).wake, false, '仅保留最近四名参与者')
  assert.equal(p.evaluate(ev('确实如此', { sender: { id: 'u5' } })).wake, true)
})

test('续聊不消耗主动日预算，log不消耗额度或关闭窗口', () => {
  const daily = env({ participation: { dailyWakeLimit: 1 } })
  daily.p.observeReply({ chatKey: ev('').chatKey, senderId: 'u1', messageId: 'ours' })
  assert.equal(daily.p.evaluate(ev('确实如此')).wake, true)
  assert.equal(daily.p.evaluate(ev('那我接着说')).wake, true)
  assert.equal(daily.p.evaluate(ev('这个报错怎么修呀', { sender: { id: 'u2' } })).wake, true, '续聊未消耗主动插话额度')
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


test('自然互动超过三轮且主动日预算耗尽，成功回执仍可维持续聊', () => {
  const { p, state } = env({ participation: { dailyWakeLimit: 1 } })
  const chatKey = ev('').chatKey
  assert.equal(p.evaluate(ev('这个报错怎么修呀')).wake, true, '先消耗唯一一次主动唤醒额度')
  p.observeReply({ chatKey, senderId: 'u1', messageId: 'ours-start' })
  const lines = ['没钱还吃饭', '不是，又冷暴力我', '出列，说话，蓝色大肥鱼']
  for (let i = 0; i < 12; i++) {
    state.now += 90_000
    const decision = p.evaluate(ev(lines[i % lines.length]))
    assert.equal(decision.wake, true, `第 ${i + 1} 次正常接话不应被当作主动插话`)
    assert.deepEqual(decision.reasons, ['continuation'])
    p.observeReply({ chatKey, senderId: 'u1', messageId: `ours-${i}` })
  }
  assert.equal(p.evaluate(ev('这个报错怎么修呀', { sender: { id: 'u2' } })).skipped, 'daily-limit', '续聊没有清空已用完的主动日额度')
  const quoted = p.evaluate(ev('我也想接这个梗', { sender: { id: 'u2' }, replyTo: { messageId: 'ours-11' } }))
  assert.equal(quoted.wake, true, '明确引用本实例属于接话，即使主动日预算已经耗尽')
  assert.deepEqual(quoted.reasons, ['reply-self'])
  state.now += 120_001
  assert.equal(p.evaluate(ev('这个报错怎么修呀')).skipped, 'daily-limit', '两分钟未成功回复后回到主动唤醒规则')
})

test('三次上限只限制自主加入新话题，非显式续聊回执不会把它清零', () => {
  const { p } = env({ participation: { cooldownMs: 0, dailyWakeLimit: 0 } })
  const chatKey = ev('').chatKey
  for (let i = 0; i < 3; i++) assert.equal(p.evaluate(ev('这个报错怎么修呀')).wake, true)
  assert.equal(p.evaluate(ev('这个报错怎么修呀')).skipped, 'continuation-limit')
  p.observeReply({ chatKey, senderId: 'u1', messageId: 'ours-start' })
  for (let i = 0; i < 8; i++) {
    assert.equal(p.evaluate(ev('没钱还吃饭')).wake, true)
    p.observeReply({ chatKey, senderId: 'u1', messageId: `ours-${i}`, explicit: false })
    assert.equal(p.evaluate(ev('这个报错怎么修呀', { sender: { id: 'newcomer' } })).skipped, 'continuation-limit')
  }
  p.observeReply({ chatKey, senderId: 'u1', messageId: 'ours-explicit', explicit: true })
  assert.equal(p.evaluate(ev('这个报错怎么修呀', { sender: { id: 'newcomer' } })).wake, true, '新的明确召唤保留原有重置语义')
})

test('两分钟续聊窗口仅由新的成功回执刷新，入站和重复回执不会续命', () => {
  const { p, state } = env({ participation: { dailyWakeLimit: 0, cooldownMs: 0 } })
  const chatKey = ev('').chatKey
  p.observeReply({ chatKey, senderId: 'u1', messageId: 'ours' })
  state.now += 90_000
  assert.equal(p.evaluate(ev('还接着刚才说')).wake, true, '允许阅读打字间隔超过原来的一分钟')
  assert.equal(p.evaluate(ev('路过', { sender: { id: 'u2' } })).wake, false)
  p.observeReply({ chatKey, senderId: 'u1', messageId: 'ours' })
  state.now += 30_001
  assert.equal(p.evaluate(ev('没钱还吃饭')).wake, false, '未发生新的成功出站，过期后不再自动接短句')
  p.observeReply({ chatKey, senderId: 'u1', messageId: 'ours-new' })
  assert.equal(p.evaluate(ev('没钱还吃饭')).wake, true)
})

test('接话不延长主动冷却，活跃参与者仍遵守安静时段和聊天对象边界', () => {
  const { p, state } = env({ participation: { dailyWakeLimit: 0 } })
  const chatKey = ev('').chatKey
  assert.equal(p.evaluate(ev('这个报错怎么修呀')).wake, true)
  p.observeReply({ chatKey, senderId: 'u1', messageId: 'ours' })
  state.now += 119_999
  assert.equal(p.evaluate(ev('没钱还吃饭')).wake, true)
  p.observeReply({ chatKey, senderId: 'u1', messageId: 'ours-new' })
  assert.equal(p.evaluate(ev('这个报错怎么修呀', { sender: { id: 'u2' } })).skipped, 'cooldown')
  state.now += 1
  assert.equal(p.evaluate(ev('这个报错怎么修呀', { sender: { id: 'u2' } })).wake, true, '冷却仍从上次主动插话计算')
  assert.equal(p.evaluate(ev('没钱还吃饭', { atOthers: ['u2'] })).skipped, 'addressed-other')
  assert.equal(p.evaluate(ev('没钱还吃饭', { replyTo: { messageId: 'theirs', sender: { id: 'u2' } } })).skipped, 'addressed-other')
  assert.equal(p.evaluate(ev('先别说了')).skipped, 'conversation-ended')
  assert.equal(p.evaluate(ev('没钱还吃饭')).wake, false)

  const quiet = env({ now: at('22:59') })
  quiet.p.observeReply({ chatKey, senderId: 'u1', messageId: 'ours' })
  quiet.state.now += 60_000
  assert.equal(quiet.p.evaluate(ev('没钱还吃饭')).skipped, 'quiet', '窗口仍有效也不绕过安静时段')
})
