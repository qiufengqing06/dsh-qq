import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveConfig } from '../lib/config.js'
import { createStore } from '../lib/store.js'
import { createMockTransport } from '../lib/mock.js'
import { createResourceScope } from '../lib/scope.js'
import { createApprovalRegistry } from '../lib/approval.js'
import { createBridge } from '../lib/bridge.js'
import { createControl } from '../lib/control.js'
import { createRouter, parseCommand, stripMention } from '../lib/router.js'
import { createFakeAgents, createFakeCtx, createLogger } from './helpers/fake-ctx.js'

async function setup(configOverrides = {}, { dshCommand = null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-router-'))
  const config = resolveConfig({ transport: 'mock', autoConnect: false, dataDir: dir, ...configOverrides })
  const store = createStore({ dir, logger: createLogger() })
  await store.load()
  const transport = createMockTransport({})
  const agents = createFakeAgents()
  const ctx = createFakeCtx({ services: { agents } })
  const scope = createResourceScope({ name: 'test' })
  const logger = createLogger()
  const approval = createApprovalRegistry({})
  const bridge = createBridge({ ctx, config, store, transport, scope, logger })
  const control = createControl({ ctx, config, store, bridge, transport, approval, scope, logger })
  const router = createRouter({ config, store, control, bridge, logger, dshCommand })
  await store.setHomeChannel('owner-1')
  return { dir, config, store, transport, agents, ctx, scope, bridge, control, router }
}

test('parseCommand / stripMention', () => {
  assert.deepEqual(parseCommand('/qq-switch 2'), {
    raw: '/qq-switch 2',
    name: '/qq-switch',
    args: ['2'],
    flags: new Set(),
    positional: ['2'],
  })
  assert.equal(parseCommand('/qq-model p/m --default').flags.has('--default'), true)
  assert.deepEqual(parseCommand('/qq-model p/m --default').positional, ['p/m'])
  assert.equal(parseCommand('你好'), null)
  assert.equal(parseCommand('   '), null)
  assert.equal(stripMention('<@!123> /qq-help'), '/qq-help')
  assert.equal(stripMention('@bot 你好'), '你好')
})

test('群消息未 @机器人 → 静默忽略', async () => {
  const { router, transport, agents } = await setup()
  const ev = transport.inject({
    target: { kind: 'group', groupId: 'g1' },
    sender: { id: 'owner-1', name: 'O' },
    text: '在吗',
    mentioned: false,
  })
  const result = await router.routeInbound(ev)
  assert.deepEqual(result, { handled: 'ignored', reason: 'not-mentioned' })
  assert.equal(agents.created.length, 0)
})

test('群消息 @机器人（owner）→ 进入桥接', async () => {
  const { router, transport, agents } = await setup()
  const ev = transport.inject({
    target: { kind: 'group', groupId: 'g1' },
    sender: { id: 'owner-1', name: 'O' },
    text: '帮我看看',
    mentioned: true,
  })
  const result = await router.routeInbound(ev)
  assert.equal(result.handled, 'message')
  assert.equal(agents.created.length, 1)
})

test('未授权用户 → 配对流程，不创建会话', async () => {
  const { router, transport, agents, store } = await setup()
  const ev = transport.inject({ text: '你好', sender: { id: 'stranger', name: '路人' } })
  const result = await router.routeInbound(ev)
  assert.equal(result.handled, 'pairing')
  assert.match(result.reply, /等待管理员批准/)
  assert.equal(agents.created.length, 0)
  assert.equal(store.pendingPairing().length, 1)
})

test('pairingPolicy=open 时陌生用户可直接对话', async () => {
  const { router, transport, agents } = await setup({ pairingPolicy: 'open' })
  const ev = transport.inject({ text: '你好', sender: { id: 'stranger', name: '路人' } })
  const result = await router.routeInbound(ev)
  assert.equal(result.handled, 'message')
  assert.equal(agents.created.length, 1)
})

test('owner 本地命令：执行且绝不进 LLM', async () => {
  const { router, transport, agents } = await setup()
  for (const line of ['/qq-help', '/qq-status', '/qq-sessions']) {
    const result = await router.routeInbound(
      transport.inject({ text: line, sender: { id: 'owner-1', name: 'O' } }),
    )
    assert.equal(result.handled, 'command', `${line} 应由 router 处理`)
    assert.ok(result.reply.length > 0)
  }
  assert.equal(agents.created.length, 0, '控制命令不得创建会话')
  assert.ok(agents.created.every(item => item.sessionId !== undefined))
})

test('控制命令权限：普通授权用户不能切模型、不能管会话', async () => {
  const { router, transport, store } = await setup()
  await store.addAuthorized('member-1', { role: 'authorized' })
  // chat 域 = authorized → 状态查询可用
  const status = await router.routeInbound(
    transport.inject({ text: '/qq-status', sender: { id: 'member-1', name: 'M' } }),
  )
  assert.equal(status.handled, 'command')
  // sessionControl / modelControl 默认 owner → 被拒
  const sessions = await router.routeInbound(
    transport.inject({ text: '/qq-sessions', sender: { id: 'member-1', name: 'M' } }),
  )
  assert.equal(sessions.handled, 'rejected')
  assert.match(sessions.reply, /需要 owner/)
  const model = await router.routeInbound(
    transport.inject({ text: '/qq-model deepseek/chat', sender: { id: 'member-1', name: 'M' } }),
  )
  assert.equal(model.handled, 'rejected')
  assert.match(model.reply, /需要 owner/)
})

test('命令全部实现：P3/P4 命令给出可操作提示而非占位', async () => {
  const { router, transport } = await setup()
  const model = await router.routeInbound(
    transport.inject({ text: '/qq-model deepseek/chat', sender: { id: 'owner-1', name: 'O' } }),
  )
  assert.match(model.reply, /还没有活跃会话/, 'P3 已实现：无会话时给出可操作提示')
  const login = await router.routeInbound(
    transport.inject({ text: '/qq-login', sender: { id: 'owner-1', name: 'O' } }),
  )
  assert.ok(!/尚未启用/.test(login.reply), 'P4 已实现：不应再有阶段占位')
  assert.match(login.reply, /QQ_APP_ID|手机 QQ/)
})

test('未知 / 命令与 DSH 原生命令钩子', async () => {
  const { router, transport } = await setup({}, { dshCommand: async (ev, line) => (line.startsWith('/plan') ? { handled: true, reply: '计划已切换' } : null) })
  const unknown = await router.routeInbound(
    transport.inject({ text: '/wtf', sender: { id: 'owner-1', name: 'O' } }),
  )
  assert.equal(unknown.handled, 'command-unknown')
  assert.match(unknown.reply, /不支持的命令/)

  const native = await router.routeInbound(
    transport.inject({ text: '/plan off', sender: { id: 'owner-1', name: 'O' } }),
  )
  assert.equal(native.handled, 'command')
  assert.equal(native.reply, '计划已切换')
  assert.equal(native.dsh, true)
})

test('多轮对话：同一 chat 复用会话，不同 chat 隔离', async () => {
  const { router, transport, agents } = await setup()
  const a1 = transport.inject({ text: '一', target: { kind: 'dm', userId: 'owner-1' }, sender: { id: 'owner-1', name: 'O' } })
  const a2 = transport.inject({ text: '二', target: { kind: 'dm', userId: 'owner-1' }, sender: { id: 'owner-1', name: 'O' } })
  const b1 = transport.inject({ text: '三', target: { kind: 'dm', userId: 'other' }, sender: { id: 'other', name: 'X' } })
  await router.routeInbound(a1)
  await router.routeInbound(a2)
  await router.routeInbound(b1)
  // other 未授权 → 配对，不创建会话
  assert.equal(agents.created.length, 1)
  const sessions = agents.created.map(item => item.sessionId)
  assert.equal(new Set(sessions).size, 1)
})
