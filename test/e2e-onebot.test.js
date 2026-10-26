/**
 * 二期端到端：插件装配（apply）→ OneBot transport → 假 NapCat 服务 → DSH 会话 → 回发 QQ。
 *
 * 与 test/onebot.test.js 的分工：
 *   - onebot.test.js：transport 与协议本身（连接/鉴权/媒体/失败分类）；
 *   - 本文件：整条上层链路（router → bridge → agent → 回复），证明「上层零改动」不是口号。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, getPluginHandle } from '../lib/index.js'
import { startFakeNapCatServer } from './helpers/fake-napcat-server.js'
import { createFakeAgents, createFakeCtx, createLogger } from './helpers/fake-ctx.js'

const tick = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(predicate, timeoutMs = 3000, stepMs = 20) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await tick(stepMs)
  }
  return predicate()
}

/**
 * 等到首条入站消息真的进入会话。
 *
 * agents.create 与 bridge.followup 不在同一个 tick：只等 created.length 就断言 followed[0]
 * 会在慢机器/全量并跑时偶发空（本机基线跑 401 用例时命中过一次）。这里等 followup 落地。
 */
async function waitForFirstFollowup(env, timeoutMs = 3000) {
  const ready = await waitFor(() => {
    const entry = env.agents.created[0]
    if (entry === undefined) return false
    const agent = env.agents.live.get(entry.sessionId)
    return agent !== undefined && Array.isArray(agent.followed) && agent.followed.length > 0
  }, timeoutMs)
  assert.equal(ready, true, '入站消息应在超时前进入会话')
  return env.agents.live.get(env.agents.created[0].sessionId)
}

/** 启动「插件 + 假 NapCat」的完整环境（走真实 WS 与真实事件链路）。 */
async function setup({ onebotOverrides = {}, configOverrides = {}, serverOptions = {}, services = {} } = {}) {
  const server = await startFakeNapCatServer({ heartbeatIntervalMs: 500, ...serverOptions })
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-onebot-e2e-'))
  const agents = createFakeAgents()
  const logger = createLogger()
  const ctx = createFakeCtx({
    services: {
      agents,
      ...services,
      dshQqTransportDeps: { backoffMs: [10, 10, 10] },
    },
    logger,
  })
  await apply(ctx, {
    transport: 'onebot',
    autoConnect: true,
    dataDir: dir,
    // 端到端关注链路本身：陌生人配对策略单独在 pairing 用例里验证，这里放开聊天授权
    pairingPolicy: 'open',
    onebot: { wsUrl: server.wsUrl, sendRateLimitMs: 0, ...onebotOverrides },
    ...configOverrides,
  })
  const plugin = getPluginHandle(ctx)
  // 聊天域在 open 策略下发开；命令域仍需角色（与一期行为一致），这里把测试用户设为 owner
  await plugin.store.addAuthorized('20002', { role: 'owner' })
  await plugin.ready
  await tick(50)
  return { server, plugin, agents, ctx, logger, dir }
}

const cleanup = async ({ server, ctx }) => {
  await ctx.dispose()
  await server.close()
}

/** 最近的出站文本（从假 NapCat 收到的 send_* 调用里取）。 */
const outboundTexts = server =>
  server.state.sent
    .filter(entry => entry.action === 'send_private_msg' || entry.action === 'send_group_msg')
    .map(entry => entry.params.message.filter(segment => segment.type === 'text').map(segment => segment.data.text).join(''))

test('端到端（onebot）：QQ 私聊 → DSH 会话 → 回复经 send_private_msg 回到 QQ', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  assert.equal(env.plugin.transport.status().connected, true)
  assert.equal(env.plugin.transport.status().accountId, '10001')

  env.server.pushMessage({ messageType: 'private', userId: 20002, text: 'ping' })
  const agent = await waitForFirstFollowup(env)
  assert.equal(agent.followed[0].content[0].text, 'ping')
  agent.reply('pong')
  agent.ctx.emitStatus('idle')

  const replied = await waitFor(() => outboundTexts(env.server).includes('pong'))
  assert.equal(replied, true, '回复必须发回 QQ')
  const call = env.server.lastAction('send_private_msg')
  assert.equal(call.params.user_id, '20002')
})

test('聊天私聊：首条和后续气泡默认都不附带 reply 消息段', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  await env.plugin.store.setMode('onebot:10001:dm:20002', 'chat')
  env.server.pushMessage({ messageType: 'private', userId: 20002, text: '不要引用，直接说就行' })
  const agent = await waitForFirstFollowup(env)
  agent.reply('行\n\n这样清爽多了').ctx.emitStatus('idle')
  assert.equal(await waitFor(() => outboundTexts(env.server).includes('这样清爽多了'), 6000), true)
  const sent = env.server.state.sent.filter(entry => entry.action === 'send_private_msg')
  assert.equal(sent.length, 2)
  assert.ok(sent.every(entry => entry.params.message.every(segment => segment.type !== 'reply')))
})

test('聊天群聊：@后的连续短句合为一次输入，首条回复不会秒发', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  await env.plugin.store.setMode('onebot:10001:group:30003', 'chat')
  const started = Date.now()
  env.server.pushMessage({ messageType: 'group', groupId: 30003, userId: 40004, text: '摸头多少钱',
    segments: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: '摸头多少钱' } }] })
  await tick(80)
  env.server.pushMessage({ messageType: 'group', groupId: 30003, userId: 40004, text: '给你条鱼' })
  const agent = await waitForFirstFollowup(env)
  const input = agent.followed[0].content.filter(item => item.type === 'text').map(item => item.text).join('\n')
  assert.match(input, /摸头多少钱/)
  assert.match(input, /给你条鱼/)
  assert.equal(agent.followed.length, 1)
  agent.reply('成交，鱼先交出来').ctx.emitStatus('idle')
  await tick(30)
  if (Date.now() - started < 950) assert.equal(outboundTexts(env.server).length, 0, '输入窗口结束后仍须等待自然反应时间')
  assert.equal(await waitFor(() => outboundTexts(env.server).includes('成交，鱼先交出来'), 4000), true)
  assert.ok(Date.now() - started >= 1000)
})

test('群聊：@ 机器人才进会话（默认），群名片进文本前缀', async t => {
  const env = await setup()
  t.after(() => cleanup(env))

  // 没 @ 机器人：必须被 router 静默忽略
  env.server.pushMessage({ messageType: 'group', groupId: 30003, userId: 40004, text: '大家好啊' })
  await tick(120)
  assert.equal(env.agents.created.length, 0, '群聊未被 @ 不得建会话')

  // @ 机器人：进会话，且带上说话人
  env.server.pushMessage({
    messageType: 'group',
    groupId: 30003,
    userId: 40004,
    card: '小明',
    segments: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: ' 帮我看下' } }],
  })
  const agent = await waitForFirstFollowup(env)
  const texts = agent.followed[0].content.filter(block => block.type === 'text').map(block => block.text)
  assert.equal(texts.at(-1), '[小明|40004] 帮我看下', '展示层加 sanitize 过的说话人标签（昵称+QQ 号）')
  // 群记忆把那句「没 @ 机器人」的发言也带进了上下文（含未 @ 的群消息是设计目标）
  assert.equal(
    texts.some(text => text.startsWith('[群最近消息') && text.includes('大家好啊')),
    true,
    '未 @ 的群消息应作为上下文注入',
  )
  assert.equal(
    texts.some(text => text.startsWith('[群最近消息') && text.includes('帮我看下')),
    false,
    '本条消息不得出现在自己这一轮的上下文里',
  )

  agent.reply('看了，没问题')
  agent.ctx.emitStatus('idle')
  assert.equal(await waitFor(() => outboundTexts(env.server).includes('看了，没问题')), true)
  assert.equal(env.server.lastAction('send_group_msg').params.group_id, '30003')
})

test('群聊：freeReplyGroups 白名单 / mentionRequired=false 时免 @ 也回', async t => {
  const whitelisted = await setup({ configOverrides: { freeReplyGroups: ['30003'] } })
  t.after(() => cleanup(whitelisted))
  whitelisted.server.pushMessage({ messageType: 'group', groupId: 30003, userId: 40004, text: '免 @ 的一句' })
  assert.equal(await waitFor(() => whitelisted.agents.created.length === 1), true, '白名单群免 @ 进会话')

  const openAll = await setup({ configOverrides: { mentionRequired: false } })
  t.after(() => cleanup(openAll))
  openAll.server.pushMessage({ messageType: 'group', groupId: 99999, userId: 40004, text: '所有群都回' })
  assert.equal(await waitFor(() => openAll.agents.created.length === 1), true, 'mentionRequired=false 放开所有群')
})

test('命令：/qq-* 由 router 拦截，绝不进 LLM context', async t => {
  const env = await setup()
  t.after(() => cleanup(env))

  env.server.pushMessage({ messageType: 'private', userId: 20002, text: '/qq-help' })
  const replied = await waitFor(() => outboundTexts(env.server).some(text => text.includes('dsh-qq 命令')))
  assert.equal(replied, true, '命令应有本地回复')
  assert.equal(env.agents.created.length, 0, '命令不得创建会话、不得进 LLM')

  // /qq-status 显示 onebot 端点
  env.server.pushMessage({ messageType: 'private', userId: 20002, text: '/qq-status' })
  assert.equal(
    await waitFor(() => outboundTexts(env.server).some(text => text.includes('端点：ws://127.0.0.1'))),
    true,
    '状态里应显示 OneBot 端点（已脱敏）',
  )
})

test('群聊命令：@机器人 发 /qq-* 必须被 router 拦截，绝不进 LLM（真机踩坑回归）', async t => {
  const env = await setup()
  t.after(() => cleanup(env))

  // 群里 @机器人 发命令：协议归一化后文本必须仍以 / 开头，否则会被当普通对话
  env.server.pushMessage({
    messageType: 'group',
    groupId: 30003,
    userId: 20002,
    card: '秋风清',
    segments: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: ' /qq-status' } }],
  })
  const replied = await waitFor(() => outboundTexts(env.server).some(text => text.includes('dsh-qq 状态')))
  assert.equal(replied, true, '群里的命令必须被执行并回复')
  assert.equal(env.agents.created.length, 0, '命令绝不能创建会话/进 LLM')

  const call = env.server.lastAction('send_group_msg')
  assert.equal(call.params.group_id, '30003', '回复要回群里')
})

test('群聊普通消息：文本进模型时带 [群名片] 前缀（展示层负责，不污染协议层）', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  env.server.pushMessage({
    messageType: 'group',
    groupId: 30003,
    userId: 20002,
    card: '秋风清',
    segments: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: ' 帮我看下' } }],
  })
  const agent = await waitForFirstFollowup(env)
  assert.equal(agent.followed[0].content[0].text, '[秋风清|20002] 帮我看下')
})

test('命令：/qq-login 走 NapCat 引导而不是扫码流程；/qq-requests 与 /qq-request 处理请求', async t => {
  const env = await setup()
  t.after(() => cleanup(env))

  env.server.pushMessage({ messageType: 'private', userId: 20002, text: '/qq-login' })
  assert.equal(
    await waitFor(() => outboundTexts(env.server).some(text => text.includes('NapCat 侧完成'))),
    true,
    '应提示去 NapCat 扫码，而不是生成二维码',
  )

  env.server.pushRequest({ requestType: 'friend', userId: 50005, flag: 'flag-1', comment: '想加个好友' })
  await waitFor(() => env.plugin.transport.requests().length === 1)
  env.server.pushMessage({ messageType: 'private', userId: 20002, text: '/qq-requests' })
  assert.equal(
    await waitFor(() => outboundTexts(env.server).some(text => text.includes('加好友 50005'))),
    true,
    '请求列表应可用',
  )

  env.server.pushMessage({ messageType: 'private', userId: 20002, text: '/qq-request 0 allow' })
  assert.equal(
    await waitFor(() => env.server.lastAction('set_friend_add_request') !== null),
    true,
    '应调用 OneBot 的处理接口',
  )
  assert.equal(env.server.lastAction('set_friend_add_request').params.approve, true)
})

test('审批：OneBot 没有按钮 → 自动降级为纯文本推送（capabilities 驱动，无 kind 判断）', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  env.server.pushMessage({ messageType: 'private', userId: 20002, text: '跑个命令' })
  await waitFor(() => env.agents.created.length === 1)
  const sessionId = env.agents.created[0].sessionId

  // 走真实审批链路：approval/request waterfall → QQ 推送
  const pending = env.ctx.emitWaterfall('approval/request', {
    agent: { session: { id: sessionId } },
    toolName: 'bash',
    reason: 'rm -rf build',
  })
  // 审批推送是异步的：等它真的到达 QQ 再回复文本
  const delivered = await waitFor(() => outboundTexts(env.server).some(text => text.includes('需要你批准一次敏感操作')))
  assert.equal(delivered, true, '审批必须推到 QQ')
  const pushed = outboundTexts(env.server).find(text => text.includes('需要你批准一次敏感操作'))
  assert.match(pushed, /bash/)
  assert.match(pushed, /approve \/ deny/, '无按钮时要告诉用户改用文本回复')
  assert.equal(
    env.server.state.actions.some(entry => entry.action === 'send_keyboard'),
    false,
    'OneBot 不应调用不存在的键盘接口',
  )

  // 文本审批（approve）应能放行
  env.server.pushMessage({ messageType: 'private', userId: 20002, text: 'approve' })
  const answer = await Promise.race([pending, tick(1500).then(() => null)])
  assert.equal(answer, 'allowed-once', '文本 approve 应被审批链路接受（waterfall 的结局就是审批结论）')
})

test('会话隔离：onebot 与 qqbot 的 chatKey 命名空间不串（同一 QQ 号也不碰撞）', async t => {
  const env = await setup()
  t.after(() => cleanup(env))
  env.server.pushMessage({ messageType: 'private', userId: 20002, text: 'hi' })
  await waitFor(() => env.agents.created.length === 1)
  const chatKeys = [...env.plugin.store.chatKeys()]
  assert.equal(chatKeys.length, 1)
  assert.match(chatKeys[0], /^onebot:10001:dm:20002$/)
})

test('可靠性：假 NapCat 断线 → 自动重连 → 重连后消息照常进会话', async t => {
  const env = await setup({ onebotOverrides: { heartbeatTimeoutMs: 90_000 } })
  t.after(() => cleanup(env))
  env.server.dropConnection(1006, 'e2e drop')
  // close 事件是异步的：先等确实断开，再等重新握手完成，避免把消息推到正在关闭的 socket 上
  await waitFor(() => env.plugin.transport.status().connected === false, 2000)
  assert.equal(
    await waitFor(() => env.plugin.transport.status().connected === true && env.server.state.sockets.size === 1, 5000),
    true,
    '应自愈',
  )
  await tick(80)

  env.server.pushMessage({ messageType: 'private', userId: 20002, text: '重连后还能收到吗' })
  const agent = await waitForFirstFollowup(env)
  assert.equal(agent.followed[0].content[0].text, '重连后还能收到吗')
})

test('配对：批准后自动补答陌生人的首条消息（不必再发一遍）', async t => {
  const env = await setup({ configOverrides: { pairingPolicy: 'pairing' } })
  t.after(() => cleanup(env))
  await env.plugin.store.setHomeChannel('20002')

  // 陌生人私聊：只拿到「等待管理员批准」，不建会话
  env.server.pushMessage({ messageType: 'private', userId: 40004, text: '你好，请问你能做什么' })
  assert.equal(await waitFor(() => outboundTexts(env.server).some(text => text.includes('等待管理员批准'))), true)
  assert.equal(env.agents.created.length, 0, '未授权不得建会话')
  const pending = env.plugin.store.pendingPairing()
  assert.equal(pending.length, 1)
  assert.equal(pending[0].message.text, '你好，请问你能做什么', '配对申请要留存首条消息供批准后补答')

  // 主人批准：走 router 的真实命令路径（真机同款）
  env.server.pushMessage({ messageType: 'private', userId: 20002, text: '/qq-approve 40004' })
  assert.equal(await waitFor(() => env.plugin.store.roleOf('40004') === 'authorized'), true)
  const agent = await waitForFirstFollowup(env)
  assert.equal(agent.followed[0].content[0].text, '你好，请问你能做什么', '补答的正是原始那条消息')
  agent.reply('我能干这些')
  agent.ctx.emitStatus('idle')
  assert.equal(await waitFor(() => outboundTexts(env.server).includes('我能干这些')), true, '补答的回复要回到陌生人')
})

test('配对：超过补答时限的旧申请不重放（只批准，不翻旧账）', async t => {
  const env = await setup({ configOverrides: { pairingPolicy: 'pairing' } })
  t.after(() => cleanup(env))
  // 直接把申请写成 2 小时前的（超过 PENDING_REPLAY_TTL_MS）
  await env.plugin.store.addPendingPairing({
    userId: '40005',
    name: '旧申请',
    at: Date.now() - 2 * 60 * 60 * 1000,
    message: { text: '很久以前的问题', target: { kind: 'dm', userId: '40005' } },
  })
  env.server.pushMessage({ messageType: 'private', userId: 20002, text: '/qq-approve 40005' })
  assert.equal(await waitFor(() => env.plugin.store.roleOf('40005') === 'authorized'), true)
  await tick(150)
  assert.equal(env.agents.created.length, 0, '过期申请不补答（媒体链接早已失效、上下文也凉了）')
})
