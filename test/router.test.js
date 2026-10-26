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
import { createParticipation } from '../lib/participation.js'
import { createFakeAgents, createFakeCtx, createLogger } from './helpers/fake-ctx.js'

async function setup(configOverrides = {}, { dshCommand = null, participation = null } = {}) {
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
  const router = createRouter({ config, store, control, bridge, participation, logger, dshCommand })
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
  assert.equal(stripMention('<@!123> /qq-help', { selfId: '123' }), '/qq-help')
  assert.equal(stripMention('@bot 你好', { selfId: 'bot' }), '你好')
  assert.equal(stripMention('@other 你好', { selfId: 'bot' }), '@other 你好')
  assert.equal(stripMention('<@!other> /qq-help', { selfId: 'bot' }), '<@!other> /qq-help')
  assert.equal(stripMention('@unknown 你好'), '@unknown 你好', '没有已知自身标识时不猜测对象')
  assert.equal(stripMention('<@!bot> @other 你好', { selfId: 'bot' }), '@other 你好')
  assert.equal(stripMention('<@!app-1> /qq-help', { transportKind: 'qqbot', accountId: 'app-1' }), '<@!app-1> /qq-help', '官方AppID不是自身用户ID')
})

test('参与判断：wake=true 才进 bridge，命令仍不参与', async () => {
  const calls = []
  const participation = { evaluate: async ev => { calls.push(ev.text); return { wake: ev.text.includes('报错') } } }
  const { router, transport, store } = await setup({}, { participation })
  await store.setMode('mock:acct:group:g1', 'chat')
  const hit = transport.inject({
    target: { kind: 'group', groupId: 'g1' },
    sender: { id: 'owner-1', name: 'O' },
    text: '这个报错怎么修',
    mentioned: false,
  })
  const result = await router.routeInbound(hit)
  assert.equal(result.handled, 'message')
  assert.deepEqual(calls, ['这个报错怎么修'])

  const miss = transport.inject({
    target: { kind: 'group', groupId: 'g1' },
    sender: { id: 'owner-1', name: 'O' },
    text: '在吗',
    mentioned: false,
  })
  assert.deepEqual(await router.routeInbound(miss), { handled: 'ignored', reason: 'not-mentioned' })

  const command = transport.inject({
    target: { kind: 'group', groupId: 'g1' },
    sender: { id: 'owner-1', name: 'O' },
    text: '/qq-status',
    mentioned: false,
  })
  assert.deepEqual(await router.routeInbound(command), { handled: 'ignored', reason: 'not-mentioned' })
})

test('短补充准入：不重复要求@，仍检查聊天授权且不放开命令', async () => {
  const env = await setup({ pairingPolicy: 'allowlist' })
  const chatKey = 'mock:mock:group:g1'
  await env.store.setMode(chatKey, 'chat')
  const delivered = []
  const router = createRouter({ ...env, bridge: {
    acceptsChatSupplement: () => true,
    handleUserMessage: async ev => { delivered.push(ev); return { accepted: true } },
  } })
  const ev = env.transport.inject({ target: { kind: 'group', groupId: 'g1' }, sender: { id: 'owner-1' }, text: '补一句', mentioned: false })
  assert.equal((await router.routeInbound(ev)).handled, 'message')
  assert.equal(delivered.length, 1)
  assert.equal((await router.routeInbound({ ...ev, text: '/qq-status' })).reason, 'not-mentioned')
  const denied = await router.routeInbound({ ...ev, sender: { id: 'stranger' } })
  assert.notEqual(denied.handled, 'message')
  assert.equal(delivered.length, 1)
})

test('免@群：block筛选聊天消息，log/off与work保留旧行为；命令不参与评分', async () => {
  for (const mode of ['block', 'log', 'off']) {
    const env = await setup({ freeReplyGroups: ['g1'], participation: { enabled: true, mode, quietHours: '00:00-00:00' } })
    const p = createParticipation({ config: env.config, store: env.store })
    const router = createRouter({ ...env, participation: p })
    const input = env.transport.inject({ target: { kind: 'group', groupId: 'g1' }, sender: { id: 'owner-1' }, text: '这是随口说的话', mentioned: false })
    await env.store.setMode(input.chatKey, 'chat')
    assert.equal((await router.routeInbound(input)).handled, mode === 'block' ? 'ignored' : 'message', mode)
    const before = p.snapshot().recent.length
    assert.equal((await router.routeInbound({ ...input, text: '/qq-help' })).handled, 'command')
    assert.equal(p.snapshot().recent.length, before, '控制命令不评分')
    await env.store.setMode(input.chatKey, 'work')
    assert.equal((await router.routeInbound(input)).handled, 'message', 'work免@行为不改变')
  }
})

test('参与续聊不绕过ACL，未授权群友不占冷却或续聊名额', async () => {
  const env = await setup({ pairingPolicy: 'allowlist', participation: { enabled: true, mode: 'block', quietHours: '00:00-00:00' } })
  const p = createParticipation({ config: env.config, store: env.store })
  const router = createRouter({ ...env, participation: p })
  const denied = env.transport.inject({ target: { kind: 'group', groupId: 'g1' }, sender: { id: 'stranger' }, text: '这个报错怎么修呀', mentioned: false })
  await env.store.setMode(denied.chatKey, 'chat')
  p.observeReply({ chatKey: denied.chatKey, senderId: 'stranger', messageId: 'previous' })
  assert.equal((await router.routeInbound(denied)).handled, 'ignored')
  assert.equal(env.agents.created.length, 0)
  assert.equal(p.snapshot().recent.length, 0)
  assert.equal((await router.routeInbound({ ...denied, sender: { id: 'owner-1' } })).handled, 'message')
  const freeConfig = { ...env.config, freeReplyGroups: ['g1'] }
  const freeRouter = createRouter({ ...env, config: freeConfig, participation: p })
  assert.equal((await freeRouter.routeInbound(denied)).handled, 'rejected', '免@群仍显示原有白名单拒绝结果')
})

test('完整续聊链：真实出站回执维持八轮接话，主动日额度耗尽只拦新话题', { timeout: 5000 }, async () => {
  const env = await setup({
    freeReplyGroups: ['g1'],
    participation: { enabled: true, mode: 'block', dailyWakeLimit: 1, quietHours: '00:00-00:00' },
  })
  let now = new Date(2026, 9, 26, 12).getTime()
  const clock = () => now
  const p = createParticipation({ config: env.config, store: env.store, clock })
  const receipts = []
  let resolveReply
  const bridge = createBridge({
    ...env, clock, chatInputWindowMs: 0, sleep: async () => {}, random: () => 0,
    onReply: record => {
      p.observeReply(record)
      receipts.push(record)
      resolveReply?.(record)
    },
  })
  const router = createRouter({ ...env, bridge, participation: p })
  const target = { kind: 'group', groupId: 'g1' }
  let inputId = 0
  const input = (text, senderId = 'member-1') => env.transport.inject({
    target, sender: { id: senderId, name: '群友' }, text, mentioned: false, messageId: `incoming-${++inputId}`,
  })
  const output = () => env.transport.dump().filter(item => item.kind === 'text')
  try {
    const first = input('这个报错怎么修呀')
    await env.store.setMode(first.chatKey, 'chat')
    const reply = async (message, answer, expectedCount) => {
      assert.equal((await router.routeInbound(message)).handled, 'message', `第 ${expectedCount} 次输入应进入真实 bridge`)
      const agent = env.agents.live.get(bridge.currentSession(message.chatKey))
      const sent = new Promise(resolve => { resolveReply = resolve })
      agent.reply(answer).ctx.emitStatus('idle')
      const receipt = await sent
      await new Promise(resolve => setImmediate(resolve))
      resolveReply = null
      assert.equal(receipt.senderId, 'member-1')
      assert.equal(receipt.explicit, false, '整个测试没有显式 @ 重置额度')
      assert.match(receipt.messageId, /^mock-\d+$/, '来自 mock transport 的真实发送回执')
      assert.equal(output().length, expectedCount)
      assert.equal(output().at(-1).text, answer)
      assert.equal(bridge.isBusy(message.chatKey), false, '等待回发链完成再进入下一轮')
    }
    await reply(first, '我看看', 1)
    assert.deepEqual(p.snapshot().recent[0].reasons, ['question', 'length'], '初次确实是自主唤醒并消耗唯一日额度')
    const lines = ['没钱还吃饭', '不是，又冷暴力我', '出列，说话，蓝色大肥鱼']
    for (let i = 0; i < 8; i++) {
      now += 90_000
      await reply(input(lines[i % lines.length]), `第${i + 1}轮接上了`, i + 2)
      assert.deepEqual(p.snapshot().recent.at(-1).reasons, ['continuation'])
    }
    assert.equal(receipts.length, 9)
    assert.equal(env.agents.created.length, 1, '持续复用同一个真实假会话')
    assert.equal(env.agents.live.get(bridge.currentSession(first.chatKey)).followed.length, 9)
    assert.deepEqual(await router.routeInbound(input('这个报错怎么修呀', 'other-member')), { handled: 'ignored', reason: 'participation' })
    assert.equal(p.snapshot().recent.at(-1).skipped, 'daily-limit', '旁人的新话题仍受已耗尽的主动额度约束')
    assert.equal((await router.routeInbound(input('先别说了'))).handled, 'ignored')
    assert.equal(p.snapshot().recent.at(-1).skipped, 'conversation-ended')
    assert.equal((await router.routeInbound(input('没钱还吃饭'))).handled, 'ignored', '停止语关闭续聊窗口')
    assert.equal(output().length, 9)
    assert.equal(receipts.length, 9)
  } finally { await env.scope.dispose() }
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

test('群成员默认不再逐个配对；DM 仍走配对；allowlist 保持严格', async () => {
  const { router, transport, agents, store } = await setup()
  const group = transport.inject({
    target: { kind: 'group', groupId: 'g1' },
    sender: { id: 'member-x', name: '群友' },
    text: '大家好',
    mentioned: true,
  })
  assert.equal((await router.routeInbound(group)).handled, 'message')
  assert.equal(agents.created.length, 1)
  assert.equal(store.pendingPairing().length, 0)

  const dm = transport.inject({ text: '你好', sender: { id: 'member-y', name: '陌生人' } })
  assert.equal((await router.routeInbound(dm)).handled, 'pairing', 'DM 仍按陌生人策略')

  const strict = await setup({ pairingPolicy: 'allowlist' })
  const strictGroup = strict.transport.inject({
    target: { kind: 'group', groupId: 'g1' },
    sender: { id: 'member-z', name: '群友' },
    text: '大家好',
    mentioned: true,
  })
  assert.equal((await strict.router.routeInbound(strictGroup)).handled, 'rejected')
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

test('pairingPolicy=allowlist：陌生人直接拒绝，不写待批申请', async () => {
  const { router, transport, agents, store } = await setup({ pairingPolicy: 'allowlist' })
  const ev = transport.inject({ text: '你好', sender: { id: 'stranger', name: '路人' } })
  const result = await router.routeInbound(ev)
  assert.equal(result.handled, 'rejected')
  assert.equal(result.reason, 'unauthorized')
  assert.match(result.reply, /白名单/)
  assert.equal(agents.created.length, 0)
  assert.equal(store.pendingPairing().length, 0, 'allowlist 不得退化成 pairing（不写 pending）')
})

test('pairingPolicy=allowlist：已授权用户正常对话', async () => {
  const { router, transport, agents, store } = await setup({ pairingPolicy: 'allowlist' })
  await store.addAuthorized('member-1', { role: 'authorized' })
  const result = await router.routeInbound(transport.inject({ text: '你好', sender: { id: 'member-1', name: '成员' } }))
  assert.equal(result.handled, 'message')
  assert.equal(agents.created.length, 1)
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
