/**
 * 二期 transport 验收：OneBot 11（个人 QQ / NapCat）。
 *
 * 全部跑在假 NapCat 服务上（真 socket + 真实 WS 握手/帧），零依赖：
 * ws 缺失时走 Node 内置 WebSocket + ?access_token=，装了 ws 时走 Authorization 头。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveConfig } from '../lib/config.js'
import { createResourceScope } from '../lib/scope.js'
import { assertTransportContract, buildChatKey } from '../lib/transport.js'
import { createTransport, redactEndpoint } from '../lib/onebot/transport.js'
import { startFakeNapCatServer } from './helpers/fake-napcat-server.js'
import { createFakeCtx, createLogger } from './helpers/fake-ctx.js'

const tick = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms))

/** 轮询等待条件成立。 */
async function waitFor(predicate, timeoutMs = 3000, stepMs = 20) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await tick(stepMs)
  }
  return predicate()
}

async function setup({
  serverOptions = {},
  configOverrides = {},
  onebotOverrides = {},
  deps = {},
  ctxServices = {},
  config = {},
} = {}) {
  const server = await startFakeNapCatServer(serverOptions)
  const resolved = resolveConfig({
    transport: 'onebot',
    autoConnect: false,
    ...configOverrides,
    onebot: { wsUrl: server.wsUrl, sendRateLimitMs: 0, ...onebotOverrides },
    ...config,
  })
  const ctx = createFakeCtx({ services: ctxServices })
  const scope = createResourceScope({ name: 'test-onebot' })
  const logger = createLogger()
  const transport = createTransport({
    config: resolved,
    ctx,
    scope,
    logger,
    deps: { backoffMs: [10, 10, 10], ...deps },
  })
  return { server, config: resolved, ctx, scope, logger, transport }
}

const cleanup = async ({ server, scope }) => {
  await scope.dispose()
  await server.close()
}

test('契约完整：onebot transport 满足 TRANSPORT_SLOTS，能力表如实声明', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  assert.equal(assertTransportContract(env.transport), true)
  const capabilities = env.transport.capabilities()
  assert.equal(capabilities.markdown, false, 'NapCat 的 markdown 段不是通用能力')
  assert.equal(capabilities.keyboard, false, 'OneBot 没有按钮回调 → 审批降级文本')
  assert.equal(capabilities.passiveReply, false, 'OneBot 无被动回复窗口')
  assert.deepEqual([...capabilities.media].sort(), ['audio', 'file', 'image', 'video'])
  assert.equal(env.transport.status().kind, 'onebot')
})

test('连接：正向 WS 握手 → get_login_info → accountId；缺 wsUrl 时不锁死', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  assert.equal(await env.transport.start(), true)
  assert.equal(env.transport.status().connected, true)
  assert.equal(env.transport.status().accountId, '10001', 'self_id 成为账号命名空间')
  const loginCall = env.server.lastAction('get_login_info')
  assert.notEqual(loginCall, null)

  await env.transport.stop()
  assert.equal(env.transport.status().connected, false)
  assert.equal(env.transport.status().phase, 'stopped')

  // 未配置 wsUrl：如实失败且允许再次 start（看门狗可再拉）
  const bare = await setup({ config: { onebot: { wsUrl: '' } } })
  t.after(() => cleanup(bare))
  assert.equal(await bare.transport.start(), false)
  assert.equal(bare.transport.status().phase, 'no-credentials')
  assert.match(bare.transport.status().lastError, /wsUrl/)
})

test('鉴权：token 在请求层校验（真机 NapCat 行为）——正确连上、错误 token 明确 auth-failed 且不重连风暴', async t => {
  const okEnv = await setup({ serverOptions: { token: 'secret-token' }, onebotOverrides: { accessToken: 'secret-token' } })
  t.after(() => cleanup(okEnv))
  assert.equal(await okEnv.transport.start(), true, '正确 token 连接成功')
  assert.equal(okEnv.transport.status().connected, true)

  const badEnv = await setup({ serverOptions: { token: 'secret-token' }, onebotOverrides: { accessToken: 'wrong-token' } })
  t.after(() => cleanup(badEnv))
  assert.equal(await badEnv.transport.start(), false, '错误 token 不能算连接成功')
  const status = badEnv.transport.status()
  assert.equal(status.connected, false)
  assert.equal(status.phase, 'auth-failed', '必须停在明确的鉴权失败相位')
  assert.match(status.lastError, /token 验证失败/)
  assert.ok(badEnv.server.state.handshakeRejections >= 1, '服务端记录了未授权连接')
  // 鉴权失败不该反复重连（试错没有意义，等用户改配置）
  await tick(300)
  assert.equal(badEnv.server.state.clients, 1, `不该出现重连风暴（实际连接数 ${badEnv.server.state.clients}）`)
})

test('凭据 seam：ONEBOT_ACCESS_TOKEN 从 credentials 服务读取（配置留空时）', async t => {
  const credentials = {
    async resolve(ref) {
      if (ref === 'ONEBOT_ACCESS_TOKEN') return { value: 'seam-token' }
      return undefined
    },
  }
  const env = await setup({ serverOptions: { token: 'seam-token' }, ctxServices: { credentials } })
  t.after(() => cleanup(env))
  assert.equal(await env.transport.start(), true)
  assert.equal(env.transport._state().hasToken, true)
})

test('入站：私聊/群聊事件归一化并投递；非消息事件不进会话', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  const received = []
  env.transport.onMessage(event => received.push(event))
  assert.equal(await env.transport.start(), true)
  await tick(30)

  env.server.pushMessage({ messageType: 'private', userId: 20002, text: '你好' })
  await waitFor(() => received.length === 1)
  const dm = received[0]
  assert.equal(dm.chatKey, buildChatKey('onebot', '10001', { kind: 'dm', userId: '20002' }))
  assert.equal(dm.text, '你好')
  assert.equal(dm.mentioned, true)

  env.server.pushMessage({
    messageType: 'group',
    groupId: 30003,
    userId: 40004,
    segments: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: ' 帮我看看' } }],
    nickname: 'nick',
    card: '群名片',
  })
  await waitFor(() => received.length === 2)
  assert.deepEqual(received[1].target, { kind: 'group', groupId: '30003' })
  // 协议层保持原样（不带 @我 标记、不带说话人前缀）：群名片在 sender.name，
  // 前缀由 bridge 展示层添加，否则群里命令会被装饰破坏而以普通对话进入模型
  assert.equal(received[1].text, '帮我看看')
  assert.equal(received[1].sender.name, '群名片')
  assert.equal(received[1].mentioned, true)

  // meta_event 不进会话
  await tick(60)
  assert.equal(received.length, 2, '心跳/生命周期不得当消息投递')
})

test('发送：私聊/群聊文本，引用段可带；长文本分段', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  assert.equal(await env.transport.start(), true)
  await tick(30)

  const dm = await env.transport.sendText({ kind: 'dm', userId: '20002' }, '你好呀')
  assert.equal(dm.ok, true)
  const dmCall = env.server.lastAction('send_private_msg')
  assert.equal(dmCall.params.user_id, '20002')
  assert.deepEqual(dmCall.params.message, [{ type: 'text', data: { text: '你好呀' } }])

  const group = await env.transport.sendText({ kind: 'group', groupId: '30003' }, '收到', { replyTo: '555' })
  assert.equal(group.ok, true)
  const groupCall = env.server.lastAction('send_group_msg')
  assert.equal(groupCall.params.group_id, '30003')
  assert.deepEqual(groupCall.params.message[0], { type: 'reply', data: { id: '555' } })
  assert.equal(groupCall.params.message[1].data.text, '收到')

  const before = env.server.state.sent.length
  const long = 'x'.repeat(9000)
  assert.equal((await env.transport.sendText({ kind: 'dm', userId: '20002' }, long)).ok, true)
  const chunks = env.server.state.sent.slice(before).filter(entry => entry.action === 'send_private_msg')
  assert.equal(chunks.length, 3, '9000 字按 4000 上限切成 3 条')
  assert.deepEqual(chunks.map(entry => entry.params.message[0].data.text.length), [4000, 4000, 1000])
})

test('引用失效兜底：NapCat 消息 ID 是 LRU 哈希 → 去掉 reply 段重发一次', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  assert.equal(await env.transport.start(), true)
  await tick(30)

  env.server.setResponder(({ action, params }) => {
    if (action !== 'send_private_msg') return null
    const hasReply = Array.isArray(params.message) && params.message.some(segment => segment.type === 'reply')
    return hasReply ? { status: 'failed', retcode: 100, message: 'reply message_id 不存在' } : null
  })

  const result = await env.transport.sendText({ kind: 'dm', userId: '20002' }, '结果', { replyTo: 'stale-id' })
  assert.equal(result.ok, true, '去引用重发后必须成功')
  const calls = env.server.state.actions.filter(entry => entry.action === 'send_private_msg')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].params.message[0].type, 'reply')
  assert.deepEqual(calls[1].params.message, [{ type: 'text', data: { text: '结果' } }])
})

test('引用：机器人自己发的消息也进引用表（replyTo.text 回填原文）', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  const received = []
  env.transport.onMessage(ev => received.push(ev))
  assert.equal(await env.transport.start(), true)
  await tick(30)

  // 场景来源（真机 2026-09-24）：用户「引用机器人刚发的那条」再提问。
  // 出站消息若不进引用表，replyTo.text 永远为空，模型只看到没头没尾的一句问话。
  const sent = await env.transport.sendText({ kind: 'group', groupId: '30003' }, '机器人刚才说的话')
  assert.equal(sent.ok, true)
  assert.notEqual(sent.messageId, undefined, '发送结果必须带 message_id')

  env.server.pushMessage({
    messageType: 'group',
    groupId: 30003,
    userId: 20002,
    card: '引用的人',
    segments: [
      { type: 'reply', data: { id: String(sent.messageId) } },
      { type: 'text', data: { text: '我引用的这句是什么' } },
    ],
  })
  assert.equal(await waitFor(() => received.length > 0), true)
  assert.equal(received[0].replyTo?.messageId, String(sent.messageId))
  assert.equal(received[0].replyTo?.text, '机器人刚才说的话', '引用机器人自己的消息必须回填原文')

  // 出站媒体：没有正文也要留可读占位，否则引用图片同样查不到内容
  const image = await env.transport.sendMedia(
    { kind: 'group', groupId: '30003' },
    { kind: 'image', url: 'http://127.0.0.1:9/a.png', fileName: 'a.png' },
  )
  assert.equal(image.ok, true)
  env.server.pushMessage({
    messageType: 'group',
    groupId: 30003,
    userId: 20002,
    segments: [
      { type: 'reply', data: { id: String(image.messageId) } },
      { type: 'text', data: { text: '这张图是啥' } },
    ],
  })
  assert.equal(await waitFor(() => received.length > 1), true)
  assert.equal(received[1].replyTo?.text, '[图片]')
})

test('引用别人的消息：带上被引消息的发送人（谁说的）', async t => {
  // 真机 2026-09-24：引用群友的消息提问，机器人只知道原文、不知道谁发的。
  const env = await setup()
  t.after(() => cleanup(env))
  const received = []
  env.transport.onMessage(ev => received.push(ev))
  assert.equal(await env.transport.start(), true)
  await tick(30)

  // 群里另一个人发言（没有 @ 机器人，不会进会话，但 transport 必须记住它）
  env.server.pushMessage({ messageType: 'group', groupId: 30003, userId: 44444, card: '秋月明', text: '我是秦始皇' })
  assert.equal(await waitFor(() => received.length === 1), true)

  // 主人引用那条再提问
  env.server.pushMessage({
    messageType: 'group',
    groupId: 30003,
    userId: 20002,
    card: '秋风清',
    segments: [
      { type: 'reply', data: { id: String(received[0].messageId) } },
      { type: 'text', data: { text: '这个人发的什么' } },
    ],
  })
  assert.equal(await waitFor(() => received.length === 2), true)
  assert.equal(received[1].replyTo?.text, '我是秦始皇')
  assert.deepEqual(received[1].replyTo?.sender, { id: '44444', name: '秋月明' }, '群里取群名片')

  // 引用机器人自己说过的话：发送人应是机器人账号（昵称取自 get_login_info）
  const sent = await env.transport.sendText({ kind: 'group', groupId: '30003' }, '机器人说过的话')
  env.server.pushMessage({
    messageType: 'group',
    groupId: 30003,
    userId: 20002,
    segments: [
      { type: 'reply', data: { id: String(sent.messageId) } },
      { type: 'text', data: { text: '你刚才说的什么' } },
    ],
  })
  assert.equal(await waitFor(() => received.length === 3), true)
  assert.deepEqual(received[2].replyTo?.sender, { id: '10001', name: 'dsh-qq-fake' })
})

test('重启后引用旧消息：内存没有就向 NapCat 要（get_msg 兜底原文与发送人）', async t => {
  // 真机 2026-09-24：重启后引用重启前那句「我是秦始皇」直接失效——引用记忆是内存表，
  // 插件一重启就空了。NapCat 自己留着最近约 5000 条，get_msg 能把它们取回来。
  const env = await setup()
  t.after(() => cleanup(env))
  const received = []
  env.transport.onMessage(ev => received.push(ev))
  assert.equal(await env.transport.start(), true)
  await tick(30)

  env.server.setMessageFixture('old-msg-1', {
    message_id: 999001,
    message: [{ type: 'text', data: { text: '我是秦始皇' } }],
    sender: { user_id: 44444, nickname: '秋月明', card: '秋月明' },
  })

  // 本实例从没见过这条消息（等价于「重启前收到的消息」）
  env.server.pushMessage({
    messageType: 'group',
    groupId: 30003,
    userId: 20002,
    card: '秋风清',
    segments: [
      { type: 'reply', data: { id: 'old-msg-1' } },
      { type: 'text', data: { text: '这句话是什么' } },
    ],
  })
  assert.equal(await waitFor(() => received.length === 1), true)
  assert.equal(received[0].replyTo?.text, '我是秦始皇', '必须经 get_msg 取回原文')
  assert.deepEqual(received[0].replyTo?.sender, { id: '44444', name: '秋月明' }, '发送人也要取回')
  assert.equal(env.server.lastAction('get_msg')?.params.message_id, 'old-msg-1')
})

test('重启后引用旧文件消息：get_msg 把附件也带回来', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  const received = []
  env.transport.onMessage(ev => received.push(ev))
  assert.equal(await env.transport.start(), true)
  await tick(30)

  env.server.setMessageFixture('old-file-1', {
    message_id: 999002,
    message: [{ type: 'file', data: { file: 'file_id_old', file_name: '2025级硕士0915.xls', file_size: 291840 } }],
    sender: { user_id: 44444, nickname: '秋月明' },
  })
  env.server.pushMessage({
    messageType: 'group',
    groupId: 30003,
    userId: 20002,
    segments: [
      { type: 'reply', data: { id: 'old-file-1' } },
      { type: 'text', data: { text: '这文件是什么' } },
    ],
  })
  assert.equal(await waitFor(() => received.length === 1), true)
  assert.equal(received[0].replyTo?.text, '', '文件消息没有文本')
  assert.deepEqual(received[0].replyTo?.media, [
    { kind: 'file', url: 'file_id_old', fileName: '2025级硕士0915.xls', size: 291840 },
  ])
})

test('get_msg 取不到（超出 LRU / 已撤回）时如实留空，不编造被引内容', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  const received = []
  env.transport.onMessage(ev => received.push(ev))
  assert.equal(await env.transport.start(), true)
  await tick(30)

  env.server.pushMessage({
    messageType: 'group',
    groupId: 30003,
    userId: 20002,
    segments: [{ type: 'reply', data: { id: 'gone-msg' } }, { type: 'text', data: { text: '这句是啥' } }],
  })
  assert.equal(await waitFor(() => received.length === 1), true)
  assert.equal(received[0].replyTo?.messageId, 'gone-msg')
  assert.equal(received[0].replyTo?.text, '')
  assert.equal(received[0].replyTo?.sender, undefined)
  assert.equal(received[0].replyTo?.media, undefined)
})

test('被引消息已在内存时走快路径，不额外调 get_msg', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  const received = []
  env.transport.onMessage(ev => received.push(ev))
  assert.equal(await env.transport.start(), true)
  await tick(30)

  env.server.pushMessage({ messageType: 'group', groupId: 30003, userId: 44444, card: '秋月明', text: '我是秦始皇' })
  assert.equal(await waitFor(() => received.length === 1), true)
  env.server.pushMessage({
    messageType: 'group',
    groupId: 30003,
    userId: 20002,
    segments: [
      { type: 'reply', data: { id: String(received[0].messageId) } },
      { type: 'text', data: { text: '这句话是什么' } },
    ],
  })
  assert.equal(await waitFor(() => received.length === 2), true)
  assert.equal(received[1].replyTo?.text, '我是秦始皇')
  assert.equal(env.server.lastAction('get_msg'), null, '内存命中不得多打一次 API')
})

test('群文件：先发文件再引用它提问 → 被引附件随引用一起带过来', async t => {
  // 真机 2026-09-24：QQ 里文件和文字没法合成一条消息，用户只能「先发文件，再引用它提问」。
  // 插件原先只记住消息文本，文件消息没有文本 → 引用退化成空引用，模型回「我这边没有附件」。
  const env = await setup()
  t.after(() => cleanup(env))
  const received = []
  env.transport.onMessage(ev => received.push(ev))
  assert.equal(await env.transport.start(), true)
  await tick(30)

  // ① 群里先发文件（没有 @，router 会忽略它，但 transport 必须记住它带什么附件）
  env.server.pushMessage({
    messageType: 'group',
    groupId: 30003,
    userId: 20002,
    card: '秋风清',
    segments: [{ type: 'file', data: { file: 'file_id_abc', file_name: '2025级硕士0915.xls', file_size: 291840 } }],
  })
  assert.equal(await waitFor(() => received.length === 1), true)
  assert.equal(received[0].media.length, 1, '文件消息本身要作为媒体入站')
  assert.equal(received[0].media[0].fileName, '2025级硕士0915.xls')

  // ② 用户引用那条文件消息提问
  env.server.pushMessage({
    messageType: 'group',
    groupId: 30003,
    userId: 20002,
    card: '秋风清',
    segments: [
      { type: 'reply', data: { id: String(received[0].messageId) } },
      { type: 'text', data: { text: '这个文件讲的什么' } },
    ],
  })
  assert.equal(await waitFor(() => received.length === 2), true)
  assert.equal(received[1].text, '这个文件讲的什么', '当前消息文本保持协议原样')
  assert.equal(received[1].media.length, 0, '当前消息本身没有附件')
  assert.equal(received[1].replyTo?.messageId, String(received[0].messageId))
  assert.deepEqual(received[1].replyTo?.media, [
    { kind: 'file', url: 'file_id_abc', fileName: '2025级硕士0915.xls', size: 291840 },
  ])
})

test('失败分类：参数错不重试、服务未就绪可重试、未连接如实报错', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  // 未连接时发送
  const cold = await env.transport.sendText({ kind: 'dm', userId: '20002' }, 'hi')
  assert.equal(cold.ok, false)
  assert.equal(cold.retryable, true)
  assert.match(cold.error, /未连接/)

  assert.equal(await env.transport.start(), true)
  await tick(30)
  env.server.setResponder(({ action }) => (action === 'send_group_msg' ? { status: 'failed', retcode: 100, message: '参数错误' } : null))
  const param = await env.transport.sendText({ kind: 'group', groupId: '30003' }, 'hi')
  assert.equal(param.ok, false)
  assert.equal(param.retryable, false, '1xx 不该重试')

  env.server.setResponder(({ action }) => (action === 'send_group_msg' ? { status: 'failed', retcode: 300, message: '服务未就绪' } : null))
  const transient = await env.transport.sendText({ kind: 'group', groupId: '30003' }, 'hi')
  assert.equal(transient.retryable, true, '3xx 值得退避重试')
})

test('媒体：图片/语音作为消息段、文件走上传接口、说明文字混排', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  assert.equal(await env.transport.start(), true)
  await tick(30)

  assert.equal((await env.transport.sendMedia({ kind: 'dm', userId: '20002' }, { kind: 'image', url: 'https://x.invalid/a.png' })).ok, true)
  const imageCall = env.server.lastAction('send_private_msg')
  assert.deepEqual(imageCall.params.message[0], { type: 'image', data: { file: 'https://x.invalid/a.png' } })

  assert.equal(
    (await env.transport.sendMedia({ kind: 'group', groupId: '30003' }, { kind: 'audio', base64: Buffer.from('silk').toString('base64'), caption: '转写如下' })).ok,
    true,
  )
  const recordCall = env.server.lastAction('send_group_msg')
  assert.equal(recordCall.params.message[0].type, 'record')
  assert.match(recordCall.params.message[0].data.file, /^base64:\/\//)
  assert.equal(recordCall.params.message[1].data.text, '转写如下', '说明文字与媒体混排成一条')

  assert.equal((await env.transport.sendMedia({ kind: 'group', groupId: '30003' }, { kind: 'file', path: '/tmp/a.pdf', fileName: 'a.pdf' })).ok, true)
  const uploadCall = env.server.lastAction('upload_group_file')
  assert.equal(uploadCall.params.group_id, '30003')
  assert.equal(uploadCall.params.name, 'a.pdf')

  assert.equal((await env.transport.sendMedia({ kind: 'dm', userId: '20002' }, { kind: 'file', path: '/tmp/b.zip' })).ok, true)
  assert.equal(env.server.lastAction('upload_private_file').params.user_id, '20002')

  assert.equal((await env.transport.sendMedia({ kind: 'dm', userId: '20002' }, { kind: 'image' })).ok, false, '没有来源要如实报错')
})

test('媒体下载：base64/data URL/HTTP 直取，同源才带 token，超限如实报错', async t => {
  const env = await setup({ serverOptions: { token: 'tk' }, onebotOverrides: { accessToken: 'tk' } })
  t.after(() => cleanup(env))
  assert.equal(await env.transport.start(), true)
  await tick(30)

  const inline = await env.transport.downloadMedia(`base64://${Buffer.from('hello').toString('base64')}`)
  assert.equal(inline.ok, true)
  assert.equal(inline.data.toString(), 'hello')

  const dataUrl = await env.transport.downloadMedia(`data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`)
  assert.equal(dataUrl.ok, true)
  assert.equal(dataUrl.contentType, 'image/png')

  const http = await env.transport.downloadMedia(`${env.server.baseUrl}/media/a.png?size=32`)
  assert.equal(http.ok, true)
  assert.equal(http.bytes, 32)
  const request = env.server.state.mediaRequests.at(-1)
  assert.equal(request.auth, 'Bearer tk', '同源请求带 token（NapCat 媒体端点需要鉴权）')

  const tooBig = await env.transport.downloadMedia('base64://' + Buffer.alloc(64).toString('base64'), { maxBytes: 8 })
  assert.equal(tooBig.ok, false)
  assert.match(tooBig.error, /超过上限/)

  // 预检：编码长度明显超过上限时，不应先解码再报错
  const hugeEncoded = 'A'.repeat(Math.ceil(8 / 3) * 4 + 100)
  const prechecked = await env.transport.downloadMedia(`base64://${hugeEncoded}`, { maxBytes: 8 })
  assert.equal(prechecked.ok, false)
  assert.match(prechecked.error, /编码长度/)
  const precheckedData = await env.transport.downloadMedia(`data:image/png;base64,${hugeEncoded}`, { maxBytes: 8 })
  assert.equal(precheckedData.ok, false)
  assert.match(precheckedData.error, /编码长度/)

  // file:// 引用：先 get_file 再下载
  const byRef = await env.transport.downloadMedia('file://hash-1', { maxBytes: 4096 })
  assert.equal(byRef.ok, true)
  assert.notEqual(env.server.lastAction('get_file'), null)
})

test('媒体下载：get_file 的本地路径只允许 dataDir / NapCat 根内', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-media-inside-'))
  const outsideDir = await mkdtemp(join(tmpdir(), 'dsh-qq-media-outside-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  t.after(() => rm(outsideDir, { recursive: true, force: true }))
  const inside = join(dir, 'ok.bin')
  const outside = join(outsideDir, 'bad.bin')
  await writeFile(inside, Buffer.from('hello'))
  await writeFile(outside, Buffer.from('secret'))

  const env = await setup({ configOverrides: { dataDir: dir } })
  t.after(() => cleanup(env))
  assert.equal(await env.transport.start(), true)
  await tick(30)

  env.server.setResponder(({ action }) => (action === 'get_file' ? { status: 'ok', retcode: 0, data: { file: inside, url: inside } } : null))
  const okDownload = await env.transport.downloadMedia('local-inside', { maxBytes: 100 })
  assert.equal(okDownload.ok, true, okDownload.error)
  assert.equal(okDownload.data.toString(), 'hello')

  env.server.setResponder(({ action }) => (action === 'get_file' ? { status: 'ok', retcode: 0, data: { file: outside, url: outside } } : null))
  const blocked = await env.transport.downloadMedia('local-outside', { maxBytes: 100 })
  assert.equal(blocked.ok, false)
  assert.match(blocked.error, /允许目录/)
})

test('输入状态：私聊 best-effort 调 set_input_status，群聊跳过（NapCat 无对应接口）', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  assert.equal(await env.transport.start(), true)
  await tick(30)
  assert.equal((await env.transport.sendTyping({ kind: 'dm', userId: '20002' })).ok, true)
  assert.equal(env.server.lastAction('set_input_status').params.user_id, '20002')
  assert.deepEqual(await env.transport.sendTyping({ kind: 'group', groupId: '30003' }), { ok: true, skipped: true })
})

test('按钮：如实拒绝（能力表已声明 keyboard=false，审批走文本命令）', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  const result = await env.transport.sendKeyboard({ kind: 'dm', userId: '1' }, '允许吗', [{ label: '允许', data: 'x' }])
  assert.equal(result.ok, false)
  assert.match(result.error, /没有消息按钮|文本命令/)
})

test('加好友/加群请求：记录并可处理（owner 用命令放行）', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  assert.equal(await env.transport.start(), true)
  await tick(30)

  env.server.pushRequest({ requestType: 'friend', userId: 50005, flag: 'flag-friend', comment: '交个朋友' })
  await waitFor(() => env.transport.requests().length === 1)
  const [request] = env.transport.requests()
  assert.equal(request.flag, 'flag-friend')
  assert.equal(request.type, 'friend')
  assert.equal(env.transport.status().pendingRequests, 1)

  const resolved = await env.transport.resolveRequest('flag-friend', true)
  assert.equal(resolved.ok, true)
  assert.equal(env.server.lastAction('set_friend_add_request').params.approve, true)
  assert.equal(env.transport.requests().length, 0, '处理完就从待办里移除')

  env.server.pushRequest({ requestType: 'group', userId: 50005, groupId: 60006, flag: 'flag-group' })
  await waitFor(() => env.transport.requests().length === 1)
  assert.equal((await env.transport.resolveRequest('flag-group', false)).ok, true)
  assert.equal(env.server.lastAction('set_group_add_request').params.group_id, undefined)
  assert.equal(env.server.lastAction('set_group_add_request').params.approve, false)

  assert.equal((await env.transport.resolveRequest('不存在', true)).ok, false, '未知 flag 如实报错')
})

test('断线重连：连接被断开后按退避自动重连，且能重新握手', async t => {
  const env = await setup({ deps: { backoffMs: [20] } })
  t.after(() => cleanup(env))
  assert.equal(await env.transport.start(), true)
  await tick(30)
  assert.equal(env.server.state.clients, 1)

  env.server.dropConnection(1006, 'test drop')
  const reconnected = await waitFor(() => env.server.state.clients >= 2 && env.transport.status().connected === true, 3000)
  assert.equal(reconnected, true, '应自动重连并重新握手')
})

test('心跳看门狗：服务端停发心跳超过阈值 → 主动重连（半开 socket 不再卡死）', async t => {
  const env = await setup({
    serverOptions: { heartbeatIntervalMs: 0 },
    onebotOverrides: { heartbeatTimeoutMs: 5000 },
    deps: { backoffMs: [20] },
  })
  t.after(() => cleanup(env))
  assert.equal(await env.transport.start(), true)
  await tick(30)
  const firstClients = env.server.state.clients

  // 心跳阈值 5s：看门狗周期 = 5000/3 ≈ 1667ms，等它判定超时并重连
  const reconnected = await waitFor(() => env.server.state.clients > firstClients, 8000, 50)
  assert.equal(reconnected, true, '心跳超时应主动断开重连')
  assert.equal(await waitFor(() => env.transport.status().connected === true, 3000), true)
  // 回归（1006 保留码被协议拒绝、异常被吞）：旧连接必须真的关掉，否则会双连接/重复处理
  assert.equal(await waitFor(() => env.server.state.sockets.size === 1, 2000), true, '旧 socket 必须关掉')
})

test('出站限速：sendRateLimitMs 生效（个人号风控友好）', async t => {
  const env = await setup({ onebotOverrides: { sendRateLimitMs: 120 } })
  t.after(() => cleanup(env))
  assert.equal(await env.transport.start(), true)
  await tick(30)
  const startedAt = Date.now()
  await env.transport.sendText({ kind: 'dm', userId: '20002' }, '一')
  await env.transport.sendText({ kind: 'dm', userId: '20002' }, '二')
  await env.transport.sendText({ kind: 'dm', userId: '20002' }, '三')
  const elapsed = Date.now() - startedAt
  // 允许 ~20ms 的定时器抖动：setTimeout(120) 实测可能落在 119.x（Date.now 取整后差 1ms），
  // 断言 240 会在全量并跑时偶发失败；没有限速时 elapsed ≈ 0，220 仍能抓住回归。
  assert.ok(elapsed >= 220, `三条消息至少间隔 2×120ms（实测 ${elapsed}ms）`)
})

test('诊断与脱敏：状态里的端点、错误信息都不含 token', async t => {
  const env = await setup({ serverOptions: { token: 'super-secret' }, onebotOverrides: { accessToken: 'super-secret' } })
  t.after(() => cleanup(env))
  assert.equal(await env.transport.start(), true)
  await tick(30)
  const status = env.transport.status()
  assert.equal(JSON.stringify(status).includes('super-secret'), false, '状态里绝不能出现 token')
  const logs = JSON.stringify(env.logger.entries)
  assert.equal(logs.includes('super-secret'), false, '日志里绝不能出现 token')

  assert.equal(redactEndpoint('ws://h:3001?access_token=abc'), 'ws://h:3001?access_token=***')
})

test('插件卸载/热重载：scope.dispose() 必须断开 WS（否则旧实例继续收事件、消息被处理两遍）', async t => {
  const env = await setup()
  assert.equal(await env.transport.start(), true)
  await tick(30)
  assert.equal(env.server.state.sockets.size, 1, '连接已建立')

  await env.scope.dispose()
  assert.equal(
    await waitFor(() => env.server.state.sockets.size === 0, 2000),
    true,
    'scope 释放后 NapCat 侧不该再有连接',
  )
  assert.equal(env.transport.status().connected, false)
  await env.server.close()
})

// ── 审查建议落地：写安全 / 代次 / 后端画像 / 去重 / 自身消息 / 请求字段 ──

test('写操作超时：结果未知 → 不自动重试、不重复发送（unknown-outcome）', async t => {
  const env = await setup({ serverOptions: { heartbeatIntervalMs: 0 } })
  t.after(() => cleanup(env))
  assert.equal(await env.transport.start(), true)
  await tick(30)

  env.server.dropResponse('send_group_msg') // 服务端收到了，但不回响应
  const before = env.server.state.actions.filter(a => a.action === 'send_group_msg').length
  const result = await env.transport.sendText({ kind: 'group', groupId: '30003' }, '只应发一次')

  assert.equal(result.ok, false)
  assert.equal(result.retryClass, 'unknown-outcome', '写操作超时属于结果未知')
  assert.equal(result.retryable, false, '绝不能自动重试')
  await tick(100)
  const after = env.server.state.actions.filter(a => a.action === 'send_group_msg').length
  assert.equal(after - before, 1, '只发一次，不能重复发送')
})

test('读操作超时：可安全重试（retryClass=safe）', async t => {
  const env = await setup({ serverOptions: { heartbeatIntervalMs: 0 } })
  t.after(() => cleanup(env))
  assert.equal(await env.transport.start(), true)
  await tick(30)
  env.server.dropResponse('get_status')
  // 直接走 API 判定：用 get_status 触发超时（15s 太长，用短 apiTimeoutMs）
  const short = await setup({ serverOptions: { heartbeatIntervalMs: 0 }, onebotOverrides: { apiTimeoutMs: 1200 } })
  t.after(() => cleanup(short))
  assert.equal(await short.transport.start(), true)
  await tick(30)
  short.server.dropResponse('get_status')
  const t0 = Date.now()
  const status = await short.transport._call('get_status')
  assert.equal(status.retryClass, 'safe', '读操作超时可重试')
  assert.ok(Date.now() - t0 >= 1000, '确实等到了超时')
  await env.server.close()
})

test('连接断开：在途调用立即结束，不等 15 秒超时', async t => {
  const env = await setup({ serverOptions: { heartbeatIntervalMs: 0 } })
  t.after(() => cleanup(env))
  assert.equal(await env.transport.start(), true)
  await tick(30)
  env.server.dropResponse('get_status')
  const startedAt = Date.now()
  const pending = env.transport._call('get_status')
  await tick(60)
  env.server.dropConnection(1006, 'drop while pending')
  const result = await pending
  assert.equal(result.ok, false)
  assert.ok(Date.now() - startedAt < 5000, `断连应立即结算（实测 ${Date.now() - startedAt}ms）`)
  assert.equal(env.transport.status().pendingCalls, 0, 'pending 必须清空')
})

test('后端画像：NapCat 才启用扩展能力（typing / get_file / upload_private_file）', async t => {
  const napcat = await setup()
  t.after(() => cleanup(napcat))
  assert.equal(await napcat.transport.start(), true)
  await tick(30)
  assert.equal(napcat.transport.backend().implementation, 'napcat')
  assert.equal(napcat.transport.capabilities().typing, true, '识别到 NapCat → 支持输入状态')
  assert.equal(napcat.transport.status().backend, 'napcat')

  const unknown = await setup({ serverOptions: { versionInfo: { app_name: 'other-impl', app_version: '1.0' } } })
  t.after(() => cleanup(unknown))
  assert.equal(await unknown.transport.start(), true)
  await tick(30)
  assert.equal(unknown.transport.backend().implementation, 'other-impl')
  assert.equal(unknown.transport.capabilities().typing, false, '未知后端不得声明 typing（否则上层会调不存在的接口）')
})

test('去重：复合键（chatKey + message_id）——同 id 重复投递一次，跨会话不误伤', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  const received = []
  env.transport.onMessage(event => received.push(event))
  assert.equal(await env.transport.start(), true)
  await tick(30)

  const event = {
    post_type: 'message',
    message_type: 'private',
    message_id: 777,
    user_id: 20002,
    time: Math.floor(Date.now() / 1000),
    message: [{ type: 'text', data: { text: '重复投递' } }],
    sender: { user_id: 20002, nickname: 'N' },
  }
  env.server.duplicateEvent(event)
  await waitFor(() => received.length >= 1)
  await tick(80)
  assert.equal(received.length, 1, '同一会话同一 message_id 只处理一次')

  // 另一个会话用同样的 message_id：不得被误判为重复
  env.server.pushMessage({ messageType: 'group', groupId: 30003, userId: 40004, messageId: 777, text: '同 id 不同会话' })
  await waitFor(() => received.length === 2)
  await tick(60)
  assert.equal(received.length, 2, '复合键不能跨会话误杀')
})

test('自身消息防御性过滤：自己发的消息不进桥接（防自问自答成环）', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  const received = []
  env.transport.onMessage(event => received.push(event))
  assert.equal(await env.transport.start(), true)
  await tick(30)
  env.server.pushMessage({ messageType: 'private', userId: 10001, text: '我自己发的' }) // userId === self_id
  await tick(80)
  assert.equal(received.length, 0)
})

test('请求记录：保存 sub_type 并在处理群请求时回传；同一 flag 不能处理两次', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  assert.equal(await env.transport.start(), true)
  await tick(30)

  env.server.pushRequest({ requestType: 'group', userId: 50005, groupId: 60006, flag: 'flag-invite' })
  await waitFor(() => env.transport.requests().length === 1)
  const [record] = env.transport.requests()
  assert.equal(record.subType, 'add', '真实协议字段必须落库')
  assert.equal(typeof record.expiresAt, 'number')
  assert.equal(record.handled, false)

  assert.equal((await env.transport.resolveRequest('flag-invite', true)).ok, true)
  const call = env.server.lastAction('set_group_add_request')
  assert.equal(call.params.sub_type, 'add', 'OneBot 群请求必须带 sub_type')
  assert.equal(call.params.group_id, undefined)
  assert.equal(env.transport.requests().length, 0)

  const again = await env.transport.resolveRequest('flag-invite', true)
  assert.equal(again.ok, false, '不能重复处理同一个请求')
  assert.match(again.error, /没有待处理请求|已处理/)
})

test('鉴权失败是终端状态：不会被握手兜底降级成 disconnected，/qq-reconnect 后可再次尝试', async t => {
  const env = await setup({ serverOptions: { token: 'secret-token' }, onebotOverrides: { accessToken: 'wrong-token' } })
  t.after(() => cleanup(env))
  await env.transport.start()
  await tick(200)
  assert.equal(env.transport.status().phase, 'auth-failed')
  await tick(400)
  assert.equal(env.transport.status().phase, 'auth-failed', '不能被兜底逻辑改写')

  // 用户改对 token 后显式重连（stop + start）：应当重新尝试并成功
  await env.transport.stop()
  env.transport._setTokenForTest('secret-token')
  assert.equal(await env.transport.start(), true, '/qq-reconnect 后应能重新鉴权成功')
  assert.equal(env.transport.status().connected, true)
})

test('重连成功要清掉旧的 lastError（不能一直挂着上次的失败原因）', async () => {
  // apiTimeoutMs 调小：本用例只关心「失败后恢复」的语义，不想为 15s 握手超时等满。
  // 用 try/finally 保证失败路径也会清理 socket/定时器，否则测试进程会被挂住。
  const env = await setup({ onebotOverrides: { apiTimeoutMs: 1000 }, deps: { backoffMs: [10, 10, 10] } })
  try {
    // 第一次握手不响应 → start 失败并写下错误
    env.server.dropResponse('get_login_info')
    const started = await env.transport.start({ signal: env.scope.signal })
    assert.equal(started, false, '握手超时应启动失败')
    assert.match(env.transport.status().lastError, /get_login_info|无响应/)
    // 恢复响应 → 内部退避重连成功后，旧错误必须清空
    env.server.resumeResponses()
    assert.equal(await waitFor(() => env.transport.status().connected === true, 8000), true, '内部退避重连应成功')
    assert.equal(env.transport.status().lastError, '', '连接成功后 lastError 必须清空')
  } finally {
    await cleanup(env)
  }
})


// ── 机器人资料（昵称）：握手 get_login_info 已带回 nickname，直接暴露给页面 ──

test('getProfile：返回握手时的昵称与账号，不额外请求', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  await env.transport.start()
  assert.equal(await waitFor(() => env.transport.status().connected === true), true)

  const profile = await env.transport.getProfile()
  assert.equal(profile.name, 'dsh-qq-fake', '昵称来自 get_login_info')
  assert.match(profile.id, /^\d+$/, 'id 是 QQ 号')
  assert.equal(profile.avatar, '', '头像由页面按 QQ 号拼 qlogo，传输层不填')
})

test('getProfile：未连接且没有账号信息时返回 null', async () => {
  const env = await setup()
  // 不 start：accountId 来自 config（case 里默认空），accountName 为空
  try {
    assert.equal(await env.transport.getProfile(), null)
  } finally {
    await cleanup(env)
  }
})

test('去重先于引用补全：重复投递的同一条消息不会再打一次 get_msg', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  const received = []
  env.transport.onMessage(ev => received.push(ev))
  assert.equal(await env.transport.start(), true)
  await tick(30)
  env.server.setMessageFixture('old-msg-2', {
    message_id: 999002,
    message: [{ type: 'text', data: { text: '被引用的旧消息' } }],
    sender: { user_id: 44444, nickname: '秋月明' },
  })
  const raw = {
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    self_id: 10001,
    group_id: 30003,
    user_id: 20002,
    message_id: 777001,
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: 20002, nickname: '秋风清' },
    message: [
      { type: 'reply', data: { id: 'old-msg-2' } },
      { type: 'text', data: { text: '这句话是什么' } },
    ],
  }
  env.server.pushEvent(raw)
  env.server.pushEvent(raw)
  assert.equal(await waitFor(() => received.length === 1), true)
  await tick(60)
  assert.equal(received.length, 1, '重复事件只处理一次')
  const getMsgCalls = env.server.state.actions.filter(entry => entry.action === 'get_msg').length
  assert.equal(getMsgCalls, 1, '重复事件不该再触发 get_msg（去重必须早于引用补全）')
})
