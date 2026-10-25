import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createParticipation, scoreMessage } from '../lib/participation.js'

function at(hhmm) {
  const [h, m] = hhmm.split(':').map(Number)
  return new Date(2026, 9, 25, h, m).getTime()
}

function env({ mode = 'chat', participation = {}, now = at('12:00') } = {}) {
  const state = { now }
  const store = { modeFor: () => mode }
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

test('scoreMessage：问句+长度；@别人扣分；回复加分', () => {
  const q = scoreMessage(ev('这个报错怎么修呀'))
  assert.ok(q.score >= 0.55)
  assert.ok(q.reasons.includes('question'))
  const short = scoreMessage(ev('在吗'))
  assert.ok(short.score < 0.55)
  const atOthers = scoreMessage(ev('这个报错怎么修呀', { atOthers: ['u2'] }))
  assert.ok(atOthers.score < q.score)
  const reply = scoreMessage(ev('这个怎么修', { replyTo: { messageId: 'm1' } }))
  assert.ok(reply.score > 0.55)
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
})
