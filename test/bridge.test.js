import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveConfig } from '../lib/config.js'
import { createStore } from '../lib/store.js'
import { createMockTransport } from '../lib/mock.js'
import { createGroupMemory } from '../lib/group-memory.js'
import { createResourceScope } from '../lib/scope.js'
import { createBridge, dshUiFencesToText, extractAssistantText, extractTurnError, lastEventSeq, stripDshUiFences, toPlainText } from '../lib/bridge.js'
import { createFakeAgents, createFakeCtx, createLogger } from './helpers/fake-ctx.js'

const tick = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms))

async function setup(overrides = {}, serviceOverrides = {}, transportOptions = {}, bridgeOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-bridge-'))
  const config = resolveConfig({ transport: 'mock', autoConnect: false, dataDir: dir, ...overrides })
  const store = createStore({ dir, logger: createLogger() })
  await store.load()
  const transport = createMockTransport(transportOptions)
  const agents = createFakeAgents()
  const ctx = createFakeCtx({ services: { agents, ...serviceOverrides } })
  const scope = createResourceScope({ name: 'test' })
  const bridge = createBridge({ ctx, config, store, transport, scope, logger: createLogger(), ...bridgeOptions })
  return { dir, config, store, transport, agents, ctx, scope, bridge }
}

test('首条消息创建会话并以 user 消息 followup', async () => {
  const { bridge, transport, agents, store } = await setup()
  const ev = transport.injectText('ping')
  const result = await bridge.handleUserMessage(ev)
  assert.equal(result.accepted, true)
  assert.equal(agents.created.length, 1)
  const sessionId = agents.created[0].sessionId
  assert.match(sessionId, /^qq-/)
  const agent = agents.live.get(sessionId)
  assert.equal(agent.followed.length, 1)
  assert.equal(agent.followed[0].role, 'user')
  assert.deepEqual(agent.followed[0].content, [{ type: 'text', text: 'ping' }])
  assert.equal(store.chat(ev.chatKey).currentSessionId, sessionId)
})

test('后续消息复用同一会话，不重复创建（回合结束后的新消息开新回合）', async () => {
  const { bridge, transport, agents } = await setup()
  await bridge.handleUserMessage(transport.injectText('一'))
  const agent = agents.live.get(agents.created[0].sessionId)
  assert.equal(agent.followed.length, 1)
  agent.ctx.emitStatus('idle') // 第一回合结束
  await tick()
  await bridge.handleUserMessage(transport.injectText('二'))
  assert.equal(agents.created.length, 1, '复用同一会话')
  assert.equal(agent.followed.length, 2, '轮末之后的消息各自开回合')
  assert.equal(agent.steered.length, 0)
})

test('引用消息进入模型可见内容', async () => {
  const { bridge, transport, agents } = await setup()
  const ev = transport.inject({
    text: '继续',
    target: { kind: 'dm', userId: 'u1' },
    sender: { id: 'u1', name: 'U' },
    replyTo: { messageId: 'm0', text: '上一句' },
  })
  await bridge.handleUserMessage(ev)
  const agent = agents.live.get(agents.created[0].sessionId)
  assert.deepEqual(
    agent.followed[0].content.map(block => block.text),
    ['[引用消息] 上一句', '继续'],
  )
})

test('回合结束回发 assistant 文本；running 时发 typing', async () => {
  const { bridge, transport, agents, ctx } = await setup()
  const ev = transport.injectText('ping')
  await bridge.handleUserMessage(ev)
  const agent = agents.live.get(agents.created[0].sessionId)

  agent.ctx.emitStatus('running')
  assert.equal(transport.typingCount(), 1)

  agent.reply('pong')
  agent.ctx.emitStatus('idle')
  await tick()
  assert.equal(transport.lastText(), 'pong')

  // 历史消息不会重复回发
  agent.ctx.emitStatus('idle')
  await tick()
  assert.equal(transport.dump().filter(entry => entry.kind === 'text').length, 1)
})

test('有界 inbox：超过 maxQueuedMessagesPerChat 如实拒绝', async () => {
  const { bridge, transport } = await setup({ maxQueuedMessagesPerChat: 2 })
  const first = await bridge.handleUserMessage(transport.injectText('一'))
  const second = await bridge.handleUserMessage(transport.injectText('二'))
  const third = await bridge.handleUserMessage(transport.injectText('三'))
  assert.equal(first.accepted, true)
  assert.equal(second.accepted, true)
  assert.equal(third.accepted, false)
  assert.equal(third.reason, 'over-queue')
  assert.match(third.reply, /在途消息过多/)
})

test('回合结束释放在途名额，队列可继续接收', async () => {
  const { bridge, transport, agents, ctx } = await setup({ maxQueuedMessagesPerChat: 1 })
  const ev1 = transport.injectText('一')
  assert.equal((await bridge.handleUserMessage(ev1)).accepted, true)
  assert.equal((await bridge.handleUserMessage(transport.injectText('二'))).accepted, false)
  const agent = agents.live.get(agents.created[0].sessionId)
  agent.ctx.emitStatus('idle')
  await tick()
  assert.equal((await bridge.handleUserMessage(transport.injectText('三'))).accepted, true)
})

test('/qq-stop 取消当前回合并清空排队（--keep 保留）', async () => {
  const { bridge, transport, agents } = await setup({ maxQueuedMessagesPerChat: 3 })
  await bridge.handleUserMessage(transport.injectText('一'))
  const agent = agents.live.get(agents.created[0].sessionId)
  const chatKey = transport.injectText('x').chatKey

  assert.equal(await bridge.stop(chatKey), true)
  assert.deepEqual(agent.cancelled, [{ kind: 'user' }])
  // 清空排队后可继续接收
  assert.equal((await bridge.handleUserMessage(transport.injectText('二'))).accepted, true)
})

test('新建/切换会话：指针落 store，老会话保留', async () => {
  const { bridge, transport, agents, store } = await setup()
  const ev = transport.injectText('一')
  await bridge.handleUserMessage(ev)
  const first = bridge.currentSession(ev.chatKey)
  const second = await bridge.newSession(ev.chatKey)
  assert.notEqual(second, first)
  assert.equal(bridge.currentSession(ev.chatKey), second)
  assert.equal(store.sessions(ev.chatKey).length, 2)
  assert.equal(agents.created.length, 2)

  const entry = await bridge.switchSession(ev.chatKey, 1)
  assert.equal(entry.sessionId, first)
  assert.equal(bridge.currentSession(ev.chatKey), first)
  assert.equal(await bridge.switchSession(ev.chatKey, 42), null)
})

test('新建/切换会话释放旧 Agent 监听：迟到的 idle 不得回发', async () => {
  const { bridge, transport, agents } = await setup()
  const ev = transport.injectText('一')
  await bridge.handleUserMessage(ev)
  const firstAgent = agents.live.get(agents.created[0].sessionId)
  assert.equal(firstAgent.ctx.listenerCount('agent/status'), 1, '首个 agent 应挂上状态监听')

  await bridge.newSession(ev.chatKey)
  assert.equal(firstAgent.ctx.listenerCount('agent/status'), 0, '新建会话必须释放旧 agent 的状态监听')
  assert.equal(firstAgent.ctx.listenerCount('session/event'), 0, '新建会话必须释放旧 agent 的事件监听')

  // 旧 agent 迟到的事件不能再用「当前」state 回发
  firstAgent.reply('旧会话的回复')
  firstAgent.ctx.emitStatus('idle')
  await tick()
  assert.equal(transport.dump().filter(entry => entry.kind === 'text').length, 0, '旧会话迟到 idle 不得回发')

  await bridge.switchSession(ev.chatKey, 1)
  assert.equal(firstAgent.ctx.listenerCount('agent/status'), 1, '切回旧会话时重新挂监听')
})

test('跨重启恢复：store 中的 sessionId 走 agents.resume', async () => {
  const { bridge, transport, store, agents } = await setup({}, { sessionPersistence: {} })
  const chatKey = transport.injectText('x').chatKey
  await store.setCurrentSession(chatKey, 'qq-old-session', { title: '旧' })

  const ev = transport.injectText('继续')
  const result = await bridge.handleUserMessage(ev)
  assert.equal(result.accepted, true)
  assert.deepEqual(agents.resumed, ['qq-old-session'])
  assert.equal(agents.created.length, 0)
  assert.equal(bridge.currentSession(chatKey), 'qq-old-session')
})

test('无 sessionPersistence 时不 resume，转为新建并告警', async () => {
  const { bridge, transport, store, agents } = await setup()
  const chatKey = transport.injectText('x').chatKey
  await store.setCurrentSession(chatKey, 'qq-gone', {})
  await bridge.handleUserMessage(transport.injectText('继续'))
  assert.equal(agents.resumed.length, 0)
  assert.equal(agents.created.length, 1)
})

test('recentChat / status / chatKeyForSession', async () => {
  const { bridge, transport, agents } = await setup()
  assert.equal(bridge.recentChat(), null)
  const ev = transport.injectText('hi', { target: { kind: 'group', groupId: 'g1' } })
  await bridge.handleUserMessage(ev)
  assert.deepEqual(bridge.recentChat(), { kind: 'group', id: 'g1', transportKind: 'mock', accountId: 'mock' })
  const sessionId = agents.created[0].sessionId
  assert.equal(bridge.chatKeyForSession(sessionId), ev.chatKey)
  assert.equal(bridge.targetForChat(ev.chatKey).groupId, 'g1')
  assert.deepEqual(bridge.status(), { chats: 1, pending: 1, sessions: 1 })
})

test('重启后审批仍能解析 session→chat 与 target（store 回落）', async () => {
  const { config, store, transport, ctx, scope } = await setup()
  const ev = transport.injectText('x')
  const chatKey = ev.chatKey
  await store.setCurrentSession(chatKey, 'qq-old-session', {})
  await store.touch(chatKey, { target: { kind: 'p2p', id: 'mock-user' } })

  // 新 bridge = 插件刚重启：runtime/sessionIndex 都是空的
  const reopened = createBridge({ ctx, config, store, transport, scope })
  assert.equal(reopened.chatKeyForSession('qq-old-session'), chatKey, '应能按 store 反查 chatKey')
  assert.deepEqual(reopened.targetForChat(chatKey), ev.target, '应能从 chatKey 还原 target')
})

test('extractAssistantText：只取新事件、兼容两种载体、拼接多块', () => {
  const events = [
    { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: '旧' }] } } },
    { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: '用户' }] } },
    { type: 'assistant/message', seq: 3, data: { content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] } },
    { type: 'assistant/message', seq: 4, data: { message: { content: [{ type: 'reasoning', text: '想' }] } } },
  ]
  assert.deepEqual(extractAssistantText(events, 1), { text: 'A\n\nB', lastSeq: 4 })
  assert.deepEqual(extractAssistantText(events, 4), { text: '', lastSeq: 4 })
  assert.equal(lastEventSeq(events), 4)
  assert.equal(lastEventSeq([]), 0)
})

test('会话级 agentOptions 透传给 create', async () => {
  const { bridge, transport, agents } = await setup({ agentOptions: { provider: 'p', model: 'm', maxTokens: 10 } })
  await bridge.handleUserMessage(transport.injectText('hi'))
  assert.deepEqual(agents.created[0].agentOptions, { provider: 'p', model: 'm', maxTokens: 10 })
})

// ── P2：agent preset 组合与恢复预检（对齐宿主 session-controller.composeAgent/createOrAdopt）──

/** 假 agentPresets 服务：记录 mount 调用。 */
function createFakePresets({ defaultId = 'preset-default', failResolve = false } = {}) {
  const mounted = []
  const resolved = []
  const presets = {
    defaultId,
    mounted,
    resolved,
    async resolve(id) {
      if (failResolve) throw new Error('preset 解析失败')
      const want = id ?? defaultId
      resolved.push(want)
      return { id: want }
    },
    async mount(agentCtx, id) {
      // 真实服务是类方法，内部用 this.retain()；解绑调用会在这里暴露
      if (this !== presets) throw new TypeError("Cannot read properties of undefined (reading 'retain')")
      mounted.push({ agentCtx, id })
    },
  }
  return presets
}

/** 假 sessionQuery：按 sessionId 返回观察（含 header.agentPreset），缺失抛 NOT_FOUND。 */
function createFakeSessionQuery(observations = {}) {
  const disposed = []
  return {
    disposed,
    async observeSession(sessionId) {
      const entry = observations[sessionId]
      if (entry === undefined) {
        const error = new Error(`session "${sessionId}" not found`)
        error.code = 'SESSION_QUERY_SESSION_NOT_FOUND'
        throw error
      }
      return {
        header: entry.header ?? {},
        [Symbol.dispose]() {
          disposed.push(sessionId)
        },
      }
    },
  }
}

test('P2：有 agentPresets 时按默认 preset 组合，并在 setup 里 mount', async () => {
  const presets = createFakePresets({ defaultId: 'preset-web' })
  const { bridge, transport, agents } = await setup({}, { agentPresets: presets })
  await bridge.handleUserMessage(transport.injectText('hi'))

  const created = agents.created[0]
  assert.equal(created.meta.agentPreset, 'preset-web', '新建会话应带默认 preset')
  assert.equal(typeof created.setup, 'function', '应传 setup 用于挂载 preset')

  const fakeAgentCtx = { id: 'agent-ctx' }
  await created.setup(fakeAgentCtx)
  assert.deepEqual(presets.mounted, [{ agentCtx: fakeAgentCtx, id: 'preset-web' }])
})

test('P2：config.agentPreset 优先于默认 preset；解析失败则降级为无 preset 并告警', async () => {
  const presets = createFakePresets({ defaultId: 'preset-web' })
  const env = await setup({ agentPreset: 'preset-qq' }, { agentPresets: presets })
  await env.bridge.handleUserMessage(env.transport.injectText('hi'))
  assert.equal(env.agents.created[0].meta.agentPreset, 'preset-qq')

  const failing = createFakePresets({ failResolve: true })
  const logger = createLogger()
  const env2 = await setup({}, { agentPresets: failing })
  void logger
  await env2.bridge.handleUserMessage(env2.transport.injectText('hi'))
  assert.equal(env2.agents.created[0].meta.agentPreset, undefined)
  assert.equal(typeof env2.agents.created[0].setup, 'function', 'preset 解析失败仍要挂提示词段')
})

test('P2：无 agentPresets 服务时创建裸会话（只挂提示词，不传 preset）', async () => {
  const { bridge, transport, agents } = await setup()
  await bridge.handleUserMessage(transport.injectText('hi'))
  assert.equal(agents.created[0].meta.agentPreset, undefined)
  assert.equal(typeof agents.created[0].setup, 'function', '没有 preset 也要挂会话提示词')
})

test('P2：查询索引未命中但 resume 失败 → 回落新建（并记录原因）', async () => {
  const sessionQuery = createFakeSessionQuery({})
  const { bridge, transport, agents, store } = await setup({}, { sessionPersistence: {}, sessionQuery })
  agents.failed.resume = 'persisted session not found'
  const chatKey = transport.injectText('x').chatKey
  await store.setCurrentSession(chatKey, 'qq-stale', {})

  await bridge.handleUserMessage(transport.injectText('继续'))
  assert.deepEqual(agents.resumed, [], 'resume 抛错时不算成功恢复')
  assert.equal(agents.created.length, 1, '应改为新建')
  assert.match(store.snapshot().meta.lastResumeError, /not found/)
})

test('P2：恢复时沿用会话原有 preset（而非当前默认），并释放观察租约', async () => {
  const presets = createFakePresets({ defaultId: 'preset-web' })
  const sessionQuery = createFakeSessionQuery({ 'qq-old': { header: { agentPreset: 'preset-stored' } } })
  const { bridge, transport, agents, store } = await setup({}, { sessionPersistence: {}, sessionQuery, agentPresets: presets })
  const chatKey = transport.injectText('x').chatKey
  await store.setCurrentSession(chatKey, 'qq-old', {})

  await bridge.handleUserMessage(transport.injectText('继续'))
  assert.deepEqual(agents.resumed, ['qq-old'])
  assert.deepEqual(presets.resolved, ['preset-stored'], '恢复应沿用会话原有 preset')
  assert.deepEqual(sessionQuery.disposed, ['qq-old'], '观察租约必须释放')
  assert.deepEqual(presets.mounted, [], 'mount 由 resume 的 setup 触发，此处未调用')
})

test('P2：不同的 QQ chat 各自独立会话，互不串上下文', async () => {
  const { bridge, transport, agents, ctx } = await setup()
  await bridge.handleUserMessage(transport.inject({ text: 'A-1', target: { kind: 'dm', userId: 'user-a' }, sender: { id: 'user-a', name: 'A' } }))
  await bridge.handleUserMessage(transport.inject({ text: 'A-2', target: { kind: 'dm', userId: 'user-a' }, sender: { id: 'user-a', name: 'A' } }))
  await bridge.handleUserMessage(transport.inject({ text: 'B-1', target: { kind: 'dm', userId: 'user-b' }, sender: { id: 'user-b', name: 'B' } }))

  assert.equal(agents.created.length, 2, '两个用户 → 两个会话')
  const [sessionA, sessionB] = agents.created.map(item => item.sessionId)
  assert.notEqual(sessionA, sessionB)
  const agentA = agents.live.get(sessionA)
  const agentB = agents.live.get(sessionB)
  assert.deepEqual(agentA.followed.map(message => message.content[0].text), ['A-1'], 'A 的第一条开回合')
  assert.deepEqual(agentA.steered.map(message => message.content[0].text), ['A-2'], 'A 的第二条 steer 进同一会话的回合')
  assert.deepEqual(agentB.followed.map(message => message.content[0].text), ['B-1'], '另一用户只有自己的消息')
  assert.equal(agentB.steered.length, 0, 'B 不受 A 在途回合影响')

  // 回复各自回到自己的 chat
  agentA.reply('给 A')
  agentA.ctx.emitStatus('idle')
  agentB.reply('给 B')
  agentB.ctx.emitStatus('idle')
  await new Promise(resolve => setTimeout(resolve, 20))
  const texts = transport.dump().filter(entry => entry.kind === 'text')
  assert.deepEqual(
    texts.map(entry => [entry.target.userId, entry.text]),
    [['user-a', '给 A'], ['user-b', '给 B']],
  )
})

// ── P5：入站媒体 → 附件入库 / 降级说明 ──

/** 假附件服务。 */
function createFakeAttachments({ failImage = false, failFile = false } = {}) {
  const saved = { images: [], files: [] }
  return {
    saved,
    async saveImage({ data, mediaType, name }) {
      if (failImage) throw new Error('图片被拒绝')
      const ref = {
        attachmentId: `img-${saved.images.length + 1}`,
        mediaType,
        bytes: data.byteLength,
        width: 2,
        height: 2,
        ...(name === undefined ? {} : { name }),
      }
      saved.images.push({ data, mediaType, name, ref })
      return ref
    },
    async saveFile({ data, name }) {
      if (failFile) throw new Error('文件被拒绝')
      const ref = { attachmentId: `file-${saved.files.length + 1}`, name: name ?? 'file', bytes: data.byteLength }
      saved.files.push({ data, name, ref })
      return ref
    },
  }
}

const mediaEvent = (transport, media, { text = '', user = 'u1' } = {}) =>
  transport.inject({
    text,
    target: { kind: 'dm', userId: user },
    sender: { id: user, name: 'U' },
    media,
  })

test('P5 图片附件：下载 → saveImage → 模型可见 image block', async () => {
  const attachments = createFakeAttachments()
  const { bridge, transport, agents } = await setup({}, { attachments })
  transport.addMedia('https://cdn.invalid/a.png', { data: Buffer.from('PNGDATA'), contentType: 'image/png' })

  await bridge.handleUserMessage(
    mediaEvent(transport, [{ kind: 'image', url: 'https://cdn.invalid/a.png', fileName: 'a.png', mime: 'image/png', size: 7 }], { text: '看看这张图' }),
  )
  const agent = agents.live.get(agents.created[0].sessionId)
  const blocks = agent.followed[0].content
  assert.deepEqual(blocks[0], { type: 'text', text: '看看这张图' })
  assert.equal(blocks[1].type, 'image')
  assert.equal(blocks[1].attachment.attachmentId, 'img-1')
  assert.equal(blocks[1].attachment.mediaType, 'image/png')
  assert.equal(attachments.saved.images[0].data.toString(), 'PNGDATA')
  assert.equal(attachments.saved.images[0].name, 'a.png')
})

test('P5 文件附件：下载 → saveFile → file block', async () => {
  const attachments = createFakeAttachments()
  const { bridge, transport, agents } = await setup({}, { attachments })
  transport.addMedia('https://cdn.invalid/r.pdf', { data: Buffer.from('%PDF-1.4'), contentType: 'application/pdf' })

  await bridge.handleUserMessage(mediaEvent(transport, [{ kind: 'file', url: 'https://cdn.invalid/r.pdf', fileName: 'r.pdf' }]))
  const blocks = agents.live.get(agents.created[0].sessionId).followed[0].content
  assert.equal(blocks[0].type, 'file')
  assert.equal(blocks[0].attachment.attachmentId, 'file-1')
  assert.equal(blocks[0].attachment.name, 'r.pdf')
})

test('P5 降级：无附件服务 / 下载失败 / 不支持的图片格式 / 入库失败，都给出可读说明', async () => {
  // ① 无 attachments 服务
  const noService = await setup()
  noService.transport.addMedia('https://cdn.invalid/a.png', { data: Buffer.from('x'), contentType: 'image/png' })
  await noService.bridge.handleUserMessage(mediaEvent(noService.transport, [{ kind: 'image', url: 'https://cdn.invalid/a.png', fileName: 'a.png', size: 2048 }]))
  const noteA = noService.agents.live.get(noService.agents.created[0].sessionId).followed[0].content[0].text
  assert.match(noteA, /图片 a\.png \(2\.0KB\)/)
  assert.match(noteA, /当前部署无法入库附件/)

  // ② 下载失败（未注册夹具）
  const attachments = createFakeAttachments()
  const downloadFail = await setup({}, { attachments })
  await downloadFail.bridge.handleUserMessage(mediaEvent(downloadFail.transport, [{ kind: 'image', url: 'https://cdn.invalid/missing.png', fileName: 'missing.png' }]))
  const noteB = downloadFail.agents.live.get(downloadFail.agents.created[0].sessionId).followed[0].content[0].text
  assert.match(noteB, /获取失败/)

  // ③ 不支持的图片格式
  const badType = await setup({}, { attachments: createFakeAttachments() })
  badType.transport.addMedia('https://cdn.invalid/x.bmp', { data: Buffer.from('x'), contentType: 'image/bmp' })
  await badType.bridge.handleUserMessage(mediaEvent(badType.transport, [{ kind: 'image', url: 'https://cdn.invalid/x.bmp', fileName: 'x.bmp' }]))
  const noteC = badType.agents.live.get(badType.agents.created[0].sessionId).followed[0].content[0].text
  assert.match(noteC, /不支持的图片格式/)

  // ④ 附件服务拒绝
  const reject = await setup({}, { attachments: createFakeAttachments({ failImage: true }) })
  reject.transport.addMedia('https://cdn.invalid/y.png', { data: Buffer.from('x'), contentType: 'image/png' })
  await reject.bridge.handleUserMessage(mediaEvent(reject.transport, [{ kind: 'image', url: 'https://cdn.invalid/y.png', fileName: 'y.png' }]))
  const noteD = reject.agents.live.get(reject.agents.created[0].sessionId).followed[0].content[0].text
  assert.match(noteD, /入库失败/)
})

test('P5 语音：QQ 内置 ASR 直接用；无转写时如实提示', async () => {
  const { bridge, transport, agents } = await setup()
  await bridge.handleUserMessage(
    mediaEvent(transport, [{ kind: 'audio', url: 'https://cdn.invalid/v.silk', fileName: 'v.silk', asrText: '帮我订张票' }], { text: '' }),
  )
  const withAsr = agents.live.get(agents.created[0].sessionId).followed[0].content[0].text
  assert.equal(withAsr, '[语音转写] 帮我订张票')

  const second = await setup()
  await second.bridge.handleUserMessage(
    mediaEvent(second.transport, [{ kind: 'audio', url: 'https://cdn.invalid/v2.silk', fileName: 'v2.silk' }], { user: 'u2' }),
  )
  const noAsr = second.agents.live.get(second.agents.created[0].sessionId).followed[0].content[0].text
  assert.equal(noAsr, '[语音消息（未启用转写）]')
})

test('P5 语音：配置了 STT 端点与 key 时走外部转写', async () => {
  const { bridge, transport, agents } = await setup(
    { stt: { provider: 'zai', baseUrl: 'https://stt.invalid/v1', model: 'glm-asr' } },
    {},
  )
  const savedKey = process.env.QQ_STT_API_KEY
  const savedFetch = globalThis.fetch
  process.env.QQ_STT_API_KEY = 'stt-key'
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return { ok: true, status: 200, json: async () => ({ text: '外部转写结果' }) }
  }
  try {
    transport.addMedia('https://cdn.invalid/v3.silk', { data: Buffer.from('silk'), contentType: 'audio/silk' })
    await bridge.handleUserMessage(mediaEvent(transport, [{ kind: 'audio', url: 'https://cdn.invalid/v3.silk', fileName: 'v3.silk' }]))
    const text = agents.live.get(agents.created[0].sessionId).followed[0].content[0].text
    assert.equal(text, '[语音转写] 外部转写结果')
    assert.equal(calls[0].url, 'https://stt.invalid/v1/audio/transcriptions')
  } finally {
    globalThis.fetch = savedFetch
    if (savedKey === undefined) delete process.env.QQ_STT_API_KEY
    else process.env.QQ_STT_API_KEY = savedKey
  }
})

test('P5 媒体数量上限：超出部分忽略并在内容里说明', async () => {
  const { bridge, transport, agents } = await setup({ maxMediaPerMessage: 2 })
  const items = [1, 2, 3, 4].map(index => ({ kind: 'image', url: `https://cdn.invalid/${index}.png`, fileName: `${index}.png` }))
  await bridge.handleUserMessage(mediaEvent(transport, items))
  const blocks = agents.live.get(agents.created[0].sessionId).followed[0].content
  const texts = blocks.filter(block => block.type === 'text').map(block => block.text)
  assert.ok(texts.some(text => /已忽略 2 个附件/.test(text)), texts.join('|'))
})

test('P5 附件超过字节上限：如实说明而不是静默丢弃', async () => {
  const attachments = createFakeAttachments()
  const { bridge, transport, agents } = await setup({ maxFileBytes: 1024 }, { attachments })
  transport.addMedia('https://cdn.invalid/big.png', { data: Buffer.alloc(2048, 1), contentType: 'image/png' })
  await bridge.handleUserMessage(mediaEvent(transport, [{ kind: 'image', url: 'https://cdn.invalid/big.png', fileName: 'big.png' }]))
  const text = agents.live.get(agents.created[0].sessionId).followed[0].content[0].text
  assert.match(text, /媒体超过上限/)
})

// ── 回归：QQ 会话必须装上 {{provider}}/{{model}} 变量（否则提示词组装直接失败） ──

test('无持久化选择时，用 DSH 默认模型安装提示词变量（修复提示词组装失败）', async () => {
  const fakeDefault = {
    currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' }),
  }
  const env = await (async () => {
    const { dir } = { dir: await mkdtemp(join(tmpdir(), 'dsh-qq-defmodel-')) }
    const config = resolveConfig({ transport: 'mock', autoConnect: false, dataDir: dir })
    const store = createStore({ dir })
    await store.load()
    const transport = createMockTransport({})
    const agents = createFakeAgents()
    const ctx = createFakeCtx({ services: { agents, agentDefaultModel: fakeDefault } })
    const scope = createResourceScope({ name: 'defmodel' })
    const bridge = createBridge({
      ctx,
      config,
      store,
      transport,
      scope,
      onAgentReady: (agent, chatKey) => {
        // 模拟 index.js 的接线：control.ensureSelection 安装默认选择
        const picked = fakeDefault.currentSelection()
        const listeners = []
        agent.ctx.on('agent/request', async (_payload, next) => {
          const resolved = await next()
          return { ...resolved, provider: picked.provider, model: picked.model, reasoningEffort: picked.reasoningEffort }
        })
        agent.ctx.on('system-prompt/assemble', async (_a, _b, next) => {
          const assembled = await next()
          return { ...assembled, variables: { ...assembled.variables, provider: picked.provider, model: picked.model } }
        })
        void chatKey
        void listeners
      },
    })
    return { bridge, transport, agents }
  })()

  await env.bridge.handleUserMessage(env.transport.injectText('hi'))
  const agent = env.agents.live.get(env.agents.created[0].sessionId)

  // 提示词变量必须可用（persona 模板引用 {{model}}）
  const assembled = await agent.ctx.runWaterfall('system-prompt/assemble', [{}, {}], async () => ({ variables: {} }))
  assert.equal(assembled.variables.model, 'deepseek-flash')
  assert.equal(assembled.variables.provider, 'deepseek-official')
})

test('回合失败时把错误如实回发 QQ（不再静默）', async () => {
  const { bridge, transport, agents, ctx } = await setup()
  await bridge.handleUserMessage(transport.injectText('ping'))
  const agent = agents.live.get(agents.created[0].sessionId)

  // 经真实接口投递：turn/end 走 session/event feed，再回到 idle
  agent.endTurn({ completed: false, error: 'prompt variable "{{model}}" has no value' })
  agent.ctx.emitStatus('idle')
  await tick(20)

  const sent = transport.dump().filter(entry => entry.kind === 'text').map(entry => entry.text)
  assert.equal(sent.length, 1)
  assert.match(sent[0], /DSH 本轮执行失败/)
  assert.match(sent[0], /\{\{model\}\}/)
})

test('extractTurnError：只取本轮、忽略成功回合与历史错误', () => {
  const events = [
    { type: 'turn/end', seq: 5, data: { reason: { kind: 'error', error: { message: '旧错误' } } } },
    { type: 'assistant/message', seq: 8, data: { message: { content: [{ type: 'text', text: 'ok' }] } } },
    { type: 'turn/end', seq: 9, data: { reason: { kind: 'completed' } } },
  ]
  assert.equal(extractTurnError(events, 5), null, '成功的 turn/end 不算失败')
  assert.equal(extractTurnError(events, 0), '旧错误')
  assert.equal(extractTurnError([{ type: 'turn/end', seq: 3, data: { reason: { kind: 'error', error: { message: 'x'.repeat(500) } } } }], 0).length, 300)
})

// ── 跨重启恢复的诊断与行为（真机：重启后新建会话而非恢复） ──

test('resume 失败：原因写入 store meta（外部可诊断），并回落到新建', async () => {
  const sessionQuery = createFakeSessionQuery({ 'qq-old': { header: {} } })
  const { bridge, transport, store, agents } = await setup({}, { sessionPersistence: {}, sessionQuery })
  agents.failed.resume = 'session "qq-old" is not durable yet'
  const ev = transport.injectText('x')
  await store.setCurrentSession(ev.chatKey, 'qq-old', {})

  await bridge.handleUserMessage(transport.injectText('继续'))
  assert.equal(agents.created.length, 1, 'resume 失败应回落新建')
  assert.match(store.snapshot().meta.lastResumeError, /not durable yet/)
  assert.equal(store.snapshot().meta.lastResumeSessionId, 'qq-old')
})

test('resume 成功：清除 lastResumeError', async () => {
  const sessionQuery = createFakeSessionQuery({ 'qq-old': { header: {} } })
  const { bridge, transport, store } = await setup({}, { sessionPersistence: {}, sessionQuery })
  const ev = transport.injectText('x')
  await store.setCurrentSession(ev.chatKey, 'qq-old', {})
  await store.setMeta({ lastResumeError: '旧故障' })

  await bridge.handleUserMessage(transport.injectText('继续'))
  assert.equal(store.snapshot().meta.lastResumeError, null, '恢复成功后应清掉诊断字段')
})

test('查询索引未命中（NOT_FOUND）不再短路：仍尝试 resume（索引可能滞后于日志）', async () => {
  const sessionQuery = createFakeSessionQuery({}) // 全部 NOT_FOUND
  const { bridge, transport, store, agents } = await setup({}, { sessionPersistence: {}, sessionQuery })
  const ev = transport.injectText('x')
  await store.setCurrentSession(ev.chatKey, 'qq-lagging', {})

  await bridge.handleUserMessage(transport.injectText('继续'))
  assert.deepEqual(agents.resumed, ['qq-lagging'], '应仍然尝试 resume')
  assert.equal(agents.created.length, 0, 'resume 成功就不该新建')
  assert.equal(store.snapshot().meta.lastResumeError, null, '成功后清空诊断')
})

test('agents.resume 必须按公开签名单参调用（真机 bug：把 ctx 当 options → cannot get property "resumeSessionId" without inject）', async () => {
  const { bridge, transport, agents, store } = await setup({}, {
    sessionPersistence: {},
    sessionQuery: createFakeSessionQuery({ 'qq-shape': { header: {} } }),
  })
  const arities = []
  const rawResume = agents.resume.bind(agents)
  agents.resume = function (...args) {
    arities.push(args.length)
    return rawResume(...args)
  }
  const ev = transport.injectText('x')
  await store.setCurrentSession(ev.chatKey, 'qq-shape', {})

  await bridge.handleUserMessage(transport.injectText('继续'))
  assert.deepEqual(arities, [1], 'resume 只能传 options 一个参数')
  assert.deepEqual(agents.resumed, ['qq-shape'])
})

// ── 回合运行中到达的消息：steer 进本回合（真机：先发文档再补一句话被"排队"） ──

test('回合运行中收到的消息直接 steer 进本回合，不再干等轮末', async () => {
  const { bridge, transport, agents } = await setup()
  await bridge.handleUserMessage(transport.injectText('[文件] 2026作业模板.doc'))
  const agent = agents.live.get(agents.created[0].sessionId)

  agent.ctx.emitStatus('running')
  const second = await bridge.handleUserMessage(transport.injectText('这个文档内容是什么'))
  assert.equal(second.accepted, true)
  assert.equal(agent.followed.length, 1, '第一条按 followup 开回合')
  assert.equal(agent.steered.length, 1, '运行中的第二条应 steer 进本回合')
  assert.deepEqual(agent.steered[0].content, [{ type: 'text', text: '这个文档内容是什么' }])
  assert.equal(agents.created.length, 1, '不应新建会话')
})

test('midTurnDelivery=queue：保留旧行为（运行中也走 followup 独占回合）', async () => {
  const { bridge, transport, agents } = await setup({ midTurnDelivery: 'queue' })
  await bridge.handleUserMessage(transport.injectText('一'))
  const agent = agents.live.get(agents.created[0].sessionId)
  agent.ctx.emitStatus('running')

  await bridge.handleUserMessage(transport.injectText('二'))
  assert.equal(agent.steered.length, 0, 'queue 模式不得 steer')
  assert.equal(agent.followed.length, 2)
})

test('steer 不泄漏在途名额：消息被消费即释放，轮末也释放', async () => {
  const { bridge, transport, agents } = await setup({ maxQueuedMessagesPerChat: 2 })
  await bridge.handleUserMessage(transport.injectText('一'))
  const agent = agents.live.get(agents.created[0].sessionId)
  agent.ctx.emitStatus('running')

  assert.equal((await bridge.handleUserMessage(transport.injectText('二'))).accepted, true, 'steer 计入在途')
  const third = await bridge.handleUserMessage(transport.injectText('三'))
  assert.equal(third.accepted, false, '未被消费时上限仍然生效（配额不能被绕过）')
  assert.equal(third.reason, 'over-queue')

  // 被 steer 的消息在下一个步边界被模型消费：会话补一条 user/message
  agent.session.append('user/message', { id: 'm-二', role: 'user', content: [{ type: 'text', text: '二' }] })
  assert.equal((await bridge.handleUserMessage(transport.injectText('三'))).accepted, true, '消费后必须立即释放名额')

  agent.ctx.emitStatus('idle')
  await tick()
  assert.equal((await bridge.handleUserMessage(transport.injectText('四'))).accepted, true, '轮末也必须释放')
})

test('回归：一轮里连发 10 条不会被误判「在途消息过多」（真机丢过第 9 条）', async () => {
  // 真机 2026-09-24：一轮里连发 10 条，第 9 条被拒。原因是 steered 只增不减
  // （只在轮末清零），pending 1 + steered 7 = 8 正好撞上默认上限。
  const { bridge, transport, agents } = await setup()
  assert.equal((await bridge.handleUserMessage(transport.injectText('1'))).accepted, true)
  const agent = agents.live.get(agents.created[0].sessionId)
  agent.ctx.emitStatus('running')

  for (let index = 2; index <= 10; index += 1) {
    const result = await bridge.handleUserMessage(transport.injectText(String(index)))
    assert.equal(result.accepted, true, `第 ${index} 条必须被接收（真机上第 9 条就是这样丢的）`)
    // 复刻真机：这条 steer 消息在下一个步边界被消费
    agent.session.append('user/message', { id: `m-${index}`, role: 'user', content: [{ type: 'text', text: String(index) }] })
  }
  assert.equal(agent.steered.length, 9)
})

test('steer 的回复仍走同一回合的缓冲（轮末一次性回发）', async () => {
  const { bridge, transport, agents } = await setup()
  await bridge.handleUserMessage(transport.injectText('一'))
  const agent = agents.live.get(agents.created[0].sessionId)
  agent.ctx.emitStatus('running')
  await bridge.handleUserMessage(transport.injectText('二'))
  agent.reply('两条一起答')
  agent.ctx.emitStatus('idle')
  await tick()
  assert.equal(transport.lastText(), '两条一起答')
  assert.equal(transport.dump().filter(entry => entry.kind === 'text').length, 1, '本回合只回发一条')
})

test('连续发送：第二条在第一条媒体下载期间到达 → 仍进入同一回合（不各自开回合、不排错序）', async () => {
  const attachments = {
    async saveFile() {
      return { id: 'att-doc', kind: 'file' }
    },
    async saveImage() {
      return { id: 'att-img', kind: 'image' }
    },
  }
  const { bridge, transport, agents } = await setup({}, { attachments })

  // 媒体下载卡住：模拟「先发 2026作业模板.doc，再补一句『这个文档内容是什么』」
  let release = () => {}
  const gate = new Promise(resolve => {
    release = resolve
  })
  transport.downloadMedia = async () => {
    await gate
    return { ok: true, data: Buffer.from('doc-bytes'), contentType: 'application/msword' }
  }

  const first = bridge.handleUserMessage(
    transport.inject({ text: '', media: [{ kind: 'file', url: 'https://example.invalid/2026.doc', fileName: '2026作业模板.doc' }] }),
  )
  await tick(5) // 第一条已进入 buildContent 并挂在下载上
  const second = bridge.handleUserMessage(transport.injectText('这个文档内容是什么'))
  await tick(5)
  release()

  assert.deepEqual(await first, { accepted: true })
  assert.deepEqual(await second, { accepted: true })

  const agent = agents.live.get(agents.created[0].sessionId)
  assert.equal(agents.created.length, 1, '只创建一个会话')
  assert.equal(agent.followed.length, 1, '只有第一条开回合')
  assert.equal(agent.steered.length, 1, '第二条 steer 进这个回合')
  assert.deepEqual(agent.steered[0].content, [{ type: 'text', text: '这个文档内容是什么' }])
  assert.equal(agent.followed[0].content.some(block => block.type === 'file'), true, '第一条带着文档入库')
})

test('连续发送：入站按到达顺序串行投递（先到先投）', async () => {
  const { bridge, transport, agents } = await setup()
  const order = []
  const first = bridge.handleUserMessage(transport.injectText('一')).then(result => {
    order.push('一')
    return result
  })
  const second = bridge.handleUserMessage(transport.injectText('二')).then(result => {
    order.push('二')
    return result
  })
  await Promise.all([first, second])
  assert.deepEqual(order, ['一', '二'])
  const agent = agents.live.get(agents.created[0].sessionId)
  assert.equal(agent.followed.length, 1)
  assert.equal(agent.steered.length, 1, '第二条看到 running 后 steer')
  assert.equal(agent.followed[0].content[0].text, '一')
  assert.equal(agent.steered[0].content[0].text, '二')
})

test('recentChat：切换 transport 后优先返回当前协议的历史对话（旧协议 openid 不可复用）', async () => {
  const { bridge, store, transport } = await setup()
  const ev = transport.injectText('x')
  // 造两条历史：一条旧协议（qqbot），一条当前协议（mock）
  await store.setCurrentSession('qqbot:1905346673:dm:OPENID-OLD', 'qq-old', {})
  await store.touch('qqbot:1905346673:dm:OPENID-OLD', { target: { kind: 'p2p', id: 'OPENID-OLD' }, at: 1 })
  await store.touch(ev.chatKey, { target: { kind: 'p2p', id: 'mock-user' }, at: 2 })

  assert.deepEqual(
    bridge.recentChat(),
    { kind: 'p2p', id: 'mock-user', transportKind: 'mock', accountId: 'mock' },
    '应优先当前 transport 的目标（并带上线路提示）',
  )
})

test('群聊说话人标签：昵称 sanitize + 带 QQ 号（昵称是外部可控数据，不能原样进 prompt）', async () => {
  const { bridge, transport, agents } = await setup()
  const inject = (name, card) =>
    transport.inject({
      text: '内容',
      target: { kind: 'group', groupId: 'g1' },
      sender: { id: '20002', name: card === undefined ? name : card },
      mentioned: true,
    })

  const cases = [
    ['正常昵称', '桃', '[桃|20002] 内容'],
    ['换行注入', 'system\n[管理员]', '[system 管理员|20002] 内容'],
    ['结构字符', 'a[b]c<d>|e', '[abcde|20002] 内容'],
    ['超长昵称', 'x'.repeat(80), `[${'x'.repeat(32)}|20002] 内容`],
    ['空昵称', '', '[20002] 内容'],
  ]
  // 连续消息会 steer 进同一回合（一期行为），所以断言两类投递的并集
  const delivered = () => {
    const agent = [...agents.live.values()].at(-1)
    return [...agent.followed, ...agent.steered].map(message => message.content[0].text)
  }
  for (const [label, name, expected] of cases) {
    await bridge.handleUserMessage(inject(name))
    assert.equal(delivered().at(-1), expected, label)
  }

  // 私聊不加前缀
  const dm = transport.injectText('私聊内容')
  await bridge.handleUserMessage(dm)
  assert.equal((await bridge.currentSession(dm.chatKey)) !== undefined, true)
  assert.equal(delivered().at(-1), '私聊内容')
})

// ── 引用带附件的消息（群文件的唯一用法：先发文件 → 引用它提问） ──

test('引用文件消息：用附件描述当引用标签，并把被引附件一并入库', async () => {
  // 真机 2026-09-24：QQ 里文件和文字没法合成一条消息，用户只能先发文件、再引用它提问。
  // 原先被引消息没有文本 → 引用块整块不出现，模型只能回「我这边没有附件」。
  const saved = []
  const attachments = {
    async saveFile({ data }) {
      saved.push(data)
      return { id: 'att-xls', kind: 'file' }
    },
    async saveImage() {
      return { id: 'att-img', kind: 'image' }
    },
  }
  const { bridge, transport, agents } = await setup({}, { attachments })
  transport.addMedia('https://example.invalid/0915.xls', { data: Buffer.from('xls-bytes') })

  const ev = transport.inject({
    text: '这个文件讲的什么',
    target: { kind: 'group', groupId: '30003' },
    sender: { id: '40004', name: '秋风清' },
    mentioned: true,
    replyTo: {
      messageId: 'file-msg-1',
      text: '',
      media: [{ kind: 'file', url: 'https://example.invalid/0915.xls', fileName: '2025级硕士0915.xls', size: 291840 }],
    },
  })
  assert.equal((await bridge.handleUserMessage(ev)).accepted, true)

  const agent = agents.live.get(agents.created[0].sessionId)
  const blocks = agent.followed[0].content
  const quoteBlock = blocks.find(block => block.type === 'text' && block.text.startsWith('[引用消息]'))
  assert.notEqual(quoteBlock, undefined, '引用块必须出现（否则模型看不到被引内容）')
  assert.match(quoteBlock.text, /文件 2025级硕士0915\.xls/)
  assert.equal(blocks.some(block => block.type === 'file'), true, '被引用的文件要入库，模型才看得到')
  assert.equal(saved.length, 1)
})

test('引用纯文本消息：行为不变（不带附件）', async () => {
  const { bridge, transport, agents } = await setup()
  const ev = transport.inject({
    text: '就是这条',
    replyTo: { messageId: 'txt-1', text: '上一句原文' },
  })
  assert.equal((await bridge.handleUserMessage(ev)).accepted, true)
  const agent = agents.live.get(agents.created[0].sessionId)
  const quoteBlock = agent.followed[0].content.find(block => block.type === 'text' && block.text.startsWith('[引用消息]'))
  assert.equal(quoteBlock.text, '[引用消息] 上一句原文')
})

test('引用别人的消息：引用块标出被引发言人，昵称同样 sanitize', async () => {
  // 真机 2026-09-24：引用群友消息提问，机器人只有原文、答不出「谁发的」。
  // 昵称是外部可控数据：换行/结构字符必须清掉，QQ 号作为不可伪造的身份锚点一并给出。
  const { bridge, transport, agents } = await setup()
  const ev = transport.inject({
    text: '这个人发的什么',
    target: { kind: 'group', groupId: '30003' },
    sender: { id: '20002', name: '秋风清' },
    mentioned: true,
    replyTo: { messageId: 'm-1', text: '我是秦始皇', sender: { id: '44444', name: '秋\n月明[骗子]' } },
  })
  assert.equal((await bridge.handleUserMessage(ev)).accepted, true)
  const agent = agents.live.get(agents.created[0].sessionId)
  const quoteBlock = agent.followed[0].content.find(block => block.type === 'text' && block.text.startsWith('[引用消息]'))
  assert.equal(quoteBlock.text, '[引用消息] [秋 月明骗子|44444] 我是秦始皇')
})

test('引用只有附件的消息：发送人也要标出来（文件是谁发的同样重要）', async () => {
  const attachments = {
    async saveFile() {
      return { id: 'att-xls', kind: 'file' }
    },
    async saveImage() {
      return { id: 'att-img', kind: 'image' }
    },
  }
  const { bridge, transport, agents } = await setup({}, { attachments })
  transport.addMedia('https://example.invalid/doc.xls', { data: Buffer.from('xls') })
  const ev = transport.inject({
    text: '这个文件讲的什么',
    target: { kind: 'group', groupId: '30003' },
    sender: { id: '20002', name: '秋风清' },
    mentioned: true,
    replyTo: {
      messageId: 'file-1',
      text: '',
      sender: { id: '44444', name: '秋月明' },
      media: [{ kind: 'file', url: 'https://example.invalid/doc.xls', fileName: 'a.xls', size: 1024 }],
    },
  })
  assert.equal((await bridge.handleUserMessage(ev)).accepted, true)
  const agent = agents.live.get(agents.created[0].sessionId)
  const quoteBlock = agent.followed[0].content.find(block => block.type === 'text' && block.text.startsWith('[引用消息]'))
  assert.match(quoteBlock.text, /^\[引用消息\] \[秋月明\|44444\] 文件 a\.xls/)
})

// ── 纯文本渠道（个人 QQ / Mock：不渲染 Markdown、无卡片） ──
test('toPlainText：去掉 Markdown/卡片语法，保留内容与顺序', () => {
  const markdown = [
    '**重点**：这次成功了 🎉',
    '',
    '### 观测点',
    '- 原文：`msg-1`',
    '',
    '| 项 | 结果 |',
    '| --- | --- |',
    '| 引用 | ✅ |',
    '',
    '见 [文档](https://example.com/a)。',
    '',
    '```js',
    'const a = 1',
    '```',
  ].join('\n')
  const plain = toPlainText(markdown)
  assert.equal(plain.includes('**'), false, '不得残留加粗标记')
  assert.equal(plain.includes('###'), false, '不得残留标题标记')
  assert.equal(plain.includes('`'), false, '不得残留反引号')
  assert.equal(plain.includes('| --- |'), false, '不得残留表格分隔行')
  assert.equal(plain.includes(']('), false, '不得残留 markdown 链接语法')
  assert.match(plain, /重点：这次成功了/)
  assert.match(plain, /观测点/)
  assert.match(plain, /const a = 1/, '代码内容必须保留')
  assert.match(plain, /文档（https:\/\/example\.com\/a）/)
  assert.equal(plain.indexOf('重点'), 0, '顺序不变')
})

test('toPlainText：dsh-ui 卡片围栏整块删除（纯文本渠道里只剩 JSON）', () => {
  const text = '好的，看这张卡片：\n\n```dsh-ui\n{"title":"测试","items":[{"type":"table"}]}\n```\n\n以上。'
  const plain = toPlainText(text)
  assert.equal(plain.includes('dsh-ui'), false)
  assert.equal(plain.includes('"items"'), false)
  assert.equal(plain, '好的，看这张卡片：\n\n以上。')
  // 整条只有卡片时返回空串（由 bridge 回一句可读说明，不静默发空消息）
  assert.equal(toPlainText('```dsh-ui\n{"a":1}\n```'), '')
})

test('无 Markdown 能力的渠道：回复自动纯文本化并带上渠道提示段', async () => {
  const { bridge, transport, agents } = await setup({}, {}, { capabilities: { markdown: false } })
  await bridge.handleUserMessage(transport.injectText('ping'))
  const agent = agents.live.get(agents.created[0].sessionId)

  // ① 系统提示词里出现「本渠道纯文本」的说明（从源头少生成 Markdown 与卡片）
  const assembled = await agent.ctx.runWaterfall('system-prompt/assemble', [{}, {}], async () => ({ sections: [], variables: {} }))
  const note = assembled.sections.find(section => section.name === 'dsh-qq/channel-plaintext')
  assert.notEqual(note, undefined, '纯文本渠道必须提示模型')
  assert.match(note.text, /不渲染 Markdown/)
  assert.equal(note.interpolate, false, '提示文本不得被变量插值改写')

  // ② 回复里的 Markdown 被降级；dsh-ui 卡片不发给用户
  agent.reply('**完成**：\n\n```dsh-ui\n{"title":"x"}\n```\n\n细节见 [说明](https://example.com)。')
  agent.ctx.emitStatus('idle')
  await tick()
  const sent = transport.lastText()
  assert.equal(sent.includes('**'), false)
  assert.equal(sent.includes('dsh-ui'), false)
  assert.match(sent, /完成/)
  assert.match(sent, /说明（https:\/\/example\.com）/)
})

test('有 Markdown 能力的渠道（官方 QQBot）：Markdown 原样发送，但 dsh-ui 围栏必须剥掉', async () => {
  const { bridge, transport, agents } = await setup({}, {}, { capabilities: { markdown: true } })
  await bridge.handleUserMessage(transport.injectText('ping'))
  const agent = agents.live.get(agents.created[0].sessionId)
  const assembled = await agent.ctx.runWaterfall('system-prompt/assemble', [{}, {}], async () => ({ sections: [], variables: {} }))
  // 官方 QQBot 能渲染 Markdown，所以不加纯文本提示；但必须告诉模型 dsh-ui 围栏在 QQ 里不渲染
  assert.equal(assembled.sections.some(section => section.name === 'dsh-qq/channel-plaintext'), false)
  const uiNote = assembled.sections.find(section => section.name === 'dsh-qq/channel-markdown')
  assert.notEqual(uiNote, undefined, 'Markdown 渠道也要提示模型不要输出 dsh-ui 围栏')
  assert.match(uiNote.text, /dsh-ui/)

  // 普通 Markdown 照旧；dsh-ui 围栏整块删除（否则 QQ 里显示成一大段 JSON 代码块）
  agent.reply('**加粗照旧**\n\n```dsh-ui\n{"gap":14,"items":[]}\n```')
  agent.ctx.emitStatus('idle')
  await tick()
  const sent = transport.lastText()
  assert.equal(sent, '**加粗照旧**', 'Markdown 保留，围栏剥离')
  assert.equal(sent.includes('dsh-ui'), false)
  assert.equal(sent.includes('"gap"'), false)
})

test('stripDshUiFences：多段围栏、围栏在中间、只有围栏', () => {
  const mixed = '前文\n\n```dsh-ui\n{"a":1}\n```\n\n中间\n\n```dsh-ui\n{"b":2}\n```\n\n后文'
  assert.equal(stripDshUiFences(mixed), '前文\n\n中间\n\n后文')
  assert.equal(stripDshUiFences('```dsh-ui\n{"a":1}\n```'), '')
  assert.equal(stripDshUiFences('没有围栏'), '没有围栏')
})

test('Markdown 渠道：只有卡片时把卡片内容摘成文字版发出去', async () => {
  const { bridge, transport, agents } = await setup({}, {}, { capabilities: { markdown: true } })
  await bridge.handleUserMessage(transport.injectText('ping'))
  const agent = agents.live.get(agents.created[0].sessionId)
  agent.reply('```dsh-ui\n{"title":"评审结论","items":[{"type":"callout","title":"建议","content":"Major Revision"},{"type":"table","columns":["维度","分数"],"rows":[["证据","2 / 5"]]}]}\n```')
  agent.ctx.emitStatus('idle')
  await tick()
  const sent = transport.lastText()
  assert.match(sent, /评审结论/)
  assert.match(sent, /Major Revision/)
  assert.match(sent, /证据 ｜ 2 \/ 5/, '表格要转成可读的竖线分隔文本')
  assert.equal(sent.includes('dsh-ui'), false)
})

test('只有无法解析的卡片围栏时，回一句可读说明而不是空消息/JSON', async () => {
  const { bridge, transport, agents } = await setup({}, {}, { capabilities: { markdown: true } })
  await bridge.handleUserMessage(transport.injectText('ping'))
  const agent = agents.live.get(agents.created[0].sessionId)
  agent.reply('```dsh-ui\n{不是合法 JSON}\n```')
  agent.ctx.emitStatus('idle')
  await tick()
  assert.match(transport.lastText(), /只有卡片内容/)
})

test('dshUiFencesToText：callout / 表格 / 步骤 / 列表转文字', () => {
  const spec = {
    title: '总览',
    items: [
      { type: 'callout', title: '结论', content: '可以成立' },
      { type: 'table', columns: ['A', 'B'], rows: [['1', '2']] },
      { type: 'steps', steps: [{ title: '第一步', desc: '先跑基线' }, { title: '第二步' }] },
      { type: 'list', items: ['要点一', '要点二'] },
    ],
  }
  const text = dshUiFencesToText('```dsh-ui\n' + JSON.stringify(spec) + '\n```')
  assert.match(text, /总览/)
  assert.match(text, /结论/)
  assert.match(text, /可以成立/)
  assert.match(text, /A ｜ B/)
  assert.match(text, /1 ｜ 2/)
  assert.match(text, /第一步：先跑基线/)
  assert.match(text, /2\. 第二步/)
  assert.match(text, /• 要点一/)
})

test('纯文本渠道：只有卡片时同样发文字版（不静默发空消息）', async () => {
  const { bridge, transport, agents } = await setup({}, {}, { capabilities: { markdown: false } })
  await bridge.handleUserMessage(transport.injectText('ping'))
  const agent = agents.live.get(agents.created[0].sessionId)
  agent.reply('```dsh-ui\n{"title":"结论","items":[{"type":"callout","content":"没删干净"}]}\n```')
  agent.ctx.emitStatus('idle')
  await tick()
  const sent = transport.lastText()
  assert.match(sent, /没删干净/)
  assert.equal(sent.includes('dsh-ui'), false)
})

// ── 群记忆：长期笔记 + 「上次之后」的群消息注入（零额外 LLM 调用） ──

test('群会话：注入「群记忆 + 群最近消息」，且在用户消息之前；私聊不注入', async () => {
  const calls = []
  const ambientContext = async ev => {
    calls.push(ev.chatKey)
    return { notes: '- 群里管群主叫「堂主」', recent: '12:00 [秋月明|44444] 我是秦始皇', omitted: 3 }
  }
  const { bridge, transport, agents } = await setup({}, {}, {}, { ambientContext })

  const groupEv = transport.inject({
    text: '堂主是谁',
    target: { kind: 'group', groupId: '30003' },
    sender: { id: '20002', name: '秋风清' },
    mentioned: true,
  })
  await bridge.handleUserMessage(groupEv)
  const groupBlocks = agents.live.get(agents.created[0].sessionId).followed[0].content
  assert.equal(groupBlocks[0].type, 'text')
  assert.match(groupBlocks[0].text, /^\[群记忆\]\n- 群里管群主叫「堂主」$/)
  assert.equal(groupBlocks[1].type, 'text')
  assert.match(groupBlocks[1].text, /^\[群最近消息（含未 @ 你的）\]\n12:00 \[秋月明\|44444\] 我是秦始皇\n（更早还有 3 条未显示）$/)
  assert.match(groupBlocks.at(-1).text, /堂主是谁/, '用户消息必须在上下文之后')
  assert.deepEqual(calls, [groupEv.chatKey])

  const dm = transport.inject({ text: '私聊不该有群上下文', target: { kind: 'dm', userId: '777' }, sender: { id: '777', name: 'D' } })
  await bridge.handleUserMessage(dm)
  assert.deepEqual(calls, [groupEv.chatKey], '私聊不得调用群上下文')
  const dmBlocks = agents.live.get(agents.created[1].sessionId).followed[0].content
  assert.equal(dmBlocks.length, 1)
})

test('群上下文取不到时照常回答（增强项失败不得丢消息）', async () => {
  const ambientContext = async () => {
    throw new Error('模拟群记忆故障')
  }
  const { bridge, transport, agents } = await setup({}, {}, {}, { ambientContext })
  const ev = transport.inject({
    text: '还在吗',
    target: { kind: 'group', groupId: '30003' },
    sender: { id: '20002', name: '秋风清' },
    mentioned: true,
  })
  assert.deepEqual(await bridge.handleUserMessage(ev), { accepted: true })
  assert.match(agents.live.get(agents.created[0].sessionId).followed[0].content[0].text, /还在吗/)
})

test('群会话系统提示：告知「群记忆 / 群最近消息」来源与 qq_group_note 用法；私聊不加', async () => {
  const { bridge, transport, agents } = await setup()
  const groupEv = transport.inject({
    text: 'hi',
    target: { kind: 'group', groupId: '30003' },
    sender: { id: '20002', name: '秋风清' },
    mentioned: true,
  })
  await bridge.handleUserMessage(groupEv)
  const groupAgent = agents.live.get(agents.created[0].sessionId)
  const assembled = await groupAgent.ctx.runWaterfall('system-prompt/assemble', [{}, {}], async () => ({ sections: [], variables: {} }))
  const note = assembled.sections.find(section => section.name === 'dsh-qq/group-memory')
  assert.notEqual(note, undefined, '群会话必须拿到群记忆提示')
  assert.match(note.text, /qq_group_note/)
  assert.match(note.text, /不要把它写进 daily \/ project \/ key 记忆/)

  const dm = transport.inject({ text: 'hi', target: { kind: 'dm', userId: '888' }, sender: { id: '888', name: 'D' } })
  await bridge.handleUserMessage(dm)
  const dmAgent = agents.live.get(agents.created[1].sessionId)
  const dmAssembled = await dmAgent.ctx.runWaterfall('system-prompt/assemble', [{}, {}], async () => ({ sections: [], variables: {} }))
  assert.equal(dmAssembled.sections.some(section => section.name === 'dsh-qq/group-memory'), false, '私聊不需要群记忆提示')
})

test('群记忆关闭时：不注入、不加系统提示', async () => {
  // 用真实模块 + 与 index.js 同款的接线，验证「关闭」这条路真的通（不是靠假的 provider 装样子）
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-gm-off-'))
  const config = resolveConfig({ transport: 'mock', dataDir: dir, groupMemory: { enabled: false } })
  const memory = createGroupMemory({ dir, config, logger: createLogger() })
  const ambientContext = async ev => ({
    notes: await memory.notesOf(ev.chatKey),
    recent: memory.pendingContext(ev.chatKey).text,
    omitted: 0,
  })
  const { bridge, transport, agents } = await setup({ groupMemory: { enabled: false } }, {}, {}, { ambientContext })
  const ev = transport.inject({
    text: 'hi',
    target: { kind: 'group', groupId: '30003' },
    sender: { id: '20002', name: '秋风清' },
    mentioned: true,
  })
  await bridge.handleUserMessage(ev)
  const agent = agents.live.get(agents.created[0].sessionId)
  assert.equal(agent.followed[0].content.length, 1, '关闭后不得注入群上下文')
  const assembled = await agent.ctx.runWaterfall('system-prompt/assemble', [{}, {}], async () => ({ sections: [], variables: {} }))
  assert.equal(assembled.sections.some(section => section.name === 'dsh-qq/group-memory'), false)
})


test('回合失败若被判定为「模型不可用」，消息里追加可执行的下一步提示', async () => {
  // onTurnError 由 index 接 control.recoverFromModelFailure；这里用假的回调验证 bridge 的接线
  const calls = []
  const { bridge, transport, agents } = await setup({}, {}, {}, {
    onTurnError: async (chatKey, failure) => {
      calls.push({ chatKey, failure })
      return '（已回退到 DSH 全局默认：请再发一次）'
    },
  })
  await bridge.handleUserMessage(transport.injectText('ping'))
  const agent = agents.live.get(agents.created[0].sessionId)
  agent.endTurn({ completed: false, error: 'llm-deepseek: no API key for provider route "deepseek-official"' })
  agent.ctx.emitStatus('idle')
  await tick(30)

  assert.equal(calls.length, 1)
  assert.match(calls[0].failure, /no API key/)
  const sent = transport.dump().filter(entry => entry.kind === 'text').map(entry => entry.text)
  assert.match(sent[0], /DSH 本轮执行失败/)
  assert.match(sent[0], /已回退到 DSH 全局默认/, '失败消息要带上可执行的下一步')
})

test('已存在的活会话每轮都重新套用当前模型选择（否则配置改了选择还停在旧值）', async () => {
  const calls = []
  const { bridge, transport, agents } = await setup({}, {}, {}, {
    onAgentReady: (agent, chatKey) => calls.push({ chatKey, session: agent.session.id }),
  })
  await bridge.handleUserMessage(transport.injectText('一'))
  const agent = agents.live.get(agents.created[0].sessionId)
  agent.ctx.emitStatus('idle')
  await tick()
  await bridge.handleUserMessage(transport.injectText('二'))
  assert.equal(calls.length, 2, '新建（resume/create）与复用（已活着）两条路径都要套用')
  assert.equal(calls[0].session, calls[1].session, '同一个会话')
})


test('token 用量：assistant/message 的 usage 按对话记账（一轮多步累加）', async () => {
  const { bridge, transport, agents, store } = await setup({}, {}, { capabilities: { markdown: true } })
  await bridge.handleUserMessage(transport.injectText('ping'))
  const agent = agents.live.get(agents.created[0].sessionId)
  agent.reply('第一步', 900, { inputTokens: 100, outputTokens: 40, totalTokens: 140 })
  agent.reply('第二步', 901, { inputTokens: 20, outputTokens: 10 })
  agent.ctx.emitStatus('idle')
  await tick()

  const report = store.usageReport({ days: 30 })
  assert.equal(report.totals.today.turns, 2, '两条 assistant 消息都记账')
  assert.equal(report.totals.today.input, 120)
  assert.equal(report.totals.today.output, 50)
  assert.equal(report.totals.today.total, 170, 'totalTokens 缺省时用输入+输出')
  assert.equal(report.chats.length, 1)
  assert.match(report.chats[0].chatKey, /^mock:/, '归属到该对话的 chatKey')
  assert.equal(report.chats[0].turns, 2)
})

test('会话提示词：setup 注册动态 section，保存后下一回合立即生效', async () => {
  const { bridge, transport, agents, store } = await setup({}, {}, { capabilities: { markdown: true } })
  await bridge.handleUserMessage(transport.injectText('ping'))
  const createdAgent = agents.created[0]
  assert.equal(typeof createdAgent.setup, 'function', 'create 必须带 setup（挂 prompt section）')

  const sections = []
  const agentCtx = {
    systemPrompt: {
      section: section => { sections.push(section); return () => {} },
      getSectionOrder: () => 100,
    },
  }
  await createdAgent.setup(agentCtx, {})
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'dsh-qq:chat-prompt')
  assert.equal(sections[0].text(), '', '未设置时不注入')

  const chatKey = store.chatKeys()[0]
  await store.setDefaultPrompt('你是群助手')
  assert.equal(sections[0].text(), '你是群助手', '动态函数：默认值立即生效')
  await store.setChatPrompt(chatKey, '这个群只聊技术')
  assert.equal(sections[0].text(), '这个群只聊技术', '对话覆盖优先，且无需重建会话')
})
