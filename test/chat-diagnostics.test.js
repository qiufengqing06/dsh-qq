import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createChatDiagnostics } from '../lib/chat-diagnostics.js'
import { resolveConfig } from '../lib/config.js'
import { createStore } from '../lib/store.js'
import { createMockTransport } from '../lib/mock.js'
import { createResourceScope } from '../lib/scope.js'
import { createBridge } from '../lib/bridge.js'
import { createRouter } from '../lib/router.js'
import { createParticipation } from '../lib/participation.js'
import { createFakeAgents, createFakeCtx } from './helpers/fake-ctx.js'

async function setup(t, { freeReply = true, quietHours = '00:00-00:00', failSend = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-diagnostics-'))
  const clock = () => new Date(2026, 9, 26, 12).getTime()
  const config = resolveConfig({ transport: 'mock', autoConnect: false, dataDir: dir, pairingPolicy: 'open',
    freeReplyGroups: freeReply ? ['g1'] : [], participation: { enabled: true, mode: 'block', allowUnmentioned: true, quietHours } })
  const store = createStore({ dir })
  await store.load()
  const transport = createMockTransport({ failSend })
  const agents = createFakeAgents()
  const ctx = createFakeCtx({ services: { agents } })
  const scope = createResourceScope({ name: 'diagnostics-test' })
  const diagnostics = createChatDiagnostics({ clock })
  const participation = createParticipation({ config, store, clock, onDecision: diagnostics.decision })
  const bridge = createBridge({ ctx, config, store, transport, scope, diagnostics, clock,
    chatInputWindowMs: 0, sleep: async () => {}, random: () => 0,
    onReply: participation.observeReply })
  const control = { tryApprovalText: async () => null }
  const router = createRouter({ config, store, bridge, control, participation, diagnostics })
  const input = (text, extra = {}) => transport.inject({ target: { kind: 'group', groupId: 'g1' },
    sender: { id: 'member', name: '群友' }, text, mentioned: false, ...extra })
  const chatKey = input('').chatKey
  await store.setMode(chatKey, 'chat')
  t.after(async () => { await scope.dispose(); await rm(dir, { recursive: true, force: true }) })
  return { router, store, bridge, agents, transport, diagnostics, input, chatKey, clock }
}

async function waitFor(check) {
  for (let n = 0; n < 200; n++) {
    if (check()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.fail('诊断状态未完成')
}

test('真实路由诊断保留低分、安静时段和暂停原因，包括需要 @ 的群', async t => {
  for (const freeReply of [true, false]) for (const kind of ['score', 'quiet', 'paused']) {
    await t.test(`${freeReply ? '免@' : '需@'} ${kind}`, async t => {
      const env = await setup(t, { freeReply, quietHours: kind === 'quiet' ? '11:00-13:00' : '00:00-00:00' })
      if (kind === 'paused') await env.store.setChatPreference(env.chatKey, { proactiveUntil: env.clock() + 60_000 })
      const result = await env.router.routeInbound(env.input('DIAGNOSTIC_PRIVATE_BODY'))
      assert.equal(result.handled, 'ignored')
      const row = env.diagnostics.snapshot().recent.find(row => row.id === result.diagnosticId)
      assert.equal(row.status, 'ignored')
      assert.match(row.reason, kind === 'score' ? /主动接话条件/ : kind === 'quiet' ? /安静时段/ : /本群暂停/)
      assert.equal(env.agents.created.length, 0)
      assert.doesNotMatch(JSON.stringify(row), /DIAGNOSTIC_PRIVATE_BODY/)
    })
  }
})

test('真实路由→bridge→出站诊断区分成功、无输出、发送失败、停止且不存正文或凭据', async t => {
  for (const outcome of ['sent', 'empty', 'failed', 'cancelled']) await t.test(outcome, async t => {
    const env = await setup(t, { failSend: outcome === 'failed' })
    if (outcome === 'failed') {
      const originalSend = env.transport.sendText
      env.transport.sendText = async (...args) => {
        await originalSend(...args)
        return { ok: false, error: 'upstream request DIAGNOSTIC_PRIVATE_BODY sk-secret-token' }
      }
    }
    const result = await env.router.routeInbound(env.input('DIAGNOSTIC_PRIVATE_BODY sk-secret-token', { mentioned: true }))
    assert.equal(result.handled, 'message')
    const row = () => env.diagnostics.snapshot().recent.find(row => row.id === result.diagnosticId)
    assert.equal(row().status, 'generating', '异步 route 返回不能把已开始生成倒退为排队')
    const agent = env.agents.live.get(env.bridge.currentSession(env.chatKey))
    if (outcome === 'cancelled') await env.bridge.stop(env.chatKey)
    else {
      if (outcome !== 'empty') agent.reply('DIAGNOSTIC_PRIVATE_ANSWER')
      agent.ctx.emitStatus('idle')
    }
    const expected = outcome === 'empty' ? 'ignored' : outcome
    await waitFor(() => row().status === expected)
    if (outcome === 'empty') assert.match(row().reason, /未返回可发送内容/)
    if (outcome === 'failed') assert.match(row().reason, /发送失败/)
    if (outcome === 'sent') assert.equal(env.transport.lastText(), 'DIAGNOSTIC_PRIVATE_ANSWER')
    if (outcome === 'cancelled') assert.equal(env.transport.lastText(), null)
    assert.doesNotMatch(JSON.stringify(env.diagnostics.snapshot()), /DIAGNOSTIC_PRIVATE|sk-secret-token|mock: sendText disabled/)
  })
})

test('诊断记录有界、跨对话独立，快照不能反向修改内部记录', () => {
  let now = 1000
  const diagnostics = createChatDiagnostics({ clock: () => now, limit: 2 })
  const first = { chatKey: 'onebot:a:group:1', text: '不记录正文', token: '不记录凭据' }
  first.diagnosticId = diagnostics.begin(first)
  diagnostics.note(first, 'generating', '正在生成')
  now += 50
  const second = { chatKey: 'onebot:b:group:1' }
  second.diagnosticId = diagnostics.begin(second)
  diagnostics.note(second, 'sent', '文字已发送')
  diagnostics.cancel(first)
  let rows = diagnostics.snapshot().recent
  assert.equal(rows[0].status, 'cancelled')
  assert.equal(rows[0].durationMs, 50)
  assert.equal(rows[1].status, 'sent')
  assert.notEqual(rows[0].chatKey, rows[1].chatKey)
  rows[1].steps[0].reason = '被修改'
  assert.equal(diagnostics.snapshot().recent[1].steps[0].reason, '文字已发送')
  diagnostics.begin({ chatKey: 'onebot:a:group:2' })
  rows = diagnostics.snapshot().recent
  assert.equal(rows.length, 2)
  assert.equal(rows.some(row => row.id === first.diagnosticId), false)
  assert.doesNotMatch(JSON.stringify(rows), /不记录正文|不记录凭据|被修改/)
})
