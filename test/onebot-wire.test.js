/**
 * P0 验收：OneBot 11 协议线层（纯函数）。
 *
 * 这一层不碰 socket / 配置 / store，协议正确性必须在这里被钉死；
 * transport 层（lib/onebot/transport.js）只负责连接与调度。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildChatKey } from '../lib/transport.js'
import {
  MEDIA_SEGMENT_TYPES,
  SEGMENT_MEDIA_KIND,
  classifyResponse,
  escapeCq,
  isReferenceFailure,
  normalizeOneBotEvent,
  parseCqCodes,
  parseSegments,
  replySegment,
  retryableRetcode,
  speakerName,
  stripReplySegment,
  textSegments,
  toSegments,
} from '../lib/onebot/wire.js'

test('段数组 → 文本/媒体/@/引用：array 格式（推荐路径）', () => {
  const parsed = parseSegments(
    [
      { type: 'at', data: { qq: '10001' } },
      { type: 'text', data: { text: ' 看看这个 ' } },
      { type: 'at', data: { qq: '20002' } },
      { type: 'image', data: { url: 'https://x.invalid/a.png', name: 'a.png' } },
      { type: 'record', data: { file: 'file://abc', asr_refer_text: '你好呀' } },
      { type: 'reply', data: { id: 'msg-9' } },
      { type: 'face', data: { id: '1' } },
    ],
    { selfId: '10001' },
  )
  assert.equal(parsed.mentioned, true, '被 @ 到 self_id 才算提到机器人')
  assert.deepEqual(parsed.atOthers, ['20002'])
  assert.deepEqual(parsed.mentionedIds, ['10001', '20002'])
  assert.equal(parsed.text.includes('@我'), false, '自己被 @ 不往文本加标记（否则命令解析会被破坏）')
  assert.match(parsed.text, /@20002/, '别人的 @ 保留 QQ 号，模型可以引用')
  assert.match(parsed.text, /看看这个/)
  assert.match(parsed.text, /\[表情\]/)
  assert.deepEqual(parsed.replyTo, { messageId: 'msg-9' })
  assert.deepEqual(
    parsed.media.map(item => item.kind),
    ['image', 'audio'],
  )
  assert.equal(parsed.media[1].asrText, '你好呀', 'QQ/NapCat 自带 ASR 文本必须保留')
})

test('@ 判定：别人被 @ 不算提到机器人；selfId 未知时不误判', () => {
  const other = parseSegments([{ type: 'at', data: { qq: '20002' } }, { type: 'text', data: { text: 'hi' } }], { selfId: '10001' })
  assert.equal(other.mentioned, false)
  const unknown = parseSegments([{ type: 'at', data: { qq: '20002' } }], { selfId: '' })
  assert.equal(unknown.mentioned, false)
})

test('CQ 码字符串兜底（messagePostFormat: string）', () => {
  const segments = parseCqCodes('[CQ:at,qq=10001] 你好 [CQ:image,file=https://x.invalid/b.png]')
  assert.deepEqual(segments[0], { type: 'at', data: { qq: '10001' } })
  assert.equal(segments[1].data.text, ' 你好 ')
  assert.equal(segments[2].type, 'image')
  const parsed = parseSegments(segments, { selfId: '10001' })
  assert.equal(parsed.mentioned, true)
  assert.deepEqual(parsed.media, [{ kind: 'image', url: 'https://x.invalid/b.png' }])

  // 实体转义：`&#91;` 这类不能把消息切碎
  assert.deepEqual(parseCqCodes(escapeCq('[不是CQ码]')), [{ type: 'text', data: { text: '[不是CQ码]' } }])
  assert.deepEqual(parseCqCodes(''), [])
  assert.deepEqual(toSegments(undefined), [])
  assert.deepEqual(toSegments({ type: 'text', data: { text: '单段对象' } }), [{ type: 'text', data: { text: '单段对象' } }])
})

test('媒体段：url 优先，缺 url 用 file/path，未知段忽略', () => {
  const parsed = parseSegments([
    { type: 'image', data: { file: 'file://hash-1' } },
    { type: 'file', data: { path: '/tmp/a.pdf', name: 'a.pdf' } },
    { type: 'video', data: {} },
    { type: 'json', data: { data: '{}' } },
    { type: 'mystery', data: { url: 'https://x.invalid/c' } },
  ])
  assert.deepEqual(
    parsed.media.map(item => item.kind),
    ['image', 'file'],
  )
  assert.equal(parsed.media[0].url, 'file://hash-1')
  assert.equal(parsed.media[1].fileName, 'a.pdf')
  assert.deepEqual([...MEDIA_SEGMENT_TYPES].sort(), Object.keys(SEGMENT_MEDIA_KIND).sort())
})

test('事件归一化：私聊 / 群聊（@ 判定、群名片优先、文本保持协议原样）', () => {
  const dm = normalizeOneBotEvent(
    {
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 11,
      user_id: 20002,
      time: 1_700_000_000,
      message: [{ type: 'text', data: { text: '你好' } }],
      sender: { user_id: 20002, nickname: '小明' },
    },
    { accountId: '10001' },
  )
  assert.equal(dm.chatKey, buildChatKey('onebot', '10001', { kind: 'dm', userId: '20002' }))
  assert.deepEqual(dm.target, { kind: 'dm', userId: '20002' })
  assert.equal(dm.text, '你好', '私聊不加前缀')
  assert.equal(dm.mentioned, true)
  assert.equal(dm.messageId, '11')
  assert.equal(dm.timestamp, 1_700_000_000_000)
  assert.equal(dm.rawKind, 'private/friend')

  const group = normalizeOneBotEvent(
    {
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 12,
      group_id: 30003,
      user_id: 20002,
      time: 1_700_000_100,
      message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: ' 帮我看下' } }],
      sender: { user_id: 20002, nickname: 'nick', card: '群名片' },
    },
    { accountId: '10001' },
  )
  assert.deepEqual(group.target, { kind: 'group', groupId: '30003' })
  assert.equal(group.sender.name, '群名片', '群里优先群名片')
  assert.equal(group.mentioned, true)
  // 协议层不许装饰文本：群里的「@机器人 /qq-status」必须保持以 / 开头，
  // 否则 router 解析不出命令、会被当成普通对话送进模型（真机踩过）。
  assert.equal(group.text, '帮我看下', '群聊文本保持原样（说话人前缀由 bridge 展示层加）')
  assert.equal(group.mentioned, true, '@ 判定仍然准确')
})

test('事件归一化：非消息事件与畸形数据一律返回 null（不崩、不误报）', () => {
  assert.equal(normalizeOneBotEvent({ post_type: 'notice', notice_type: 'friend_add' }, { accountId: '1' }), null)
  assert.equal(normalizeOneBotEvent({ post_type: 'meta_event', meta_event_type: 'heartbeat' }, { accountId: '1' }), null)
  assert.equal(normalizeOneBotEvent(null, { accountId: '1' }), null)
  assert.equal(normalizeOneBotEvent({ post_type: 'message', message_type: 'guild' }, { accountId: '1' }), null, '频道不属于 OneBot 11')
  assert.equal(normalizeOneBotEvent({ post_type: 'message', message_type: 'private' }, { accountId: '1' }), null, '缺 user_id')
  assert.equal(normalizeOneBotEvent({ post_type: 'message', message_type: 'group', group_id: 1 }, { accountId: '1' }), null, '缺 user_id')
  assert.throws(() => normalizeOneBotEvent({ post_type: 'message' }, { accountId: '' }), /accountId/)
})

test('私聊 notice 之外的 sub_type 与空消息也归一化出可读内容', () => {
  const empty = normalizeOneBotEvent(
    { post_type: 'message', message_type: 'private', message_id: 1, user_id: '2', message: [], sender: { nickname: 'X' } },
    { accountId: '1' },
  )
  assert.equal(empty.text, '')
  assert.deepEqual(empty.media, [])
})

test('引用消息：lookupReply 能把被引用文本带进 replyTo', () => {
  const event = normalizeOneBotEvent(
    {
      post_type: 'message',
      message_type: 'group',
      message_id: 5,
      group_id: '9',
      user_id: '8',
      message: [{ type: 'reply', data: { id: 'msg-3' } }, { type: 'text', data: { text: '就是这条' } }],
      sender: { user_id: '8', nickname: 'N' },
    },
    { accountId: '1', lookupReply: id => (id === 'msg-3' ? { text: '上一句原文' } : null) },
  )
  assert.deepEqual(event.replyTo, { messageId: 'msg-3', text: '上一句原文' })

  const noLookup = normalizeOneBotEvent(
    {
      post_type: 'message',
      message_type: 'private',
      message_id: 6,
      user_id: '8',
      message: [{ type: 'reply', data: { id: 'msg-4' } }, { type: 'text', data: { text: 'x' } }],
      sender: { nickname: 'N' },
    },
    { accountId: '1' },
  )
  assert.deepEqual(noLookup.replyTo, { messageId: 'msg-4', text: '' }, '查不到就如实留空')
})

test('引用只有附件的消息：被引附件随引用一起带过来（群文件的标准用法）', () => {
  // QQ 里文件与文字无法合成一条消息 → 用户只能「先发文件，再引用它提问」。
  // 被引用那条没有文本，只带 text 的话引用退化成空引用，模型只能回「没收到附件」。
  const event = normalizeOneBotEvent(
    {
      post_type: 'message',
      message_type: 'group',
      message_id: 7,
      group_id: '9',
      user_id: '8',
      message: [{ type: 'reply', data: { id: 'file-msg-1' } }, { type: 'text', data: { text: '这个文件讲的什么' } }],
      sender: { user_id: '8', nickname: 'N', card: '群名片' },
    },
    {
      accountId: '1',
      lookupReply: id =>
        id === 'file-msg-1'
          ? { text: '', media: [{ kind: 'file', url: 'file_id_abc', fileName: '2025级硕士0915.xls', size: 291840 }] }
          : null,
    },
  )
  assert.equal(event.text, '这个文件讲的什么', '当前消息的文本仍然保持协议原样')
  assert.equal(event.media.length, 0, '当前消息本身没有附件')
  assert.deepEqual(event.replyTo, {
    messageId: 'file-msg-1',
    text: '',
    media: [{ kind: 'file', url: 'file_id_abc', fileName: '2025级硕士0915.xls', size: 291840 }],
  })
})

test('段解析：NapCat 群文件段用 file_name/file_size，文件名与大小都要认出来', () => {
  const parsed = parseSegments([
    { type: 'file', data: { file: 'file_id_abc', file_name: '2025级硕士0915.xls', file_size: 291840 } },
  ])
  assert.equal(parsed.media.length, 1)
  assert.deepEqual(parsed.media[0], {
    kind: 'file',
    url: 'file_id_abc',
    fileName: '2025级硕士0915.xls',
    size: 291840,
  })
})

test('响应分类：success / accepted-async / failure 三态 + retryClass 三态', () => {
  const okResult = classifyResponse({ status: 'ok', retcode: 0, data: { message_id: 1 } }, { action: 'send_private_msg' })
  assert.equal(okResult.ok, true)
  assert.equal(okResult.outcome, 'success')
  assert.equal(okResult.retryClass, 'never')
  assert.equal(okResult.retryable, false)
  assert.deepEqual(okResult.data, { message_id: 1 })
  assert.equal(okResult.operation, 'send_private_msg')

  // retcode=1 = 已受理但结果未知，不能当普通成功，也不保证有 message_id
  const async1 = classifyResponse({ status: 'async', retcode: 1, data: null })
  assert.equal(async1.ok, true)
  assert.equal(async1.outcome, 'accepted-async')
  assert.equal(async1.data, null)

  const paramError = classifyResponse({ status: 'failed', retcode: 100, message: '参数错误' }, { action: 'send_group_msg' })
  assert.equal(paramError.ok, false)
  assert.equal(paramError.outcome, 'failure')
  assert.equal(paramError.retryClass, 'never', '1xx 重试无意义')
  assert.match(paramError.error, /send_group_msg/)

  assert.equal(classifyResponse({ status: 'failed', retcode: 200, message: '处理失败' }).retryClass, 'safe')
  assert.equal(classifyResponse({ status: 'failed', retcode: 300, message: '服务未就绪' }).retryClass, 'safe')

  // 无响应（超时/连接断）：读操作可安全重试；**写操作结果未知，绝不自动重试**
  assert.equal(classifyResponse(null).retryClass, 'safe')
  assert.equal(classifyResponse(null, { action: 'get_status' }).retryable, true)
  const writeTimeout = classifyResponse(null, { action: 'send_group_msg', mutating: true })
  assert.equal(writeTimeout.retryClass, 'unknown-outcome')
  assert.equal(writeTimeout.retryable, false, '写操作超时不能自动重试（否则重复发消息）')
  assert.match(writeTimeout.error, /结果未知/)

  // 14xx = 实现层沿用 HTTP 语义的永久错误（1400/1401/1403/1404…），重试没有意义
  assert.equal(retryableRetcode(1404), false)
  assert.equal(retryableRetcode(1403), false, 'token 验证失败属于永久错误')
  assert.equal(retryableRetcode(102), false)
  assert.equal(retryableRetcode(200), true)
})

test('引用失效判定与剥离：NapCat 消息 ID 是 LRU 哈希，引用会过期', () => {
  assert.equal(isReferenceFailure({ retcode: 100, error: 'OneBot send_group_msg失败（retcode=100）：消息不存在' }), true)
  assert.equal(isReferenceFailure({ retcode: 100, error: 'reply message_id invalid' }), true)
  assert.equal(isReferenceFailure({ retcode: 200, error: 'OneBot 调用失败：网络抖动' }), false)

  const segments = [{ type: 'reply', data: { id: 'm1' } }, { type: 'text', data: { text: 'hi' } }]
  assert.deepEqual(stripReplySegment(segments), [{ type: 'text', data: { text: 'hi' } }])
  assert.deepEqual(stripReplySegment(undefined), [])
})

test('段构造：文本/引用段；空输入不产生空段', () => {
  assert.deepEqual(textSegments('hi'), [{ type: 'text', data: { text: 'hi' } }])
  assert.deepEqual(textSegments(''), [])
  assert.deepEqual(replySegment('m1'), [{ type: 'reply', data: { id: 'm1' } }])
  assert.deepEqual(replySegment(''), [])
  assert.equal(speakerName({ name: '名片', id: '1' }), '名片')
  assert.equal(speakerName({ name: '  ', id: '20002' }), '20002')
  assert.equal(speakerName({}), '')
})

test('群聊命令：@机器人 + /qq-* 归一化后仍以 / 开头（命令能被 router 拦截）', () => {
  const cmd = normalizeOneBotEvent(
    {
      post_type: 'message',
      message_type: 'group',
      message_id: 21,
      group_id: '30003',
      user_id: '20002',
      message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: ' /qq-status' } }],
      sender: { user_id: '20002', nickname: 'nick', card: '秋风清' },
    },
    { accountId: '10001' },
  )
  assert.equal(cmd.mentioned, true)
  assert.equal(cmd.text.trimStart().startsWith('/'), true, '命令必须以 / 开头才可能被 CommandRouter 拦截')
  assert.equal(cmd.text.trim(), '/qq-status')
})

test('@全体成员：置 mentioned + 文本占位（不再静默丢弃）', () => {
  const parsed = parseSegments([{ type: 'at', data: { qq: 'all' } }, { type: 'text', data: { text: ' 注意' } }], { selfId: '10001' })
  assert.equal(parsed.mentioned, true, '@全体成员 应视为提到机器人')
  assert.match(parsed.text, /\[@全体成员\]/)
  assert.match(parsed.text, /注意/)
})

test('合并转发：保留 forward_id 占位，便于按需 get_forward_msg', () => {
  const withId = parseSegments([{ type: 'forward', data: { id: 'fw-123' } }])
  assert.match(withId.text, /\[合并转发消息 id=fw-123\]/)
  const noId = parseSegments([{ type: 'node', data: {} }])
  assert.equal(noId.text, '[合并转发消息]', '没有 id 时退回通用占位')
})
