/**
 * 掉线提醒验收：防抖、节流、恢复通知、跨线通知、两条都挂时的排队补发。
 *
 * 全部用假 transport + 可控时钟，不碰真实网络与宿主。
 * 注意时序：告警管理器用「第一次观察到掉线的时间」作为起点，所以用例都要先 evaluate 一次
 * （生产里插件启动时就会跑首轮），再推进时钟到阈值之后。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolveConfig } from '../lib/config.js'
import { createAlertManager } from '../lib/alerts.js'
import { createLogger } from './helpers/fake-ctx.js'

/** 假线路：status 可改，sendText 记录。 */
function fakeLine(kind, status = { connected: true, phase: 'connected' }) {
  const sent = []
  const line = {
    kind,
    sent,
    state: { ...status },
    transport: {
      status: () => ({ ...line.state, kind }),
      sendText: async (target, text) => {
        sent.push({ target, text })
        return { ok: true }
      },
    },
    set(next) {
      line.state = { ...line.state, ...next }
    },
  }
  return line
}

function makeRegistry(lines) {
  return {
    entries: lines.map(line => ({ kind: line.kind, transport: line.transport })),
    forKind: kind => lines.find(line => line.kind === kind) ?? null,
  }
}

function makeStore(homes = {}) {
  return { homeChannel: kind => homes[kind] ?? '' }
}

const logger = createLogger()

test('掉线未超过阈值：页面告警可见，但不发通知、不记事件', async () => {
  const qq = fakeLine('qqbot', { connected: false, phase: 'disconnected' })
  const ob = fakeLine('onebot')
  let now = 1_000_000
  const alerts = createAlertManager({
    config: resolveConfig({ alerts: { downAfterMs: 60_000 } }),
    store: makeStore({ onebot: '20002' }),
    transports: makeRegistry([qq, ob]),
    clock: () => now,
    logger,
  })
  await alerts.evaluate()
  now += 30_000
  const state = await alerts.evaluate()
  assert.equal(state.active.length, 1, '页面告警条应立刻看到掉线')
  assert.equal(state.active[0].kind, 'qqbot')
  assert.equal(state.events.length, 0, '未超过阈值不提醒')
  assert.equal(ob.sent.length, 0)
})

test('超过阈值：用另一条活着的线路私聊主人发一次通知，不重复', async () => {
  const qq = fakeLine('qqbot', { connected: false, phase: 'disconnected', lastError: '握手超时' })
  const ob = fakeLine('onebot')
  let now = 1_000_000
  const alerts = createAlertManager({
    config: resolveConfig({}),
    store: makeStore({ qqbot: 'openid-owner', onebot: '20002' }),
    transports: makeRegistry([qq, ob]),
    pageUrl: () => 'http://127.0.0.1:3080/dsh-qq',
    clock: () => now,
    logger,
  })
  await alerts.evaluate()
  now += 61_000
  await alerts.evaluate()
  assert.equal(ob.sent.length, 1, '掉线通知走个人线（唯一在线的线路）')
  assert.equal(qq.sent.length, 0, '掉线的那条线路发不出去，不能依赖它')
  assert.match(ob.sent[0].text, /官方线掉线/)
  assert.match(ob.sent[0].text, /握手超时/)
  assert.match(ob.sent[0].text, /http:\/\/127\.0\.0\.1:3080\/dsh-qq/)
  assert.deepEqual(ob.sent[0].target, { kind: 'dm', userId: '20002' })

  now += 10_000
  await alerts.evaluate()
  assert.equal(ob.sent.length, 1, '同一段掉线只提醒一次')
})

test('恢复：发一次恢复通知，之后重复评估不再发', async () => {
  const qq = fakeLine('qqbot', { connected: false, phase: 'disconnected' })
  const ob = fakeLine('onebot')
  let now = 1_000_000
  const alerts = createAlertManager({
    config: resolveConfig({}),
    store: makeStore({ onebot: '20002' }),
    transports: makeRegistry([qq, ob]),
    clock: () => now,
    logger,
  })
  await alerts.evaluate()
  now += 61_000
  await alerts.evaluate()
  qq.set({ connected: true, phase: 'connected' })
  now += 10_000
  const state = await alerts.evaluate()
  assert.equal(state.active.length, 0)
  assert.equal(ob.sent.length, 2, '掉线 + 恢复各一条')
  assert.match(ob.sent[1].text, /官方线已恢复/)
  now += 10_000
  await alerts.evaluate()
  assert.equal(ob.sent.length, 2, '恢复通知只发一次')
})

test('两条都挂：通知排队，任意一条恢复后补发', async () => {
  const qq = fakeLine('qqbot', { connected: false, phase: 'disconnected' })
  const ob = fakeLine('onebot', { connected: false, phase: 'disconnected' })
  let now = 1_000_000
  const alerts = createAlertManager({
    config: resolveConfig({}),
    store: makeStore({ qqbot: 'openid-owner', onebot: '20002' }),
    transports: makeRegistry([qq, ob]),
    clock: () => now,
    logger,
  })
  await alerts.evaluate()
  now += 61_000
  const state = await alerts.evaluate()
  assert.equal(state.active.length, 2)
  assert.ok(state.pending >= 1, '没有可用线路时排队')
  const pendingBefore = state.pending

  qq.set({ connected: true, phase: 'connected' })
  now += 10_000
  await alerts.evaluate()
  assert.ok(qq.sent.length >= 1, '恢复的线路补发排队通知')
  const flushed = qq.sent.find(entry => /（补发）/.test(entry.text))
  assert.ok(flushed !== undefined, '补发文本要能看出来是补发')
  assert.ok(pendingBefore >= 1)
})

test('notify=false：只页面提醒，不发 QQ 消息，但事件仍记录', async () => {
  const qq = fakeLine('qqbot', { connected: false, phase: 'disconnected' })
  const ob = fakeLine('onebot')
  let now = 1_000_000
  const alerts = createAlertManager({
    config: resolveConfig({ alerts: { notify: false } }),
    store: makeStore({ onebot: '20002' }),
    transports: makeRegistry([qq, ob]),
    clock: () => now,
    logger,
  })
  await alerts.evaluate()
  now += 61_000
  const state = await alerts.evaluate()
  assert.equal(ob.sent.length, 0)
  assert.equal(state.events.length, 1)
  assert.equal(state.notify, false)
})

test('enabled=false：完全不评估（空快照）', async () => {
  const qq = fakeLine('qqbot', { connected: false, phase: 'disconnected' })
  const ob = fakeLine('onebot')
  let now = 1_000_000
  const alerts = createAlertManager({
    config: resolveConfig({ alerts: { enabled: false } }),
    store: makeStore({ onebot: '20002' }),
    transports: makeRegistry([qq, ob]),
    clock: () => now,
    logger,
  })
  await alerts.evaluate()
  now += 61_000
  const state = await alerts.evaluate()
  assert.equal(state.active.length, 0)
  assert.equal(state.events.length, 0)
  assert.equal(ob.sent.length, 0)
})

test('no-credentials 不算掉线（配置问题，页面已有提示）', async () => {
  const qq = fakeLine('qqbot', { connected: false, phase: 'no-credentials' })
  let now = 1_000_000
  const alerts = createAlertManager({
    config: resolveConfig({}),
    store: makeStore({}),
    transports: makeRegistry([qq]),
    clock: () => now,
    logger,
  })
  await alerts.evaluate()
  now += 120_000
  const state = await alerts.evaluate()
  assert.equal(state.active.length, 0)
  assert.equal(state.events.length, 0)
})

test('冷却期：恢复后又掉线，冷却内不重复通知', async () => {
  const qq = fakeLine('qqbot', { connected: false, phase: 'disconnected' })
  const ob = fakeLine('onebot')
  let now = 1_000_000
  const alerts = createAlertManager({
    config: resolveConfig({ alerts: { cooldownMs: 600_000 } }),
    store: makeStore({ onebot: '20002' }),
    transports: makeRegistry([qq, ob]),
    clock: () => now,
    logger,
  })
  await alerts.evaluate()
  now += 61_000
  await alerts.evaluate() // 第一次掉线通知
  qq.set({ connected: true })
  now += 10_000
  await alerts.evaluate() // 恢复通知
  qq.set({ connected: false, phase: 'disconnected' })
  now += 10_000
  await alerts.evaluate() // 记录新的掉线起点
  now += 61_000
  await alerts.evaluate() // 持续超过阈值，但仍在冷却期
  const downs = ob.sent.filter(entry => /掉线/.test(entry.text))
  assert.equal(downs.length, 1, '冷却期内不再发掉线通知')
  assert.equal(ob.sent.length, 2, '恢复通知不受冷却影响')
})

test('主人私聊未配置：不发通知，但事件仍记录（页面可看）', async () => {
  const qq = fakeLine('qqbot', { connected: false, phase: 'disconnected' })
  const ob = fakeLine('onebot')
  let now = 1_000_000
  const alerts = createAlertManager({
    config: resolveConfig({}),
    store: makeStore({}),
    transports: makeRegistry([qq, ob]),
    clock: () => now,
    logger,
  })
  await alerts.evaluate()
  now += 61_000
  const state = await alerts.evaluate()
  assert.equal(ob.sent.length, 0)
  assert.equal(state.events.length, 1)
  assert.match(state.events[0].text, /排队/)
})
