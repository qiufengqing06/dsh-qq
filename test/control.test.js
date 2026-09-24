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
import { parseCommand } from '../lib/router.js'
import { createUnavailableTransport } from '../lib/transport.js'
import { createFakeAgents, createFakeCtx, createLogger } from './helpers/fake-ctx.js'

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

async function setup({ transport = null, configOverrides = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-control-'))
  const config = resolveConfig({ transport: 'mock', autoConnect: false, dataDir: dir, ...configOverrides })
  const store = createStore({ dir, logger: createLogger() })
  await store.load()
  const tp = transport ?? createMockTransport({})
  const agents = createFakeAgents()
  const ctx = createFakeCtx({ services: { agents } })
  const scope = createResourceScope({ name: 'test' })
  const logger = createLogger()
  const approval = createApprovalRegistry({})
  const bridge = createBridge({ ctx, config, store, transport: tp, scope, logger })
  const control = createControl({ ctx, config, store, bridge, transport: tp, approval, scope, logger })
  const disposeAnswerer = control.installApprovalAnswerer()
  if (typeof disposeAnswerer === 'function') scope.add(disposeAnswerer, 'test: approval answerer')
  return { dir, config, store, tp, agents, ctx, scope, logger, approval, bridge, control }
}

const run = (control, line, role = 'owner') =>
  control.execute(parseCommand(line), { chatKey: 'mock:acct:dm:u1', sender: { id: 'u1', name: 'U' }, target: { kind: 'dm', userId: 'u1' } }, { role })

test('/qq-help 列出全部命令与当前策略', async () => {
  const { control } = await setup()
  const { reply } = await run(control, '/qq-help')
  assert.match(reply, /dsh-qq 命令/)
  assert.match(reply, /\/qq-model/)
  assert.match(reply, /\/qq-stop/)
  assert.match(reply, /权限策略/)
  assert.ok(!/［P[0-9] 启用］/.test(reply), 'P4 完成后不应再有阶段占位标记')
  assert.match(reply, /\/qq-login/)
  assert.match(reply, /\/qq-model/)
})

test('/qq-status 反映传输与状态', async () => {
  const { control, tp } = await setup()
  await tp.start()
  const { reply } = await run(control, '/qq-status')
  assert.match(reply, /传输：mock（已连接/)
  assert.match(reply, /待处理审批：0/)

  const degraded = await setup({ transport: createUnavailableTransport('qqbot', '模块不存在') })
  await degraded.tp.start()
  const degradedReply = (await run(degraded.control, '/qq-status')).reply
  assert.match(degradedReply, /未连接/)
  assert.match(degradedReply, /unavailable/)
})

test('会话命令：sessions / switch / new / stop', async () => {
  const { control, bridge, tp, agents } = await setup()
  const ev = tp.injectText('hi')
  await bridge.handleUserMessage(ev)
  const chatKey = ev.chatKey
  const cmdEv = { chatKey, sender: { id: 'u1', name: 'U' }, target: ev.target }

  const empty = await control.execute(parseCommand('/qq-sessions'), { ...cmdEv, chatKey: 'mock:acct:dm:none' }, { role: 'owner' })
  assert.match(empty.reply, /还没有历史会话/)

  const list = await control.execute(parseCommand('/qq-sessions'), cmdEv, { role: 'owner' })
  assert.match(list.reply, /\[0\] qq-/)
  assert.match(list.reply, /← 当前/)

  const bad = await control.execute(parseCommand('/qq-switch 9'), cmdEv, { role: 'owner' })
  assert.match(bad.reply, /没有序号为 9 的会话/)

  const created = await control.execute(parseCommand('/qq-new'), cmdEv, { role: 'owner' })
  assert.match(created.reply, /已为本对话新建会话 qq-/)
  assert.equal(agents.created.length, 2)

  const sessions = bridge.sessions(chatKey)
  const switched = await control.execute(parseCommand('/qq-switch 1'), cmdEv, { role: 'owner' })
  assert.match(switched.reply, new RegExp(sessions[1].sessionId))

  const noTurn = await control.execute(
    parseCommand('/qq-stop'),
    { ...cmdEv, chatKey: 'mock:acct:dm:nobody' },
    { role: 'owner' },
  )
  assert.match(noTurn.reply, /没有正在执行的回合/)

  const agent = agents.live.get(bridge.currentSession(chatKey))
  const stopped = await control.execute(parseCommand('/qq-stop --keep'), cmdEv, { role: 'owner' })
  assert.match(stopped.reply, /排队消息保留/)
  assert.deepEqual(agent.cancelled, [{ kind: 'user' }])
})

test('权限不足时 control 层再次拦截（双保险）', async () => {
  const { control } = await setup()
  const { reply } = await run(control, '/qq-new', 'everyone')
  assert.match(reply, /无权限执行 \/qq-new/)
})

test('全部命令均已实现（无阶段占位残留）', async () => {
  const { control } = await setup()
  for (const spec of control.listCommands()) {
    const { reply } = await run(control, spec.usage.replace(/<[^>]+>/g, 'x').replace(/\[[^\]]+\]/g, ''))
    assert.ok(!/尚未启用/.test(reply), `${spec.name} 不应再是阶段占位：${reply}`)
  }
})

test('注册到 DSH 命令系统：无斜杠名 + disposer 全清', async () => {
  const { control } = await setup()
  const registered = []
  const commandsService = {
    register(definition) {
      registered.push(definition)
      return () => {
        const index = registered.indexOf(definition)
        if (index >= 0) registered.splice(index, 1)
      }
    },
  }
  const dispose = control.registerCommands(commandsService)
  assert.equal(registered.length, control.listCommands().length)
  assert.ok(registered.every(item => /^[a-z][a-z0-9_-]*$/.test(item.name)))
  assert.ok(registered.every(item => item.description.length > 0))
  const help = registered.find(item => item.name === 'qq-help')
  assert.equal((await help.handler()).kind, 'success')
  dispose()
  assert.equal(registered.length, 0)
})

test('commands 服务缺失时注册降级为告警', async () => {
  const { control, logger } = await setup()
  const dispose = control.registerCommands(undefined)
  assert.equal(typeof dispose, 'function')
  assert.ok(logger.entries.warn.some(line => line.includes('commands 服务不可用')))
})

test('配对申请：记录待批 + 通知管理员', async () => {
  const { control, store, tp } = await setup()
  const ev = { chatKey: 'mock:acct:dm:u9', sender: { id: 'u9', name: '新人' }, target: { kind: 'dm', userId: 'u9' } }
  const first = await control.requestPairing(ev)
  assert.equal(first.notified, false, '未设置 home channel 时无通知对象')
  assert.match(first.reply, /等待管理员批准/)
  assert.equal(store.pendingPairing().length, 1)

  await store.setHomeChannel('owner-9')
  const second = await control.requestPairing({ ...ev, sender: { id: 'u10', name: '新人2' } })
  assert.equal(second.notified, true)
  const dm = tp.dump().find(entry => entry.kind === 'text')
  assert.match(dm.text, /\/qq-approve u10/)
  assert.equal(dm.target.kind, 'dm')
  assert.equal(dm.target.userId, 'owner-9')
})

test('审批转发：QQ 收到按钮消息，授权用户点按后返回 allowed-once', async () => {
  const { control, bridge, tp, ctx, approval, agents } = await setup()
  const ev = tp.injectText('跑个命令')
  await bridge.handleUserMessage(ev)
  const sessionId = agents.created[0].sessionId

  const pending = ctx.emitWaterfall('approval/request', {
    agent: { session: { id: sessionId } },
    toolName: 'bash',
    reason: 'rm -rf build',
  })
  await tick(30)
  const keyboard = tp.dump().find(entry => entry.kind === 'keyboard')
  assert.ok(keyboard !== undefined, '应发出带按钮的审批消息')
  assert.match(keyboard.text, /需要你批准一次敏感操作/)
  assert.match(keyboard.text, /bash/)
  assert.equal(keyboard.buttons.length, 2)

  const allow = keyboard.buttons[0].data
  const reply = await control.handleApprovalButton(allow, { chatKey: ev.chatKey, sender: { id: ev.sender.id } }, 'allow')
  assert.match(reply, /已允许本次操作/)
  assert.equal(await pending, 'allowed-once')
})

test('审批转发：拒绝 / 非托管会话交给下一个 answerer', async () => {
  const { control, bridge, tp, ctx, agents } = await setup()
  const ev = tp.injectText('hi')
  await bridge.handleUserMessage(ev)
  const sessionId = agents.created[0].sessionId

  const denied = ctx.emitWaterfall('approval/request', {
    agent: { session: { id: sessionId } },
    toolName: 'bash',
  })
  await tick(30)
  const keyboard = tp.dump().findLast(entry => entry.kind === 'keyboard')
  // 审批人必须是该 DM 的对话方（approverFor 绑定），陌生人点按会被拒且记录保持 pending
  const wrongActor = await control.handleApprovalButton(
    keyboard.buttons[1].data,
    { chatKey: ev.chatKey, sender: { id: 'someone-else' } },
    'deny',
  )
  assert.match(wrongActor, /审批失败（mismatch）/)
  const denyReply = await control.handleApprovalButton(
    keyboard.buttons[1].data,
    { chatKey: ev.chatKey, sender: { id: ev.sender.id } },
    'deny',
  )
  assert.match(denyReply, /已拒绝本次操作/)
  assert.equal(await denied, 'rejected')

  const unmanaged = await ctx.emitWaterfall('approval/request', {
    agent: { session: { id: 'other-session' } },
    toolName: 'bash',
  })
  assert.equal(unmanaged, 'unavailable', '非本插件托管会话应 next() 委派')
})

test('审批超时 fail-closed（unavailable）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-control-'))
  const config = resolveConfig({ transport: 'mock', autoConnect: false, dataDir: dir, approvalTtlMs: 1000 })
  const store = createStore({ dir })
  await store.load()
  const tp = createMockTransport({})
  const agents = createFakeAgents()
  const ctx = createFakeCtx({ services: { agents } })
  const scope = createResourceScope()
  const approval = createApprovalRegistry({ ttlMs: 60 })
  const bridge = createBridge({ ctx, config, store, transport: tp, scope })
  const control = createControl({ ctx, config, store, bridge, transport: tp, approval, scope })
  await bridge.handleUserMessage(tp.injectText('hi'))
  const sessionId = agents.created[0].sessionId
  const pending = ctx.emitWaterfall('approval/request', { agent: { session: { id: sessionId } }, toolName: 'bash' })
  const outcome = await pending
  assert.equal(outcome, 'unavailable')
})

// ── P3：会话级模型 / 推理 / 标题（本地实现 installModelSelection 等价物） ──

/** 假 llm 服务：可选地拒绝某些路由。 */
function createFakeLlm({ reject = [] } = {}) {
  return {
    calls: [],
    async resolveCallConfig(request) {
      this.calls.push(request)
      if (reject.includes(`${request.provider}/${request.model}`)) throw new Error('未知 provider 路由')
      return { provider: request.provider, model: request.model, ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }) }
    },
    listConfigurableProviders() {
      return [
        { provider: 'deepseek', displayName: 'DeepSeek' },
        { provider: 'mimo', displayName: 'MiMo' },
      ]
    },
  }
}

function createFakeDefaultModel(selection = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' }) {
  return {
    saved: [],
    selection,
    currentSelection() {
      return { ...this.selection }
    },
    async saveSelection(next) {
      this.saved.push(next)
    },
  }
}

function createFakeTitles() {
  return {
    renamed: [],
    rename(session, title) {
      if (title.trim() === '') throw new Error('标题为空')
      this.renamed.push({ sessionId: session.id, title })
      return { title: title.trim() }
    },
  }
}

async function setupP3({ configOverrides = {}, llmReject = [] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-p3-'))
  const config = resolveConfig({ transport: 'mock', autoConnect: false, dataDir: dir, ...configOverrides })
  const store = createStore({ dir })
  await store.load()
  const tp = createMockTransport({})
  const agents = createFakeAgents()
  const llm = createFakeLlm({ reject: llmReject })
  const agentDefaultModel = createFakeDefaultModel()
  const sessionTitle = createFakeTitles()
  const ctx = createFakeCtx({
    services: { agents, llm, agentDefaultModel, sessionTitle },
  })
  const scope = createResourceScope({ name: 'p3' })
  const approval = createApprovalRegistry({})
  const bridge = createBridge({
    ctx,
    config,
    store,
    transport: tp,
    scope,
    onAgentReady: (agent, chatKey) => control.applyStoredSelection(agent, chatKey),
  })
  const control = createControl({ ctx, config, store, bridge, transport: tp, approval, scope })
  await store.setHomeChannel('u1')
  const ev = tp.injectText('hi')
  await bridge.handleUserMessage(ev)
  const agent = agents.live.get(agents.created[0].sessionId)
  const cmdEv = { chatKey: ev.chatKey, sender: { id: 'u1', name: 'U' }, target: ev.target }
  return { dir, config, store, tp, agents, ctx, scope, bridge, control, agent, cmdEv }
}

test('P3 /qq-model：会话级切换、请求改写、prompt 变量、会话事件写入', async () => {
  const env = await setupP3()
  const { reply } = await env.control.execute(parseCommand('/qq-model deepseek/deepseek-chat'), env.cmdEv, { role: 'owner' })
  assert.match(reply, /已切换本会话模型为 deepseek\/deepseek-chat/)
  assert.match(reply, /下一轮生效/)

  // ① 请求改写：下一请求用新 provider/model
  const rewritten = await env.agent.ctx.runWaterfall(
    'agent/request',
    [{}],
    async () => ({ provider: 'base', model: 'base-model', reasoningEffort: 'low', maxTokens: 100 }),
  )
  assert.equal(rewritten.provider, 'deepseek')
  assert.equal(rewritten.model, 'deepseek-chat')
  assert.equal(rewritten.maxTokens, 100, '其余请求字段不得被吞')
  assert.equal(rewritten.reasoningEffort, 'max', '切换模型时沿用本会话既有推理强度')

  // ② prompt 变量
  const assembled = await env.agent.ctx.runWaterfall(
    'system-prompt/assemble',
    [{}, {}],
    async () => ({ variables: { cwd: '/tmp' }, sections: [] }),
  )
  assert.deepEqual(assembled.variables, { cwd: '/tmp', provider: 'deepseek', model: 'deepseek-chat' })

  // ③ 会话事件 + store 持久化
  assert.equal(env.agent.appended.at(-1).type, 'model/selection')
  assert.deepEqual(env.agent.appended.at(-1).data, { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'max' })
  assert.equal(env.store.chat(env.cmdEv.chatKey).model, 'deepseek/deepseek-chat')
  assert.equal(env.config.controlPolicy.modelControl, 'owner')
})

test('P3 /qq-model：默认只改会话，--default 才落全局默认', async () => {
  const env = await setupP3()
  await env.control.execute(parseCommand('/qq-model deepseek/deepseek-chat'), env.cmdEv, { role: 'owner' })
  assert.deepEqual(env.ctx.get('agentDefaultModel').saved, [], '默认不得修改全局默认模型')

  const { reply } = await env.control.execute(
    parseCommand('/qq-model mimo/mimo-7b --default'),
    env.cmdEv,
    { role: 'owner' },
  )
  assert.match(reply, /并已设为全局默认/)
  assert.deepEqual(
    env.ctx.get('agentDefaultModel').saved,
    [{ provider: 'mimo', model: 'mimo-7b', reasoningEffort: 'max' }],
    '--default 保存的选择含当前推理强度',
  )
})

test('P3 /qq-model：非法路由被 llm 校验拦下，状态不变', async () => {
  const env = await setupP3({ llmReject: ['ghost/nope'] })
  const { reply } = await env.control.execute(parseCommand('/qq-model ghost/nope'), env.cmdEv, { role: 'owner' })
  assert.match(reply, /模型不可用/)
  assert.equal(env.store.chat(env.cmdEv.chatKey).model, 'deepseek-official/deepseek-flash', '非法路由不应改动既有选择')
  assert.equal(env.agent.ctx.listenerCount('agent/request'), 1, '默认选择监听应保持')
})

test('P3 /qq-model：用法错误与 list 提示', async () => {
  const env = await setupP3()
  const bad = await env.control.execute(parseCommand('/qq-model deepseek'), env.cmdEv, { role: 'owner' })
  assert.match(bad.reply, /用法：\/qq-model <provider>\/<model>/)
  const list = await env.control.execute(parseCommand('/qq-model list'), env.cmdEv, { role: 'owner' })
  assert.match(list.reply, /deepseek — DeepSeek/)
  assert.match(list.reply, /当前会话模型：deepseek-official\/deepseek-flash/, '会话建立即带 DSH 默认模型')
})

test('P3 /qq-reasoning：改强度 / 复位 default（默认模型已就位）', async () => {
  const env = await setupP3()
  // 会话建立时已装 DSH 默认模型，因此可直接调强度
  const high = await env.control.execute(parseCommand('/qq-reasoning high'), env.cmdEv, { role: 'owner' })
  assert.match(high.reply, /推理强度设为 high/)
  const rewritten = await env.agent.ctx.runWaterfall('agent/request', [{}], async () => ({ provider: 'base', model: 'm' }))
  assert.equal(rewritten.reasoningEffort, 'high')
  assert.equal(env.store.chat(env.cmdEv.chatKey).reasoning, 'high')

  const cleared = await env.control.execute(parseCommand('/qq-reasoning default'), env.cmdEv, { role: 'owner' })
  assert.match(cleared.reply, /已恢复该模型的默认推理强度/)
  const after = await env.agent.ctx.runWaterfall('agent/request', [{}], async () => ({ provider: 'base', model: 'm', reasoningEffort: 'low' }))
  assert.equal(after.reasoningEffort, undefined)
  assert.equal(env.store.chat(env.cmdEv.chatKey).reasoning, null)
  assert.equal(env.control.ensureSelection(env.agent, env.cmdEv.chatKey).reasoningEffort, undefined, '复位后再次安装不应凭空出现强度')

  const invalid = await env.control.execute(parseCommand('/qq-reasoning turbo'), env.cmdEv, { role: 'owner' })
  assert.match(invalid.reply, /不支持的推理强度/)
  const query = await env.control.execute(parseCommand('/qq-reasoning'), env.cmdEv, { role: 'owner' })
  assert.match(query.reply, /当前推理强度/)
})

test('P3 /qq-title：调用 sessionTitle 服务并回报接受值', async () => {
  const env = await setupP3()
  const ok = await env.control.execute(parseCommand('/qq-title DSH 调试会话'), env.cmdEv, { role: 'owner' })
  assert.match(ok.reply, /已将会话重命名为「DSH 调试会话」/)
  assert.equal(env.ctx.get('sessionTitle').renamed.length, 1)
  const empty = await env.control.execute(parseCommand('/qq-title'), env.cmdEv, { role: 'owner' })
  assert.match(empty.reply, /用法：\/qq-title/)
})

test('P3 无活跃会话时给出可操作提示', async () => {
  const env = await setupP3()
  const coldEv = { chatKey: 'mock:acct:dm:nobody', sender: { id: 'u1', name: 'U' }, target: { kind: 'dm', userId: 'nobody' } }
  const reply = await env.control.execute(parseCommand('/qq-model deepseek/x'), coldEv, { role: 'owner' })
  assert.match(reply.reply, /还没有活跃会话/)
})

test('P3 恢复/新建会话后自动套用该 chat 持久化的模型选择', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-p3b-'))
  const config = resolveConfig({ transport: 'mock', autoConnect: false, dataDir: dir })
  const store = createStore({ dir })
  await store.load()
  const tp = createMockTransport({})
  const agents = createFakeAgents()
  const llm = createFakeLlm()
  const ctx = createFakeCtx({ services: { agents, llm } })
  const scope = createResourceScope({ name: 'p3b' })
  const approval = createApprovalRegistry({})
  const bridge = createBridge({
    ctx,
    config,
    store,
    transport: tp,
    scope,
    onAgentReady: (agent, chatKey) => control.applyStoredSelection(agent, chatKey),
  })
  const control = createControl({ ctx, config, store, bridge, transport: tp, approval, scope })

  const ev = tp.injectText('hi')
  await store.setSelection(ev.chatKey, { model: 'deepseek/deepseek-chat', reasoning: 'medium' })
  await bridge.handleUserMessage(ev)

  const agent = agents.live.get(agents.created[0].sessionId)
  const rewritten = await agent.ctx.runWaterfall('agent/request', [{}], async () => ({ provider: 'base', model: 'm' }))
  assert.equal(rewritten.provider, 'deepseek')
  assert.equal(rewritten.model, 'deepseek-chat')
  assert.equal(rewritten.reasoningEffort, 'medium')
  await scope.dispose()
})

test('P3 scope 释放时移除模型选择监听（无泄漏）', async () => {
  const env = await setupP3()
  await env.control.execute(parseCommand('/qq-model deepseek/deepseek-chat'), env.cmdEv, { role: 'owner' })
  assert.equal(env.agent.ctx.listenerCount('agent/request'), 1)
  await env.scope.dispose()
  assert.equal(env.agent.ctx.listenerCount('agent/request'), 0)
  assert.equal(env.agent.ctx.listenerCount('system-prompt/assemble'), 0)
})

// ── P4：扫码登录 / 登出 / 重连 / 配对批准 ──

/** 假 credentials 服务（记录读写）。 */
function createFakeCredentials(initial = {}) {
  const values = new Map(Object.entries(initial))
  const calls = { set: [], unset: [], resolve: [] }
  return {
    values,
    calls,
    async resolve(ref) {
      calls.resolve.push(ref)
      const value = values.get(ref)
      return value === undefined ? undefined : { value }
    },
    async set(ref, value) {
      calls.set.push({ ref, value })
      values.set(ref, value)
    },
    async unset(ref) {
      calls.unset.push(ref)
      values.delete(ref)
    },
  }
}

/** 假 onboarding provider。 */
function createFakeOnboarding({ began = { taskId: 'task-1', key: 'KEY', url: 'https://q.qq.com/x' }, result = null, failBegin = false } = {}) {
  const provider = {
    calls: { begin: 0, wait: 0 },
    lastWait: null,
    async begin() {
      provider.calls.begin += 1
      if (failBegin) throw new Error('portal 不可用')
      return began
    },
    async wait(spec) {
      provider.calls.wait += 1
      provider.lastWait = spec
      return result
    },
  }
  return provider
}

async function setupP4({ credentialsService = null, onboarding = null, envCredentials = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-p4-'))
  const config = resolveConfig({ transport: 'mock', autoConnect: false, dataDir: dir })
  const store = createStore({ dir })
  await store.load()
  const tp = createMockTransport({})
  await tp.start()
  const agents = createFakeAgents()
  const services = { agents }
  if (credentialsService !== null) services.credentials = credentialsService
  const ctx = createFakeCtx({ services })
  const scope = createResourceScope({ name: 'p4' })
  const logger = createLogger()
  const approval = createApprovalRegistry({})
  const bridge = createBridge({ ctx, config, store, transport: tp, scope, logger })
  const control = createControl({ ctx, config, store, bridge, transport: tp, approval, scope, logger, onboarding })
  const savedEnv = { id: process.env.QQ_APP_ID, secret: process.env.QQ_CLIENT_SECRET }
  if (envCredentials) {
    process.env.QQ_APP_ID = 'env-app'
    process.env.QQ_CLIENT_SECRET = 'env-secret'
  } else {
    delete process.env.QQ_APP_ID
    delete process.env.QQ_CLIENT_SECRET
  }
  const restore = () => {
    if (savedEnv.id === undefined) delete process.env.QQ_APP_ID
    else process.env.QQ_APP_ID = savedEnv.id
    if (savedEnv.secret === undefined) delete process.env.QQ_CLIENT_SECRET
    else process.env.QQ_CLIENT_SECRET = savedEnv.secret
  }
  const ev = { chatKey: 'mock:acct:dm:u1', sender: { id: 'u1', name: 'U' }, target: { kind: 'dm', userId: 'u1' } }
  return { dir, config, store, tp, agents, ctx, scope, logger, bridge, control, ev, restore }
}

test('P4 /qq-login：未配置时给出扫码链接，后台等待并保存凭据', async t => {
  const credentials = createFakeCredentials()
  const onboarding = createFakeOnboarding({ result: { appId: 'app-9', clientSecret: 'sec-9', userOpenId: 'openid-owner' } })
  const env = await setupP4({ credentialsService: credentials, onboarding })
  t.after(() => env.restore())

  const { reply } = await env.control.execute(parseCommand('/qq-login'), env.ev, { role: 'owner' })
  assert.match(reply, /手机 QQ/)
  assert.match(reply, /https:\/\/q\.qq\.com\/x/)
  assert.equal(onboarding.calls.begin, 1)

  await tick(30)
  assert.equal(onboarding.calls.wait, 1)
  assert.deepEqual(
    credentials.calls.set,
    [
      { ref: 'QQ_APP_ID', value: 'app-9' },
      { ref: 'QQ_CLIENT_SECRET', value: 'sec-9' },
    ],
    '凭据必须写入 credentials 服务',
  )
  assert.equal(env.store.accountId(), 'app-9')
  assert.equal(env.store.homeChannel(), 'openid-owner', '首个扫码者成为 home channel')
  const texts = env.tp.dump().filter(entry => entry.kind === 'text').map(entry => entry.text)
  assert.ok(texts.some(text => /扫码登录成功/.test(text)), '应通知登录成功')
  assert.ok(texts.some(text => /已连接/.test(text)), '应在重启 transport 后通知连接结果')
  assert.equal(env.tp.status().connected, true)
})

test('P4 /qq-login：已配置时提示已登录；--force 重新扫码', async t => {
  const credentials = createFakeCredentials({ QQ_APP_ID: 'app-1', QQ_CLIENT_SECRET: 'sec-1' })
  const onboarding = createFakeOnboarding({ result: null })
  const env = await setupP4({ credentialsService: credentials, onboarding })
  t.after(() => env.restore())

  const already = await env.control.execute(parseCommand('/qq-login'), env.ev, { role: 'owner' })
  assert.match(already.reply, /已登录（AppID /)
  assert.match(already.reply, /来源 credentials/)
  assert.equal(onboarding.calls.begin, 0, '已登录时不应发起扫码')

  const forced = await env.control.execute(parseCommand('/qq-login --force'), env.ev, { role: 'owner' })
  assert.match(forced.reply, /手机 QQ/)
  assert.equal(onboarding.calls.begin, 1)
  await tick(30)
  const texts = env.tp.dump().filter(entry => entry.kind === 'text').map(entry => entry.text)
  assert.ok(texts.some(text => /扫码登录未完成/.test(text)), 'wait 返回 null 时应如实通知')
})

test('P4 /qq-login：无 onboarding 且未配置时指向配置入口；portal 失败如实报错', async t => {
  const env = await setupP4({ credentialsService: createFakeCredentials(), onboarding: null })
  t.after(() => env.restore())
  const noProvider = await env.control.execute(parseCommand('/qq-login'), env.ev, { role: 'owner' })
  assert.match(noProvider.reply, /未启用扫码登录/)
  assert.match(noProvider.reply, /QQ_APP_ID/)

  const failing = await setupP4({ credentialsService: createFakeCredentials(), onboarding: createFakeOnboarding({ failBegin: true }) })
  t.after(() => failing.restore())
  const failed = await failing.control.execute(parseCommand('/qq-login'), failing.ev, { role: 'owner' })
  assert.match(failed.reply, /创建扫码任务失败/)
})

test('P4 /qq-logout：清除凭据、断开连接、清空账号', async t => {
  const credentials = createFakeCredentials({ QQ_APP_ID: 'app-1', QQ_CLIENT_SECRET: 'sec-1' })
  const env = await setupP4({ credentialsService: credentials })
  t.after(() => env.restore())
  await env.store.setAccountId('app-1')

  const { reply } = await env.control.execute(parseCommand('/qq-logout'), env.ev, { role: 'owner' })
  assert.match(reply, /已清除本地凭据并断开连接/)
  assert.deepEqual(credentials.calls.unset, ['QQ_APP_ID', 'QQ_CLIENT_SECRET'])
  assert.equal(env.store.accountId(), '')
  assert.equal(env.tp.status().phase, 'stopped')
})

test('P4 /qq-reconnect：停后重启 transport', async t => {
  const env = await setupP4()
  t.after(() => env.restore())
  const { reply } = await env.control.execute(parseCommand('/qq-reconnect'), env.ev, { role: 'owner' })
  assert.match(reply, /正在重连（当前 connected）/)
  assert.equal(env.tp.status().connected, true)
})

test('P4 /qq-approve：批准申请并通知对方；无参数时列出待批', async t => {
  const env = await setupP4()
  t.after(() => env.restore())
  const empty = await env.control.execute(parseCommand('/qq-approve'), env.ev, { role: 'owner' })
  assert.match(empty.reply, /当前没有待批准的申请/)

  await env.store.addPendingPairing({ userId: 'u9', name: '新人' })
  const listed = await env.control.execute(parseCommand('/qq-approve'), env.ev, { role: 'owner' })
  assert.match(listed.reply, /待批准：u9/)

  const ok = await env.control.execute(parseCommand('/qq-approve u9'), env.ev, { role: 'owner' })
  assert.match(ok.reply, /已批准 u9/)
  assert.equal(env.store.roleOf('u9'), 'authorized')
  const dm = env.tp.dump().find(entry => entry.kind === 'text' && entry.target.userId === 'u9')
  assert.match(dm.text, /你已被批准/)
})

test('P4 权限：普通授权用户不能登录/登出', async () => {
  const env = await setupP4({ credentialsService: createFakeCredentials() })
  const denied = await env.control.execute(parseCommand('/qq-login'), env.ev, { role: 'authorized' })
  assert.match(denied.reply, /无权限执行 \/qq-login/)
  await env.restore()
})

// ── Web 侧执行：渠道无关命令走真实逻辑（解决首次登录鸡生蛋问题） ──

test('Web 执行 /qq-status 与 /qq-help 走真实逻辑（非占位提示）', async () => {
  const env = await setupP4()
  const registered = new Map()
  const commandsService = {
    register(definition) {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  }
  env.control.registerCommands(commandsService)

  const status = await registered.get('qq-status').handler()
  assert.equal(status.kind, 'success')
  assert.match(status.text, /dsh-qq 状态/)
  assert.match(status.text, /传输：mock/)

  const help = await registered.get('qq-help').handler()
  assert.match(help.text, /dsh-qq 命令/)
  assert.ok(!/请在对应的 QQ 对话里发送/.test(help.text))
  await env.scope.dispose()
})

test('Web 执行 /qq-login 能发起扫码（无需 QQ 会话上下文，通知自动跳过）', async () => {
  const credentials = createFakeCredentials()
  const onboarding = createFakeOnboarding({ result: { appId: 'app-web', clientSecret: 'sec-web', userOpenId: 'openid-web' } })
  const env = await setupP4({ credentialsService: credentials, onboarding })
  const registered = new Map()
  env.control.registerCommands({
    register(definition) {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  })

  const result = await registered.get('qq-login').handler()
  assert.equal(result.kind, 'success')
  assert.match(result.text, /手机 QQ/)
  assert.match(result.text, /https:\/\/q\.qq\.com\/x/)
  await tick(30)
  assert.deepEqual(
    credentials.calls.set.map(entry => entry.ref),
    ['QQ_APP_ID', 'QQ_CLIENT_SECRET'],
    'Web 侧扫码成功后同样写入凭据',
  )
  assert.equal(env.store.accountId(), 'app-web')
  assert.equal(env.tp.status().connected, true, '登录后应重连成功')
  await env.scope.dispose()
})

test('Web 执行会话相关命令时给出「请在 QQ 里发送」的提示', async () => {
  const env = await setupP4()
  const registered = new Map()
  env.control.registerCommands({
    register(definition) {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  })
  for (const name of ['qq-model', 'qq-sessions', 'qq-switch', 'qq-stop', 'qq-title', 'qq-approve']) {
    const result = await registered.get(name).handler()
    assert.match(result.text, /请在对应的 QQ 对话里发送/, `${name} 应提示到 QQ 里执行`)
  }
  await env.scope.dispose()
})

// ── 回归：ensureSelection 必须给 QQ 会话装上模型选择（{{model}} 变量） ──

test('ensureSelection：无持久化选择时用 DSH 默认模型安装变量并落库', async () => {
  const env = await setupP3()
  const installed = env.control.ensureSelection(env.agent, env.cmdEv.chatKey)
  assert.ok(installed !== null)
  assert.equal(installed.provider, 'deepseek-official')
  assert.equal(installed.model, 'deepseek-flash')
  assert.equal(installed.reasoningEffort, 'max')

  // persona 模板引用的 {{model}} / {{provider}} 现在有值了
  const assembled = await env.agent.ctx.runWaterfall('system-prompt/assemble', [{}, {}], async () => ({ variables: {} }))
  assert.deepEqual(assembled.variables, { provider: 'deepseek-official', model: 'deepseek-flash' })
  // 请求也会带上默认模型
  const request = await env.agent.ctx.runWaterfall('agent/request', [{}], async () => ({ provider: 'x', model: 'y' }))
  assert.equal(request.provider, 'deepseek-official')
  assert.equal(request.model, 'deepseek-flash')
  // 落库（/qq-status 与后续切换可见）
  assert.equal(env.store.chat(env.cmdEv.chatKey).model, 'deepseek-official/deepseek-flash')
  assert.equal(env.store.chat(env.cmdEv.chatKey).reasoning, 'max', '推理强度也要落库')
  assert.equal(env.agent.appended.at(-1).type, 'model/selection')
  await env.scope.dispose()
})

test('ensureSelection：优先使用该 chat 持久化的选择（跨重启保持）', async () => {
  const env = await setupP3()
  await env.store.setSelection(env.cmdEv.chatKey, { model: 'mimo/mimo-7b', reasoning: 'high' })
  const installed = env.control.ensureSelection(env.agent, env.cmdEv.chatKey)
  assert.equal(installed.provider, 'mimo')
  assert.equal(installed.model, 'mimo-7b')
  assert.equal(installed.reasoningEffort, 'high')
  const assembled = await env.agent.ctx.runWaterfall('system-prompt/assemble', [{}, {}], async () => ({ variables: {} }))
  assert.equal(assembled.variables.model, 'mimo-7b')
  await env.scope.dispose()
})

test('ensureSelection：既无默认模型也无持久化选择时如实告警（不静默）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-nodefault-'))
  const config = resolveConfig({ transport: 'mock', autoConnect: false, dataDir: dir })
  const store = createStore({ dir })
  await store.load()
  const tp = createMockTransport({})
  const agents = createFakeAgents()
  const ctx = createFakeCtx({ services: { agents } })
  const scope = createResourceScope({ name: 'nodefault' })
  const logger = createLogger()
  const bridge = createBridge({ ctx, config, store, transport: tp, scope, logger })
  const control = createControl({ ctx, config, store, bridge, transport: tp, approval: createApprovalRegistry({}), scope, logger })
  await bridge.handleUserMessage(tp.injectText('hi'))
  const agent = agents.live.get(agents.created[0].sessionId)
  assert.equal(control.ensureSelection(agent, 'mock:acct:dm:u1'), null)
  assert.ok(logger.entries.warn.some(line => line.includes('既无会话选择也无 DSH 默认模型')))
  await scope.dispose()
})
