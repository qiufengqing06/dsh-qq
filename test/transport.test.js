import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  assertTarget,
  assertTransportContract,
  buildChatKey,
  createUnavailableTransport,
  fromChannelTarget,
  makeCapabilities,
  makeInboundEvent,
  parseChatKey,
  supportsMedia,
  targetKey,
  toChannelTarget,
} from '../lib/transport.js'
import { createMockTransport } from '../lib/mock.js'

test('target 校验：三种 kind 的必填 id', () => {
  assert.deepEqual(assertTarget({ kind: 'dm', userId: 'u1' }), { kind: 'dm', userId: 'u1' })
  assert.deepEqual(assertTarget({ kind: 'group', groupId: 'g1' }), { kind: 'group', groupId: 'g1' })
  assert.deepEqual(assertTarget({ kind: 'channel', guildId: 'g', channelId: 'c' }), {
    kind: 'channel',
    guildId: 'g',
    channelId: 'c',
  })
  assert.throws(() => assertTarget({ kind: 'p2p', userId: 'u' }), /must be one of dm\|group\|channel/)
  assert.throws(() => assertTarget({ kind: 'dm' }), /userId must be a non-empty string/)
  assert.throws(() => assertTarget(null), /must be an object/)
})

test('chatKey：命名空间隔离（协议 + 账号）', () => {
  const dm = { kind: 'dm', userId: 'openid-1' }
  assert.equal(buildChatKey('qqbot', '102000001', dm), 'qqbot:102000001:dm:openid-1')
  assert.equal(buildChatKey('qqbot', '102000002', dm), 'qqbot:102000002:dm:openid-1')
  assert.equal(buildChatKey('altmock', '102000001', dm), 'altmock:102000001:dm:openid-1')
  // 同一 openid 在不同协议/账号下互不碰撞
  const keys = new Set([
    buildChatKey('qqbot', '1', dm),
    buildChatKey('qqbot', '2', dm),
    buildChatKey('altmock', '1', dm),
  ])
  assert.equal(keys.size, 3)
  assert.equal(buildChatKey('QQBot', '1', dm), 'qqbot:1:dm:openid-1')
  assert.equal(
    buildChatKey('qqbot', '1', { kind: 'channel', guildId: 'g', channelId: 'c' }),
    'qqbot:1:channel:g:c',
  )
  assert.throws(() => buildChatKey('qqbot', 'a:b', dm), /must not contain/)
  assert.throws(() => buildChatKey('', '1', dm), /transportKind must be a non-empty string/)
})

test('chatKey 解析往返一致', () => {
  const target = { kind: 'channel', guildId: 'g1', channelId: 'c1' }
  const parsed = parseChatKey(buildChatKey('qqbot', 'app1', target))
  assert.equal(parsed.transportKind, 'qqbot')
  assert.equal(parsed.accountId, 'app1')
  assert.deepEqual(parsed.target, target)
  assert.throws(() => parseChatKey('qqbot:app1:dm'), /invalid chatKey/)
})

test('渠道契约 target 往返（含 guild 复合 id）', () => {
  assert.deepEqual(toChannelTarget({ kind: 'dm', userId: 'u' }), { kind: 'p2p', id: 'u' })
  assert.deepEqual(toChannelTarget({ kind: 'group', groupId: 'g' }), { kind: 'group', id: 'g' })
  assert.deepEqual(toChannelTarget({ kind: 'channel', guildId: 'g', channelId: 'c' }), { kind: 'group', id: 'g:c' })
  assert.deepEqual(fromChannelTarget({ kind: 'p2p', id: 'u' }, 'mock', 'acct')?.target, { kind: 'dm', userId: 'u' })
  assert.deepEqual(fromChannelTarget({ kind: 'group', id: 'g' }, 'mock', 'acct')?.target, { kind: 'group', groupId: 'g' })
  assert.deepEqual(fromChannelTarget({ kind: 'group', id: 'g:c' }, 'mock', 'acct')?.target, {
    kind: 'channel',
    guildId: 'g',
    channelId: 'c',
  })
  assert.equal(fromChannelTarget({ kind: 'group', id: '' }), null)
})

test('归一化入站事件形状与冻结', () => {
  const ev = makeInboundEvent({
    transportKind: 'mock',
    accountId: 'acct',
    target: { kind: 'dm', userId: 'u1' },
    sender: { id: 'u1', name: 'U' },
    text: 'hello',
    messageId: 'm1',
    timestamp: 1700000000000,
    replyTo: { messageId: 'm0', text: '引用' },
    media: [{ kind: 'image', url: 'https://example.invalid/a.png', size: 10 }],
    mentioned: true,
  })
  assert.equal(ev.chatKey, 'mock:acct:dm:u1')
  assert.equal(ev.messageId, 'm1')
  assert.equal(ev.text, 'hello')
  assert.equal(ev.replyTo.text, '引用')
  assert.equal(ev.media[0].kind, 'image')
  assert.equal(ev.mentioned, true)
  assert.ok(Object.isFrozen(ev))
  assert.ok(Object.isFrozen(ev.target))
  assert.ok(Object.isFrozen(ev.media))
  assert.throws(() => makeInboundEvent({ transportKind: 'mock', accountId: 'a', target: { kind: 'dm' }, text: '' }), TypeError)
  assert.throws(
    () =>
      makeInboundEvent({
        transportKind: 'mock',
        accountId: 'a',
        target: { kind: 'dm', userId: 'u' },
        text: '',
        media: [{ kind: 'hologram' }],
      }),
    /media.kind must be one of/,
  )
  assert.equal(targetKey(ev.target), 'dm:u1')
})

test('capabilities 默认 fail-closed', () => {
  const caps = makeCapabilities({})
  assert.equal(caps.markdown, false)
  assert.equal(caps.keyboard, false)
  assert.equal(caps.typing, false)
  assert.equal(caps.passiveReply, false)
  assert.deepEqual([...caps.media], [])
  const rich = makeCapabilities({ markdown: true, media: ['image', 'unknown'] })
  assert.equal(rich.markdown, true)
  assert.deepEqual([...rich.media], ['image'])
  assert.equal(supportsMedia(rich, 'image'), true)
  assert.equal(supportsMedia(rich, 'video'), false)
})

test('契约自检：mock 通过，缺槽位/坏 capabilities 抛错', () => {
  const transport = createMockTransport({})
  assert.equal(assertTransportContract(transport), true)
  const broken = { ...transport }
  delete broken.sendTyping
  assert.throws(() => assertTransportContract(broken), /missing slots: sendTyping/)
  assert.throws(() => assertTransportContract({ ...transport, capabilities: () => null }), /must return an object/)
  assert.equal(assertTransportContract(createUnavailableTransport('qqbot', 'not implemented')), true)
})

test('降级 transport 如实报错且状态可读', async () => {
  const transport = createUnavailableTransport('qqbot', '模块不存在')
  assert.equal(await transport.start({}), false)
  assert.equal(transport.status().connected, false)
  assert.equal(transport.status().phase, 'unavailable')
  const sent = await transport.sendText({ kind: 'dm', userId: 'u' }, 'hi')
  assert.equal(sent.ok, false)
  assert.match(sent.error, /不可用/)
})
