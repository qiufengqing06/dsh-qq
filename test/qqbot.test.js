import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolveConfig } from '../lib/config.js'
import { createResourceScope } from '../lib/scope.js'
import { assertTransportContract, buildChatKey } from '../lib/transport.js'
import {
  DEDUP_MAX_SIZE,
  DEDUP_WINDOW_MS,
  chunkText,
  createTransport,
  mediaKindOf,
  nextMsgSeq,
  normalizeDispatch,
  normalizeInteraction,
  parseTimestamp,
  redact,
  resolveCredentials,
} from '../lib/qqbot.js'
import { startFakeQQServer } from './helpers/fake-qq-server.js'
import { createFakeCtx, createLogger } from './helpers/fake-ctx.js'

const tick = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms))

async function setup({ serverOptions = {}, configOverrides = {}, deps = {}, credentials = true, ctxServices = {} } = {}) {
  const server = await startFakeQQServer(serverOptions)
  const saved = { id: process.env.QQ_APP_ID, secret: process.env.QQ_CLIENT_SECRET }
  if (credentials) {
    process.env.QQ_APP_ID = 'app-1'
    process.env.QQ_CLIENT_SECRET = 'secret-1'
  } else {
    delete process.env.QQ_APP_ID
    delete process.env.QQ_CLIENT_SECRET
  }
  const config = resolveConfig({ transport: 'qqbot', autoConnect: false, ...configOverrides })
  const ctx = createFakeCtx({ services: ctxServices })
  const scope = createResourceScope({ name: 'test-qqbot' })
  const logger = createLogger()
  const transport = createTransport({
    config,
    ctx,
    scope,
    logger,
    deps: {
      socketFactory: server.socketFactory,
      apiBase: server.apiBase,
      tokenUrl: server.tokenUrl,
      backoffMs: [10, 10, 10],
      ...deps,
    },
  })
  const restore = () => {
    if (saved.id === undefined) delete process.env.QQ_APP_ID
    else process.env.QQ_APP_ID = saved.id
    if (saved.secret === undefined) delete process.env.QQ_CLIENT_SECRET
    else process.env.QQ_CLIENT_SECRET = saved.secret
  }
  return { server, config, ctx, scope, logger, transport, restore }
}

const cleanup = async ({ server, scope, restore }) => {
  await scope.dispose()
  await server.close()
  restore()
}

test('纯函数：时间/媒体/分段/序号/脱敏', () => {
  assert.equal(parseTimestamp('1700000000'), 1_700_000_000_000)
  assert.equal(parseTimestamp(1_700_000_000_123), 1_700_000_000_123)
  assert.equal(parseTimestamp('2023-11-14T22:13:20.000Z'), 1_700_000_000_000)
  assert.ok(parseTimestamp('') > 0)

  assert.equal(mediaKindOf('image/png'), 'image')
  assert.equal(mediaKindOf('video/mp4'), 'video')
  assert.equal(mediaKindOf('audio/silk', 'x.silk'), 'audio')
  assert.equal(mediaKindOf('application/octet-stream', 'a.zip'), 'file')

  assert.deepEqual(chunkText('短'), ['短'])
  assert.deepEqual(chunkText(''), [])
  const long = 'a'.repeat(9000)
  const chunks = chunkText(long)
  assert.deepEqual(chunks.map(item => item.length), [4000, 4000, 1000])
  const multiline = `${'x'.repeat(10)}\n${'y'.repeat(4000)}`
  assert.ok(chunkText(multiline).every(chunk => chunk.length <= 4000))

  assert.equal(nextMsgSeq(0), 1)
  assert.equal(nextMsgSeq(65_535), 0)

  assert.match(redact('clientSecret=abc123'), /clientSecret=\*\*\*/)
  assert.match(redact('Authorization: QQBot token-9'), /QQBot \*\*\*/)
})

test('normalizeDispatch：私聊 / 群 @ / 频道 / 附件 / 忽略未知', () => {
  const dm = normalizeDispatch(
    'C2C_MESSAGE_CREATE',
    {
      id: 'm1',
      content: '你好',
      timestamp: '1700000000',
      author: { user_openid: 'openid-1', username: '小明' },
      attachments: [{ content_type: 'image/png', url: 'https://x.invalid/a.png', filename: 'a.png', size: 12 }],
    },
    'app-1',
  )
  assert.equal(dm.chatKey, buildChatKey('qqbot', 'app-1', { kind: 'dm', userId: 'openid-1' }))
  assert.deepEqual(dm.target, { kind: 'dm', userId: 'openid-1' })
  assert.equal(dm.text, '你好')
  assert.equal(dm.sender.name, '小明')
  assert.equal(dm.media[0].kind, 'image')
  assert.equal(dm.timestamp, 1_700_000_000_000)

  const group = normalizeDispatch(
    'GROUP_AT_MESSAGE_CREATE',
    { id: 'm2', content: '在吗', group_openid: 'g1', author: { member_openid: 'mem-1' } },
    'app-1',
  )
  assert.deepEqual(group.target, { kind: 'group', groupId: 'g1' })
  assert.equal(group.mentioned, true)

  const channel = normalizeDispatch(
    'GUILD_AT_MESSAGE_CREATE',
    { id: 'm3', content: 'hi', guild_id: 'gd', channel_id: 'ch', author: { id: 'u9', username: 'U' } },
    'app-1',
  )
  assert.deepEqual(channel.target, { kind: 'channel', guildId: 'gd', channelId: 'ch' })
  assert.equal(channel.mentioned, true)

  assert.equal(normalizeDispatch('C2C_MESSAGE_CREATE', { id: 'm4' }, 'app-1'), null, '缺 user_openid 应忽略')
  assert.equal(normalizeDispatch('SOMETHING_ELSE', { id: 'm5' }, 'app-1'), null)
})

test('normalizeInteraction：按钮回调归属到正确 target', () => {
  const dm = normalizeInteraction({ id: 'i1', chat_type: 2, user_openid: 'u1', data: { button_data: 'qqapproval:ap-1:allow:n1', resolved: { user_id: 'u1' } } }, 'app-1')
  assert.equal(dm.data, 'qqapproval:ap-1:allow:n1')
  assert.deepEqual(dm.target, { kind: 'dm', userId: 'u1' })
  const group = normalizeInteraction({ id: 'i2', chat_type: 1, group_openid: 'g1', data: { button_data: 'x' } }, 'app-1')
  assert.deepEqual(group.target, { kind: 'group', groupId: 'g1' })
  assert.equal(normalizeInteraction({ id: 'i3', chat_type: 9, data: {} }, 'app-1'), null)
})

test('resolveCredentials：credentials 服务优先，其次环境变量', async t => {
  const saved = { id: process.env.QQ_APP_ID, secret: process.env.QQ_CLIENT_SECRET }
  delete process.env.QQ_APP_ID
  delete process.env.QQ_CLIENT_SECRET
  try {
    assert.equal(await resolveCredentials(createFakeCtx({})), null)
    process.env.QQ_APP_ID = 'env-app'
    process.env.QQ_CLIENT_SECRET = 'env-secret'
    const fromEnv = await resolveCredentials(createFakeCtx({}))
    assert.deepEqual(fromEnv, { appId: 'env-app', clientSecret: 'env-secret', source: 'environment' })

    const credentials = {
      async resolve(ref) {
        if (ref === 'QQ_APP_ID') return { value: 'svc-app' }
        if (ref === 'QQ_CLIENT_SECRET') return { value: 'svc-secret' }
        return undefined
      },
    }
    const fromService = await resolveCredentials(createFakeCtx({ services: { credentials } }))
    assert.deepEqual(fromService, { appId: 'svc-app', clientSecret: 'svc-secret', source: 'credentials' })
  } finally {
    if (saved.id === undefined) delete process.env.QQ_APP_ID
    else process.env.QQ_APP_ID = saved.id
    if (saved.secret === undefined) delete process.env.QQ_CLIENT_SECRET
    else process.env.QQ_CLIENT_SECRET = saved.secret
  }
})

test('无凭据：start 返回 false，phase=no-credentials，不崩', async t => {
  const env = await setup({ credentials: false })
  t.after(() => cleanup(env))
  assert.equal(await env.transport.start(), false)
  const status = env.transport.status()
  assert.equal(status.phase, 'no-credentials')
  assert.match(status.lastError, /QQ_APP_ID/)
  assert.equal(env.server.state.tokenRequests, 0)
})

test('启动：token → gateway → hello → identify(READY) → connected', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  assert.equal(assertTransportContract(env.transport), true)
  assert.equal(await env.transport.start(), true)
  await tick(50)
  const status = env.transport.status()
  assert.equal(status.phase, 'connected')
  assert.equal(status.connected, true)
  assert.equal(status.accountId, 'app-1')
  assert.equal(env.server.state.tokenRequests, 1)
  assert.equal(env.server.state.gatewayRequests, 1)

  const identify = env.server.frames.find(entry => entry.frame.op === 2)
  assert.ok(identify !== undefined, '应发送 op2 Identify')
  assert.equal(identify.frame.d.token, 'QQBot token-1')
  assert.equal(identify.frame.d.intents, (1 << 25) | (1 << 30) | (1 << 12) | (1 << 26))
  assert.deepEqual(identify.frame.d.shard, [0, 1])
})

test('心跳：按 hello 间隔的 80% 发送 op1，并收到 op11', async t => {
  const env = await setup({ serverOptions: { heartbeatIntervalMs: 100 } })
  t.after(() => cleanup(env))
  await env.transport.start()
  await tick(300)
  const heartbeats = env.server.frames.filter(entry => entry.frame.op === 1)
  assert.ok(heartbeats.length >= 2, `应至少发送 2 次心跳，实际 ${heartbeats.length}`)
  assert.equal(env.transport._state().phase, 'connected')
})

test('入站：dispatch → 归一化事件；重复 msg_id 只投递一次', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  const received = []
  env.transport.onMessage(event => received.push(event))
  await env.transport.start()
  await tick(40)

  const d = { id: 'm-1', content: 'ping', timestamp: '1700000000', author: { user_openid: 'u1', username: 'U' } }
  env.server.pushDispatch('C2C_MESSAGE_CREATE', d)
  env.server.pushDispatch('C2C_MESSAGE_CREATE', d)
  await tick(30)
  assert.equal(received.length, 1, '重复消息应被去重')

  env.server.pushDispatch('GROUP_AT_MESSAGE_CREATE', { id: 'm-2', content: 'hi', group_openid: 'g1', author: { member_openid: 'mem' } })
  await tick(30)
  assert.equal(received.length, 2)
  assert.deepEqual(received[1].target, { kind: 'group', groupId: 'g1' })
})

test('交互：INTERACTION_CREATE → onInteraction（按钮回调）', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  const interactions = []
  env.transport.onInteraction(payload => interactions.push(payload))
  await env.transport.start()
  await tick(40)
  env.server.pushDispatch('INTERACTION_CREATE', {
    id: 'int-1',
    chat_type: 2,
    user_openid: 'u1',
    data: { button_data: 'qqapproval:ap-1:allow:nonce-1', resolved: { user_id: 'u1' } },
  })
  await tick(30)
  assert.equal(interactions.length, 1)
  assert.equal(interactions[0].data, 'qqapproval:ap-1:allow:nonce-1')
  assert.deepEqual(interactions[0].target, { kind: 'dm', userId: 'u1' })
})

test('发送文本：路径/鉴权/消息体/被动回复/markdown', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  await env.transport.start()
  await tick(40)

  const dm = await env.transport.sendText({ kind: 'dm', userId: 'openid-1' }, 'pong', {})
  assert.equal(dm.ok, true)
  let request = env.server.lastRest('/v2/users/openid-1/messages')
  assert.equal(request.headers.authorization, 'QQBot token-1')
  assert.deepEqual(request.body, { content: 'pong', msg_type: 0, msg_seq: 1 })

  await env.transport.sendText(
    { kind: 'dm', userId: 'openid-1' },
    '**粗体**',
    { markdown: true, replyTo: 'in-1' },
  )
  request = env.server.lastRest('/v2/users/openid-1/messages')
  assert.equal(request.body.msg_type, 2)
  assert.equal(request.body.markdown.content, '**粗体**')
  assert.equal(request.body.msg_id, 'in-1')
  assert.ok(request.body.msg_seq > 1, 'msg_seq 应递增')

  const group = await env.transport.sendText({ kind: 'group', groupId: 'g1' }, 'hi', {})
  assert.equal(group.ok, true)
  assert.ok(env.server.lastRest('/v2/groups/g1/messages') !== null)

  const channel = await env.transport.sendText({ kind: 'channel', guildId: 'gd', channelId: 'ch' }, 'hi', {})
  assert.equal(channel.ok, true)
  assert.deepEqual(env.server.lastRest('/channels/ch/messages').body, { content: 'hi' })
})

test('长文本分段：4000 字上限、msg_seq 递增、markdown 模式不混用', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  await env.transport.start()
  await tick(40)
  const result = await env.transport.sendText({ kind: 'dm', userId: 'u1' }, 'a'.repeat(9000), {})
  assert.equal(result.ok, true)
  const bodies = env.server.state.rest.map(entry => entry.body)
  assert.equal(bodies.length, 3)
  assert.deepEqual(bodies.map(body => body.content.length), [4000, 4000, 1000])
  const seqs = bodies.map(body => body.msg_seq)
  assert.deepEqual([...seqs].sort((a, b) => a - b), seqs)
})

test('输入中指示：msg_type=6 且带最近入站 msg_id', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  await env.transport.start()
  await tick(40)
  env.server.pushDispatch('C2C_MESSAGE_CREATE', { id: 'in-9', content: 'hi', author: { user_openid: 'u1' } })
  await tick(30)
  const result = await env.transport.sendTyping({ kind: 'dm', userId: 'u1' })
  assert.equal(result.ok, true)
  const body = env.server.lastRest('/v2/users/u1/messages').body
  assert.equal(body.msg_type, 6)
  assert.equal(body.msg_id, 'in-9')
})

test('未连接与 REST 错误：如实返回 retryable', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  const cold = await env.transport.sendText({ kind: 'dm', userId: 'u1' }, 'hi', {})
  assert.equal(cold.ok, false)
  assert.equal(cold.retryable, true)

  await env.transport.start()
  await tick(40)
  env.server.setRestResponse('/v2/users/u1/messages', { status: 429, body: { message: 'rate limited' } })
  const limited = await env.transport.sendText({ kind: 'dm', userId: 'u1' }, 'hi', {})
  assert.equal(limited.ok, false)
  assert.equal(limited.status, 429)
  assert.equal(limited.retryable, true)
  assert.match(limited.error, /429/)
})

test('token singleflight：并发请求只触发一次刷新', async t => {
  const env = await setup({ serverOptions: { tokenTtlSeconds: 1 } })
  t.after(() => cleanup(env))
  await env.transport.start()
  await tick(40)
  const before = env.server.state.tokenRequests
  await Promise.all(
    Array.from({ length: 5 }, (_, index) => env.transport.sendText({ kind: 'dm', userId: `u${index}` }, 'hi', {})),
  )
  assert.equal(env.server.state.tokenRequests, before + 1, '并发发送只应刷新一次 token')
})

test('重连：4004 刷新 token 后重连（保留 session → resume）', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  await env.transport.start()
  await tick(40)
  assert.equal(env.transport._state().sessionId, 'sess-fake-1')

  env.server.dropSocket(4004, 'invalid token')
  await tick(80)
  assert.equal(env.server.state.tokenRequests >= 2, true, '4004 应触发 token 刷新')
  assert.equal(env.transport.status().phase, 'connected', '重连后应恢复 connected')
  const resumes = env.server.frames.filter(entry => entry.frame.op === 6)
  assert.ok(resumes.length >= 1, '保留 session 时应发 op6 Resume')
  assert.equal(resumes.at(-1).frame.d.token.startsWith('QQBot token-'), true, 'Resume 应带新 token')
})

test('重连：普通断开保留 session → 发 op6 resume', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  await env.transport.start()
  await tick(40)
  env.server.dropSocket(1006, 'network blip')
  await tick(80)
  const resumes = env.server.frames.filter(entry => entry.frame.op === 6)
  assert.equal(resumes.length >= 1, true, '保留 session 时应发 Resume')
  assert.equal(resumes[0].frame.d.session_id, 'sess-fake-1')
})

test('致命 close code：进入 fatal，不再重连', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  await env.transport.start()
  await tick(40)
  env.server.dropSocket(4914, 'bot offline')
  await tick(120)
  assert.equal(env.transport.status().phase, 'fatal')
  assert.match(env.transport.status().lastError, /4914|致命/)
  assert.equal(env.server.sockets.size, 0, '不应保留连接')
  const framesAfterFatal = env.server.frames.length
  await tick(80)
  assert.equal(env.server.frames.length, framesAfterFatal, 'fatal 后不得再发帧')
  assert.equal(env.transport.status().phase, 'fatal')
})

test('快速断开保护：连断 3 次进入 fatal', async t => {
  const env = await setup({ serverOptions: { heartbeatIntervalMs: 1000 } })
  t.after(() => cleanup(env))
  await env.transport.start()
  for (let index = 0; index < 3; index += 1) {
    await tick(20)
    env.server.dropSocket(1006, 'quick')
    await tick(30)
  }
  await tick(60)
  assert.equal(env.transport.status().phase, 'fatal')
  assert.match(env.transport.status().lastError, /快速断开/)
})

test('stop()：断开连接并清理定时器', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  await env.transport.start()
  await tick(40)
  await env.transport.stop()
  assert.equal(env.transport.status().phase, 'stopped')
  assert.equal(env.server.sockets.size, 0)
  // cleanups 里那 1 个是「插件卸载时关 socket」的常驻登记（stop() 本身不清它）
  assert.deepEqual(env.scope.stats, { cleanups: 1, timers: 0, tasks: 0 })
})

test('P5 capabilities：声明支持图片/文件/语音/视频；参数错误如实报错', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  await env.transport.start()
  await tick(40)
  assert.deepEqual([...env.transport.capabilities().media], ['image', 'file', 'audio', 'video'])
  const noButtons = await env.transport.sendKeyboard({ kind: 'dm', userId: 'u1' }, 't', [])
  assert.equal(noButtons.ok, false)
  assert.match(noButtons.error, /至少一个按钮/)
  const noSource = await env.transport.sendMedia({ kind: 'dm', userId: 'u1' }, { kind: 'image' })
  assert.equal(noSource.ok, false)
  assert.match(noSource.error, /需要 url \/ base64 \/ path/)
  const badKind = await env.transport.sendMedia({ kind: 'dm', userId: 'u1' }, { kind: 'hologram', url: 'x' })
  assert.equal(badKind.ok, false)
  assert.match(badKind.error, /不支持的媒体类型/)
  const channel = await env.transport.sendMedia({ kind: 'channel', guildId: 'g', channelId: 'c' }, { kind: 'image', url: 'x' })
  assert.equal(channel.ok, false)
  assert.match(channel.error, /频道不支持媒体上传/)
})

test('代理环境变量：直连模式下明确报错（P6 实现代理）', async t => {
  const env = await setup({ deps: { socketFactory: undefined } })
  t.after(() => cleanup(env))
  const saved = process.env.HTTPS_PROXY
  process.env.HTTPS_PROXY = 'http://127.0.0.1:7890'
  try {
    await env.transport.start()
    await tick(60)
    const phase = env.transport.status().phase
    assert.ok(['reconnecting', 'connecting', 'disconnected'].includes(phase), `代理下不应假报 connected，实际 ${phase}`)
    assert.match(env.transport.status().lastError, /代理/)
  } finally {
    if (saved === undefined) delete process.env.HTTPS_PROXY
    else process.env.HTTPS_PROXY = saved
    await cleanup(env)
  }
})

// ── P4：审批 InlineKeyboard 与交互 ACK ──

test('P4 capabilities：声明支持键盘与 markdown/typing', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  const caps = env.transport.capabilities()
  assert.equal(caps.keyboard, true)
  assert.equal(caps.markdown, true)
  assert.equal(caps.typing, true)
})

test('P4 sendKeyboard：消息体带 QQ InlineKeyboard 结构，按钮 data 可回传', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  await env.transport.start()
  await tick(40)

  const result = await env.transport.sendKeyboard(
    { kind: 'dm', userId: 'openid-1' },
    '需要你批准一次敏感操作',
    [
      { label: '允许', data: 'qqapproval:ap-1:allow:nonce-1', style: 1 },
      { label: '拒绝', data: 'qqapproval:ap-1:deny:nonce-1', style: 0 },
    ],
  )
  assert.equal(result.ok, true)

  const body = env.server.lastRest('/v2/users/openid-1/messages').body
  assert.equal(body.msg_type, 0)
  assert.equal(body.content, '需要你批准一次敏感操作')
  assert.ok(Number.isSafeInteger(body.msg_seq))
  const rows = body.keyboard.content.rows
  assert.equal(rows.length, 1)
  assert.equal(rows[0].buttons.length, 2)
  const [allow, deny] = rows[0].buttons
  assert.equal(allow.render_data.label, '允许')
  assert.equal(allow.action.type, 2, 'type=2 表示回调按钮')
  assert.equal(allow.action.data, 'qqapproval:ap-1:allow:nonce-1')
  assert.equal(allow.action.permission.type, 2)
  assert.equal(allow.action.click_limit, 1)
  assert.equal(allow.group_id, deny.group_id, '同组按钮互斥')
  assert.equal(deny.render_data.style, 0)

  const empty = await env.transport.sendKeyboard({ kind: 'dm', userId: 'u' }, 'x', [])
  assert.equal(empty.ok, false)
})

test('P4 sendKeyboard：群/频道路径与被动回复引用', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  await env.transport.start()
  await tick(40)
  env.server.pushDispatch('C2C_MESSAGE_CREATE', { id: 'in-77', content: 'hi', author: { user_openid: 'u9' } })
  await tick(30)

  await env.transport.sendKeyboard({ kind: 'dm', userId: 'u9' }, '确认？', [{ label: '好', data: 'd1' }])
  assert.equal(env.server.lastRest('/v2/users/u9/messages').body.msg_id, 'in-77', '应引用最近入站消息')

  await env.transport.sendKeyboard({ kind: 'group', groupId: 'g1' }, '确认？', [{ label: '好', data: 'd1' }])
  assert.ok(env.server.lastRest('/v2/groups/g1/messages').body.keyboard !== undefined)

  await env.transport.sendKeyboard({ kind: 'channel', guildId: 'gd', channelId: 'ch' }, '确认？', [{ label: '好', data: 'd1' }])
  const channelBody = env.server.lastRest('/channels/ch/messages').body
  assert.ok(channelBody.keyboard !== undefined)
  assert.equal(channelBody.msg_seq, undefined, '频道消息不带 msg_seq')
})

test('P4 交互回调：先 ACK（PUT /interactions/{id}）再投递给上层', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  const interactions = []
  env.transport.onInteraction(payload => interactions.push(payload))
  await env.transport.start()
  await tick(40)

  env.server.pushDispatch('INTERACTION_CREATE', {
    id: 'int-99',
    chat_type: 2,
    user_openid: 'u1',
    data: { button_data: 'qqapproval:ap-9:allow:n9', resolved: { user_id: 'u1' } },
  })
  await tick(60)

  const ack = env.server.lastRest('/interactions/int-99')
  assert.ok(ack !== null, '必须 ACK 交互')
  assert.deepEqual(ack.body, { code: 0 })
  assert.equal(interactions.length, 1)
  assert.equal(interactions[0].data, 'qqapproval:ap-9:allow:n9')
})

test('P4 交互 ACK 失败只告警，不影响回调投递', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  const interactions = []
  env.transport.onInteraction(payload => interactions.push(payload))
  await env.transport.start()
  await tick(40)
  env.server.setRestResponse('/interactions/', { status: 500, body: { message: 'boom' } })

  env.server.pushDispatch('INTERACTION_CREATE', {
    id: 'int-500',
    chat_type: 2,
    user_openid: 'u1',
    data: { button_data: 'x', resolved: { user_id: 'u1' } },
  })
  await tick(60)
  assert.equal(interactions.length, 1)
  assert.ok(env.logger.entries.warn.some(line => line.includes('交互 ACK 失败')))
})

// ── P5：媒体上传 / 下载 ──

test('P5 sendMedia：URL 来源 → 先上传取 file_info，再发 msg_type=7', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  await env.transport.start()
  await tick(40)

  const result = await env.transport.sendMedia(
    { kind: 'dm', userId: 'openid-1' },
    { kind: 'image', url: 'https://cdn.example.invalid/a.png', caption: '看图' },
  )
  assert.equal(result.ok, true)

  const upload = env.server.lastRest('/v2/users/openid-1/files')
  assert.deepEqual(upload.body, { file_type: 1, srv_send_msg: false, url: 'https://cdn.example.invalid/a.png' })

  const send = env.server.lastRest('/v2/users/openid-1/messages')
  assert.equal(send.body.msg_type, 7)
  assert.equal(send.body.file_info ?? send.body.media.file_info, 'fi-1')
  assert.equal(send.body.content, '看图')
  assert.ok(Number.isSafeInteger(send.body.msg_seq))
})

test('P5 sendMedia：base64 来源 → file_data；文件类型带 file_name；群路径正确', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  await env.transport.start()
  await tick(40)

  const payload = Buffer.from('hello-media').toString('base64')
  await env.transport.sendMedia(
    { kind: 'group', groupId: 'g1' },
    { kind: 'file', base64: payload, fileName: '报告.pdf' },
  )
  const upload = env.server.lastRest('/v2/groups/g1/files')
  assert.equal(upload.body.file_type, 4)
  assert.equal(upload.body.file_data, payload)
  assert.equal(upload.body.file_name, '报告.pdf')
  const send = env.server.lastRest('/v2/groups/g1/messages')
  assert.equal(send.body.msg_type, 7)
  assert.equal(send.body.file_info ?? send.body.media.file_info, 'fi-1')
})

test('P5 sendMedia：本地文件路径读取；超过内联上限如实拒绝', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  await env.transport.start()
  await tick(40)

  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-media-'))
  const small = join(dir, 'pic.png')
  await writeFile(small, Buffer.from('binary-image'))
  const okResult = await env.transport.sendMedia({ kind: 'dm', userId: 'u2' }, { kind: 'image', path: small })
  assert.equal(okResult.ok, true)
  assert.equal(env.server.lastRest('/v2/users/u2/files').body.file_data, Buffer.from('binary-image').toString('base64'))

  const noFile = await env.transport.sendMedia({ kind: 'dm', userId: 'u2' }, { kind: 'image', path: join(dir, 'missing.png') })
  assert.equal(noFile.ok, false)
  assert.match(noFile.error, /读取本地文件失败/)

  // 超过内联上限 → 走分片上传（P6）
  const huge = Buffer.alloc(14 * 1024 * 1024, 0x42).toString('base64') // ≈10.5MB 解码后
  const big = await env.transport.sendMedia({ kind: 'dm', userId: 'u2' }, { kind: 'file', base64: huge, fileName: 'big.bin' })
  assert.equal(big.ok, true, big.error)
  assert.equal(env.server.state.uploadPrepare.length, 1)
  const prepareBody = env.server.state.uploadPrepare[0].body
  assert.equal(prepareBody.file_size, 14 * 1024 * 1024)
  assert.match(prepareBody.md5, /^[a-f0-9]{32}$/)
  assert.match(prepareBody.sha1, /^[a-f0-9]{40}$/)
  assert.equal(env.server.state.parts.length, 3, '14MB / 3 片')
  assert.equal(env.server.state.partFinishes.length, 3)
  assert.deepEqual(env.server.state.partFinishes[0].upload_id, 'up-1')
  const finalSend = env.server.lastRest('/v2/users/u2/messages')
  assert.equal(finalSend.body.msg_type, 7)
  assert.equal(finalSend.body.file_info ?? finalSend.body.media.file_info, 'fi-up-1')
})

test('P5 downloadMedia：带鉴权头下载、size 上限前置校验、HTTP 错误如实返回', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  await env.transport.start()
  await tick(40)

  const okResult = await env.transport.downloadMedia(`${env.server.baseUrl}/media/a.png?size=64&type=image/png`)
  assert.equal(okResult.ok, true)
  assert.equal(okResult.bytes, 64)
  assert.equal(okResult.contentType, 'image/png')
  assert.equal(env.server.state.mediaRequests.at(-1).headers.authorization.startsWith('QQBot token-'), true)

  const tooBig = await env.transport.downloadMedia(`${env.server.baseUrl}/media/a.png?size=2048`, { maxBytes: 1024 })
  assert.equal(tooBig.ok, false)
  assert.match(tooBig.error, /媒体超过上限/)

  env.server.setRestResponse('/media/', { status: 500, body: { message: 'boom' } })
  const failed = await env.transport.downloadMedia(`${env.server.baseUrl}/media/b.png?size=8`)
  assert.equal(failed.ok, false)
  assert.match(failed.error, /HTTP 500/)

  // 未连接时明确报错
  const other = await setup()
  t.after(() => cleanup(other))
  const offline = await other.transport.downloadMedia('https://x.invalid/a.png')
  assert.equal(offline.ok, false)
  assert.match(offline.error, /未连接/)
})

test('P5 归一化：附件带 asr_refer_text 时保留为 asrText', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  const received = []
  env.transport.onMessage(ev => received.push(ev))
  await env.transport.start()
  await tick(40)

  env.server.pushDispatch('C2C_MESSAGE_CREATE', {
    id: 'm-voice',
    content: '',
    author: { user_openid: 'u1' },
    attachments: [
      { content_type: 'voice/silk', url: 'https://x.invalid/v.silk', filename: 'v.silk', asr_refer_text: '你好呀' },
      { content_type: 'image/png', url: 'https://x.invalid/a.png', filename: 'a.png', size: 1234 },
    ],
  })
  await tick(30)
  assert.equal(received.length, 1)
  const [voice, image] = received[0].media
  assert.equal(voice.kind, 'audio')
  assert.equal(voice.asrText, '你好呀')
  assert.equal(image.kind, 'image')
  assert.equal(image.size, 1234)
})

// ── 启动期凭据竞态（真机：重启后插件停在 no-credentials，需手动开关） ──

test('凭据缺失：start 返回 false 且允许再次 start（不锁死）', async t => {
  const server = await startFakeQQServer({ heartbeatIntervalMs: 200 })
  const saved = { id: process.env.QQ_APP_ID, secret: process.env.QQ_CLIENT_SECRET }
  delete process.env.QQ_APP_ID
  delete process.env.QQ_CLIENT_SECRET
  const config = resolveConfig({ transport: 'qqbot', autoConnect: false })
  const scope = createResourceScope({ name: 'restart' })
  const transport = createTransport({
    config,
    ctx: createFakeCtx({}),
    scope,
    logger: createLogger(),
    deps: {
      socketFactory: server.socketFactory,
      apiBase: server.apiBase,
      tokenUrl: server.tokenUrl,
      backoffMs: [10, 10, 10],
      proxyUrl: '',
    },
  })
  t.after(async () => {
    await scope.dispose()
    await server.close()
    if (saved.id === undefined) delete process.env.QQ_APP_ID
    else process.env.QQ_APP_ID = saved.id
    if (saved.secret === undefined) delete process.env.QQ_CLIENT_SECRET
    else process.env.QQ_CLIENT_SECRET = saved.secret
  })

  assert.equal(await transport.start(), false)
  assert.equal(transport.status().phase, 'no-credentials')
  // 凭据后来出现了（用户写凭据 / 扫码）→ 再次 start 必须真的生效
  process.env.QQ_APP_ID = 'app-now'
  process.env.QQ_CLIENT_SECRET = 'sec-now'
  assert.equal(await transport.start(), true, '第二次 start 不应被 started 标志挡住')
  await tick(50)
  assert.equal(transport.status().connected, true)
})

// ── 被动回复窗口与引用兜底（真机风险：长回合 >5 分钟回复会静默丢失） ──

/** 最近一次发往某 chat 的消息体。 */
const lastMessageBody = (server, suffix = '/messages') =>
  [...server.state.rest].reverse().find(entry => entry.path.endsWith(suffix))?.body ?? null

test('回复在被动窗口内带 msg_id；超过 replyWindowMs 后不再带（转主动消息）', async t => {
  let clockMs = 1_700_000_000_000
  const env = await setup({ deps: { now: () => clockMs }, configOverrides: { replyWindowMs: 5 * 60 * 1000 } })
  t.after(() => cleanup(env))
  await env.transport.start()
  await tick(40)
  env.server.pushDispatch('C2C_MESSAGE_CREATE', {
    id: 'm-1',
    content: 'ping',
    timestamp: '1700000000',
    author: { user_openid: 'u1', username: 'U' },
  })
  await tick(30)

  const inWindow = await env.transport.sendText({ kind: 'dm', userId: 'u1' }, '第一段', { markdown: true })
  assert.equal(inWindow.ok, true)
  assert.equal(lastMessageBody(env.server).msg_id, 'm-1', '窗口内必须带 msg_id（被动回复）')

  clockMs += 6 * 60 * 1000 // 回合跑了 6 分钟
  const late = await env.transport.sendText({ kind: 'dm', userId: 'u1' }, '迟到的一段', { markdown: true })
  assert.equal(late.ok, true)
  assert.equal(lastMessageBody(env.server).msg_id, undefined, '超窗后不能再带过期 msg_id')
})

test('引用失效兜底：QQ 报 msg_id 过期 → 去掉引用以主动消息重发，回复不丢', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  await env.transport.start()
  await tick(40)
  env.server.pushDispatch('C2C_MESSAGE_CREATE', {
    id: 'm-1',
    content: 'ping',
    timestamp: '1700000000',
    author: { user_openid: 'u1', username: 'U' },
  })
  await tick(30)

  // 只对「带 msg_id 的发送」报过期（真实平台行为）
  env.server.setResponder(({ path, body }) =>
    path.includes('/messages') && body?.msg_id !== undefined
      ? { status: 400, body: { code: 40034005, message: '回复消息msg_id已过期' } }
      : null,
  )

  const result = await env.transport.sendText({ kind: 'dm', userId: 'u1' }, '长任务结果', { markdown: true })
  assert.equal(result.ok, true, '兜底重发后必须成功')
  assert.equal(env.transport._state().passiveFallbacks, 1, '记录一次被动转主动降级')

  const posts = env.server.state.rest.filter(entry => entry.path.includes('/messages'))
  assert.equal(posts.length, 2, '先带引用失败 → 再去引用重发')
  assert.deepEqual(posts[0].body.msg_id, 'm-1')
  assert.equal(posts[1].body.msg_id, undefined)
  assert.equal(posts[1].body.markdown.content, '长任务结果', '重发内容一致')
})

test('纯文本模式（markdown off）也带 msg_id：否则等于放弃被动回复、走主动消息配额', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  await env.transport.start()
  await tick(40)
  env.server.pushDispatch('C2C_MESSAGE_CREATE', {
    id: 'm-7',
    content: 'ping',
    timestamp: '1700000000',
    author: { user_openid: 'u1', username: 'U' },
  })
  await tick(30)

  await env.transport.sendText({ kind: 'dm', userId: 'u1' }, '纯文本回复', { markdown: false })
  const body = lastMessageBody(env.server)
  assert.equal(body.msg_type, 0)
  assert.equal(body.msg_id, 'm-7', 'C2C/群聊的被动回复字段是 msg_id')
  assert.equal(body.content, '纯文本回复')
})

test('去重窗口/容量由配置驱动（dedupWindowMs / dedupMaxSize）', async t => {
  let clockMs = 1_700_000_000_000
  const env = await setup({ deps: { now: () => clockMs }, configOverrides: { dedupWindowMs: 1000, dedupMaxSize: 8 } })
  t.after(() => cleanup(env))
  const received = []
  env.transport.onMessage(event => received.push(event))
  await env.transport.start()
  await tick(40)

  const d = { id: 'm-config', content: 'ping', timestamp: '1700000000', author: { user_openid: 'u1', username: 'U' } }
  env.server.pushDispatch('C2C_MESSAGE_CREATE', d)
  await tick(30)
  assert.equal(received.length, 1, '首次投递')

  clockMs += 500 // 仍在 1s 窗口内
  env.server.pushDispatch('C2C_MESSAGE_CREATE', d)
  await tick(30)
  assert.equal(received.length, 1, '窗口内重复应被丢弃')

  clockMs += 2000 // 超出窗口
  env.server.pushDispatch('C2C_MESSAGE_CREATE', d)
  await tick(30)
  assert.equal(received.length, 2, '窗口外同一 id 视为新消息')

  // 默认值与模块常量一致（配置化不该偷偷改默认行为）
  assert.equal(resolveConfig({ transport: 'qqbot', autoConnect: false }).dedupWindowMs, DEDUP_WINDOW_MS)
  assert.equal(resolveConfig({ transport: 'qqbot', autoConnect: false }).dedupMaxSize, DEDUP_MAX_SIZE)
})

test('插件卸载/热重载：scope.dispose() 必须断开 WS（防旧实例继续收事件）', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  assert.equal(await env.transport.start(), true)
  await tick(40)
  assert.equal(env.server.state.sockets.size, 1, '连接已建立')

  await env.scope.dispose()
  const deadline = Date.now() + 2000
  while (Date.now() < deadline && env.server.state.sockets.size > 0) await tick(20)
  assert.equal(env.server.state.sockets.size, 0, 'scope 释放后假 QQ 服务侧不该再有连接')
})
