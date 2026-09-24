import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, getPluginHandle } from '../lib/index.js'
import { startFakeQQServer } from './helpers/fake-qq-server.js'
import { createFakeAgents, createFakeCtx, createLogger } from './helpers/fake-ctx.js'

const tick = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms))

/** 取出 QQ 消息体里的文本（markdown 模式放在 body.markdown.content）。 */
const textOf = body => (typeof body?.content === 'string' ? body.content : body?.markdown?.content ?? '')
/** 被动回复引用：markdown 模式用 msg_id，纯文本用 message_reference。 */
const replyRefOf = body => body?.msg_id ?? body?.message_reference?.message_id ?? null

/**
 * P1 验收：真协议端到端（假 QQ 服务）——
 * QQ 侧发消息 → WebSocket dispatch → qqbot transport 归一化 → router → bridge →
 * Agent 回复 → agent/status idle → REST 回发到 QQ。
 */
async function setup({ configOverrides = {}, services = {} } = {}) {
  const server = await startFakeQQServer({ heartbeatIntervalMs: 200 })
  const saved = { id: process.env.QQ_APP_ID, secret: process.env.QQ_CLIENT_SECRET }
  process.env.QQ_APP_ID = 'app-e2e'
  process.env.QQ_CLIENT_SECRET = 'secret-e2e'
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-e2e-'))
  const agents = createFakeAgents()
  const logger = createLogger()
  const ctx = createFakeCtx({
    services: {
      agents,
      ...services,
      // 测试注入口：把 qqbot transport 指向假 QQ 服务
      dshQqTransportDeps: {
        socketFactory: server.socketFactory,
        apiBase: server.apiBase,
        tokenUrl: server.tokenUrl,
        backoffMs: [10, 10, 10],
      },
    },
    logger,
  })
  await apply(ctx, {
    transport: 'qqbot',
    autoConnect: true,
    dataDir: dir,
    ...configOverrides,
  })
  const plugin = getPluginHandle(ctx)
  await plugin.ready
  await tick(50)
  const restore = () => {
    if (saved.id === undefined) delete process.env.QQ_APP_ID
    else process.env.QQ_APP_ID = saved.id
    if (saved.secret === undefined) delete process.env.QQ_CLIENT_SECRET
    else process.env.QQ_CLIENT_SECRET = saved.secret
  }
  return { server, plugin, agents, ctx, logger, dir, restore }
}

const cleanup = async ({ server, ctx, restore }) => {
  await ctx.dispose()
  await server.close()
  restore()
}

test('端到端：QQ 私聊 ping → DSH 会话 → 回复经 REST 回到 QQ', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  assert.equal(env.plugin.transport.status().phase, 'connected', '应已连上假 QQ 网关')

  // QQ 用户（owner）发一条私聊消息
  await env.plugin.store.setHomeChannel('openid-owner')
  env.server.pushDispatch('C2C_MESSAGE_CREATE', {
    id: 'qq-msg-1',
    content: 'ping',
    timestamp: '1700000000',
    author: { user_openid: 'openid-owner', username: '小明' },
  })
  await tick(50)

  assert.equal(env.agents.created.length, 1, '应创建一个 DSH 会话')
  const agent = env.agents.live.get(env.agents.created[0].sessionId)
  assert.equal(agent.followed.length, 1)
  assert.deepEqual(agent.followed[0].content, [{ type: 'text', text: 'ping' }])

  // DSH 回合结束 → 回复回发 QQ
  agent.reply('pong')
  agent.ctx.emitStatus('idle')
  await tick(60)

  const sent = env.server.lastRest('/v2/users/openid-owner/messages')
  assert.ok(sent !== null, '应通过 REST 把回复发回 QQ')
  assert.equal(textOf(sent.body), 'pong')
  assert.ok([0, 2].includes(sent.body.msg_type), 'msg_type 应为纯文本 0 或 markdown 2')
  assert.equal(sent.headers.authorization.startsWith('QQBot token-'), true)
})

test('端到端：QQ 里 /qq-help 由 router 直接回复，不创建会话', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  await env.plugin.store.setHomeChannel('openid-owner')

  env.server.pushDispatch('C2C_MESSAGE_CREATE', {
    id: 'qq-msg-2',
    content: '/qq-help',
    author: { user_openid: 'openid-owner', username: '小明' },
  })
  await tick(60)

  assert.equal(env.agents.created.length, 0, '控制命令不得创建会话/进入 LLM')
  const sent = env.server.lastRest('/v2/users/openid-owner/messages')
  assert.ok(sent !== null)
  assert.match(textOf(sent.body), /dsh-qq 命令/)
  // 被动回复带 message_reference（引用触发消息）
  assert.equal(replyRefOf(sent.body), 'qq-msg-2', '被动回复应引用触发消息')
})

test('端到端：群 @ 消息按 group 路径回复；未 @ 忽略', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  await env.plugin.store.addAuthorized('member-1', { role: 'owner' })

  env.server.pushDispatch('GROUP_AT_MESSAGE_CREATE', {
    id: 'qq-msg-3',
    content: '你好',
    group_openid: 'group-1',
    author: { member_openid: 'member-1' },
  })
  await tick(60)
  assert.equal(env.agents.created.length, 1)
  const agent = env.agents.live.get(env.agents.created[0].sessionId)
  agent.reply('群回复')
  agent.ctx.emitStatus('idle')
  await tick(60)
  const sent = env.server.lastRest('/v2/groups/group-1/messages')
  assert.equal(textOf(sent.body), '群回复')

  // 未 @机器人的群消息：QQ 不会推送 GROUP_AT_MESSAGE_CREATE，这里用 GUILD_MESSAGE_CREATE（未 @）验证 router 忽略
  const before = env.agents.created.length
  env.server.pushDispatch('GUILD_MESSAGE_CREATE', {
    id: 'qq-msg-4',
    content: '随便聊聊',
    guild_id: 'gd',
    channel_id: 'ch',
    author: { id: 'member-1', username: 'M' },
  })
  await tick(50)
  assert.equal(env.agents.created.length, before, '未 @的消息不得创建会话')
})

test('端到端：未授权用户的私聊走配对流程并回执', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  env.server.pushDispatch('C2C_MESSAGE_CREATE', {
    id: 'qq-msg-5',
    content: '你好',
    author: { user_openid: 'stranger-1', username: '路人' },
  })
  await tick(60)
  assert.equal(env.agents.created.length, 0)
  const sent = env.server.lastRest('/v2/users/stranger-1/messages')
  assert.match(textOf(sent.body), /等待管理员批准/)
  assert.equal(env.plugin.store.pendingPairing().length, 1)
})

test('端到端：DSH 审批请求被推到 QQ，无人应答时 fail-closed', async t => {
  const env = await setup({ configOverrides: { approvalTtlMs: 1000 } })
  t.after(() => cleanup(env))
  await env.plugin.store.setHomeChannel('openid-owner')

  env.server.pushDispatch('C2C_MESSAGE_CREATE', {
    id: 'qq-msg-6',
    content: '跑个命令',
    author: { user_openid: 'openid-owner', username: '小明' },
  })
  await tick(50)
  const sessionId = env.agents.created[0].sessionId

  const pending = env.ctx.emitWaterfall('approval/request', {
    agent: { session: { id: sessionId } },
    toolName: 'bash',
    reason: 'rm -rf build',
  })
  await tick(60)
  const approvalMsg = env.server.lastRest('/v2/users/openid-owner/messages')
  assert.match(textOf(approvalMsg.body), /需要你批准一次敏感操作/)
  assert.match(textOf(approvalMsg.body), /bash/)

  // 审批有效期 1s，无人点按/回复 → unavailable（fail-closed）
  assert.equal(await pending, 'unavailable')
})

test('P4 端到端：审批走 QQ 按钮 → 点按允许 → allowed-once + 交互 ACK', async t => {
  const env = await setup({ configOverrides: { approvalTtlMs: 5000 } })
  t.after(() => cleanup(env))
  await env.plugin.store.setHomeChannel('openid-owner')

  // 建立会话
  env.server.pushDispatch('C2C_MESSAGE_CREATE', {
    id: 'qq-p4-1',
    content: '帮我跑一下构建',
    author: { user_openid: 'openid-owner', username: '小明' },
  })
  await tick(50)
  const sessionId = env.agents.created[0].sessionId

  // DSH 发起审批
  const pending = env.ctx.emitWaterfall('approval/request', {
    agent: { session: { id: sessionId } },
    toolName: 'bash',
    reason: 'rm -rf build',
  })
  await tick(60)

  const approvalMsg = env.server.lastRest('/v2/users/openid-owner/messages')
  assert.ok(approvalMsg.body.keyboard !== undefined, 'P4 起审批应带 InlineKeyboard 按钮')
  const buttons = approvalMsg.body.keyboard.content.rows[0].buttons
  assert.equal(buttons.length, 2)
  assert.equal(buttons[0].render_data.label, '允许')
  const allowData = buttons[0].action.data
  assert.match(allowData, /^qqapproval:/)

  // 用户点按「允许」→ QQ 派发 INTERACTION_CREATE
  env.server.pushDispatch('INTERACTION_CREATE', {
    id: 'int-p4-1',
    chat_type: 2,
    user_openid: 'openid-owner',
    data: { button_data: allowData, resolved: { user_id: 'openid-owner' } },
  })
  await tick(80)

  const ack = env.server.lastRest('/interactions/int-p4-1')
  assert.ok(ack !== null, '必须 ACK 交互，否则用户端按钮显示错误态')
  assert.deepEqual(ack.body, { code: 0 })
  assert.equal(await pending, 'allowed-once', '点按允许应让 DSH 审批通过')

  const replies = env.server.state.rest
    .filter(entry => entry.path.startsWith('/v2/users/openid-owner/messages'))
    .map(entry => entry.body.content ?? entry.body.markdown?.content ?? '')
  assert.ok(replies.some(text => /已允许本次操作/.test(text)), '应在 QQ 里回执允许结果')
})

test('P4 端到端：点按拒绝 → rejected；他人点按被拒且审批保持待决', async t => {
  const env = await setup({ configOverrides: { approvalTtlMs: 8000 } })
  t.after(() => cleanup(env))
  await env.plugin.store.setHomeChannel('openid-owner')

  env.server.pushDispatch('C2C_MESSAGE_CREATE', {
    id: 'qq-p4-2',
    content: '删掉临时目录',
    author: { user_openid: 'openid-owner', username: '小明' },
  })
  await tick(50)
  const sessionId = env.agents.created[0].sessionId

  const pending = env.ctx.emitWaterfall('approval/request', {
    agent: { session: { id: sessionId } },
    toolName: 'bash',
    reason: 'rm -rf /tmp/x',
  })
  await tick(60)
  const buttons = env.server.lastRest('/v2/users/openid-owner/messages').body.keyboard.content.rows[0].buttons
  const denyData = buttons[1].action.data

  // 陌生人点按 → mismatch，审批保持待决
  env.server.pushDispatch('INTERACTION_CREATE', {
    id: 'int-p4-2',
    chat_type: 2,
    user_openid: 'stranger',
    data: { button_data: denyData, resolved: { user_id: 'stranger' } },
  })
  await tick(60)
  const strangerReplies = env.server.state.rest
    .filter(entry => entry.path.startsWith('/v2/users/stranger/messages'))
    .map(entry => entry.body.content ?? '')
  assert.ok(strangerReplies.some(text => /审批失败/.test(text)))

  // 本人点按拒绝 → rejected
  env.server.pushDispatch('INTERACTION_CREATE', {
    id: 'int-p4-3',
    chat_type: 2,
    user_openid: 'openid-owner',
    data: { button_data: denyData, resolved: { user_id: 'openid-owner' } },
  })
  await tick(80)
  assert.equal(await pending, 'rejected')
})

// ── P5 端到端：媒体双向 ──

/** 假附件服务（记录入库的图片/文件）。 */
function createFakeAttachments() {
  const saved = { images: [], files: [] }
  return {
    saved,
    async saveImage({ data, mediaType, name }) {
      const ref = { attachmentId: `img-${saved.images.length + 1}`, mediaType, bytes: data.byteLength, width: 3, height: 3, ...(name === undefined ? {} : { name }) }
      saved.images.push({ data, mediaType, name, ref })
      return ref
    },
    async saveFile({ data, name }) {
      const ref = { attachmentId: `file-${saved.files.length + 1}`, name: name ?? 'file', bytes: data.byteLength }
      saved.files.push({ data, name, ref })
      return ref
    },
  }
}

test('P5 端到端：QQ 发图片 → 下载入库 → 模型可见 image block', async t => {
  const attachments = createFakeAttachments()
  const env = await setup({ services: { attachments } })
  t.after(() => cleanup(env))
  await env.plugin.store.setHomeChannel('openid-owner')

  const imageUrl = `${env.server.baseUrl}/media/photo.png?size=128&type=image/png`
  env.server.pushDispatch('C2C_MESSAGE_CREATE', {
    id: 'qq-p5-1',
    content: '看这张图',
    author: { user_openid: 'openid-owner', username: '小明' },
    attachments: [{ content_type: 'image/png', url: imageUrl, filename: 'photo.png', size: 128 }],
  })
  await tick(80)

  assert.equal(attachments.saved.images.length, 1, '图片应被下载并入库')
  assert.equal(attachments.saved.images[0].data.byteLength, 128)
  assert.equal(env.server.state.mediaRequests.length, 1)
  assert.equal(env.server.state.mediaRequests[0].headers.authorization.startsWith('QQBot token-'), true, '媒体下载必须带鉴权头')

  const blocks = env.agents.live.get(env.agents.created[0].sessionId).followed[0].content
  assert.deepEqual(blocks[0], { type: 'text', text: '看这张图' })
  assert.equal(blocks[1].type, 'image')
  assert.equal(blocks[1].attachment.mediaType, 'image/png')
})

test('P5 端到端：de_channel_send 直发图片到 QQ（上传 → msg_type=7）', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  const entry = globalThis.__dshChannelNotify.qq

  const result = await entry.sendMedia(
    { kind: 'p2p', id: 'openid-owner' },
    { kind: 'image', base64: Buffer.from('PNGDATA').toString('base64'), fileName: 'shot.png', caption: '来自 DSH' },
  )
  assert.equal(result.ok, true)

  const upload = env.server.lastRest('/v2/users/openid-owner/files')
  assert.equal(upload.body.file_type, 1)
  assert.equal(upload.body.srv_send_msg, false)
  assert.equal(upload.body.file_data, Buffer.from('PNGDATA').toString('base64'))

  const send = env.server.lastRest('/v2/users/openid-owner/messages')
  assert.equal(send.body.msg_type, 7)
  assert.equal(send.body.content, '来自 DSH')
  assert.equal(send.body.file_info ?? send.body.media.file_info, 'fi-1')
})

test('P5 端到端：语音带内置 ASR 文本 → 直接作为文本进入会话', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  await env.plugin.store.setHomeChannel('openid-owner')

  env.server.pushDispatch('C2C_MESSAGE_CREATE', {
    id: 'qq-p5-2',
    content: '',
    author: { user_openid: 'openid-owner', username: '小明' },
    attachments: [
      { content_type: 'voice/silk', url: `${env.server.baseUrl}/media/v.silk?size=32`, filename: 'v.silk', asr_refer_text: '明天几点开会' },
    ],
  })
  await tick(80)
  const text = env.agents.live.get(env.agents.created[0].sessionId).followed[0].content[0].text
  assert.equal(text, '[语音转写] 明天几点开会')
})
