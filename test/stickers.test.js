import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveConfig } from '../lib/config.js'
import { createStickerStore, imageExtOf } from '../lib/stickers.js'
import { createStickerTools } from '../lib/sticker-tools.js'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)])

async function setup({ stickers = {}, groupId = '100' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-stickers-'))
  const config = resolveConfig({ transport: 'mock', dataDir: dir, autoConnect: false, stickers })
  const store = createStickerStore({ dir, config })
  await store.load()
  const sent = []
  const transport = {
    capabilitiesFor: () => ({ media: ['image', 'file'], proactiveMessage: true }),
    sendMedia: async (target, media, options) => {
      sent.push({ target, media, options })
      return { ok: true, messageId: 'm1' }
    },
  }
  const download = async () => ({ ok: true, data: PNG, contentType: 'image/png' })
  const ev = {
    transportKind: 'qqbot', accountId: '1', chatKey: `qqbot:1:group:${groupId}`,
    target: { kind: 'group', groupId }, sender: { id: 'u1', name: '甲' },
    messageId: 'msg1', text: '这个图好', media: [{ kind: 'image', url: 'https://example.com/x.png' }],
  }
  return { dir, config, store, transport, sent, download, ev }
}

test('图片类型只用魔数判断，SVG/文本拒绝', () => {
  assert.equal(imageExtOf(PNG), 'png')
  assert.equal(imageExtOf(Buffer.from('<svg></svg>')), '')
  assert.equal(imageExtOf(Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0])), 'jpg')
})

test('自动收藏：SHA-256 去重、多来源、候选、文件落盘', async () => {
  const env = await setup()
  assert.equal(await env.store.capture(env.ev, { download: env.download, mode: 'chat' }), 1)
  assert.equal(await env.store.capture({ ...env.ev, messageId: 'msg2', text: '再发一次' }, { download: env.download, mode: 'chat' }), 1)
  const stats = env.store.stats()
  assert.equal(stats.total, 1, '同一字节只存一份')
  const item = env.store.list(env.ev.chatKey, { limit: 5 })[0]
  assert.equal(item.state, 'candidate')
  const files = await readdir(join(env.dir, 'stickers', 'files'))
  assert.equal(files.length, 1)
  assert.deepEqual(await readFile(join(env.dir, 'stickers', 'files', files[0])), PNG)
})

test('自动收藏只在 chat 模式/群聊；work/私聊不采集', async () => {
  const env = await setup()
  assert.equal(await env.store.capture(env.ev, { download: env.download, mode: 'work' }), 0)
  assert.equal(await env.store.capture({ ...env.ev, target: { kind: 'dm', userId: 'u1' }, chatKey: 'qqbot:1:dm:u1' }, { download: env.download, mode: 'chat' }), 0)
})

test('跨群共享与 noShareGroups：共享图可见、本群图不串群', async () => {
  const shared = await setup()
  await shared.store.capture(shared.ev, { download: shared.download, mode: 'chat' })
  assert.equal(shared.store.list('qqbot:1:group:200').length, 1, '默认跨群共享')

  const local = await setup({ stickers: { noShareGroups: ['100'] } })
  await local.store.capture(local.ev, { download: local.download, mode: 'chat' })
  assert.equal(local.store.list('qqbot:1:group:100').length, 1)
  assert.equal(local.store.list('qqbot:1:group:200').length, 0, 'noShare 群不跨群')
})

test('发送：闸门、路径、work/trash 拒绝、冷却', async () => {
  const env = await setup()
  await env.store.capture(env.ev, { download: env.download, mode: 'chat' })
  const id = env.store.list(env.ev.chatKey)[0].id
  await env.store.setMeta(id, { tags: ['happy'], desc: '开心' })
  const result = await env.store.send({
    chatKey: env.ev.chatKey, target: env.ev.target, transport: env.transport,
    route: { transportKind: 'qqbot', accountId: '1' }, mode: 'chat', id,
  })
  assert.equal(result.ok, true)
  assert.equal(env.sent.length, 1)
  assert.match(env.sent[0].media.path, /stickers[\\/]files[\\/]/)
  const again = await env.store.send({
    chatKey: env.ev.chatKey, target: env.ev.target, transport: env.transport,
    route: { transportKind: 'qqbot', accountId: '1' }, mode: 'chat', id,
  })
  assert.equal(again.ok, false)
  assert.match(again.error, /冷却|发过/)
  assert.equal((await env.store.send({ chatKey: env.ev.chatKey, target: env.ev.target, transport: env.transport, mode: 'work', id })).ok, false)
  await env.store.trash(id)
  assert.equal((await env.store.send({ chatKey: env.ev.chatKey, target: env.ev.target, transport: env.transport, mode: 'chat', id })).ok, false)
})

test('工具：list_stickers/send_sticker 在当前对话工作', async () => {
  const env = await setup()
  await env.store.capture(env.ev, { download: env.download, mode: 'chat' })
  const id = env.store.list(env.ev.chatKey)[0].id
  const tools = createStickerTools({
    store: env.store,
    transport: env.transport,
    chatKeyOf: () => env.ev.chatKey,
    modeOf: () => 'chat',
  })
  const listTool = tools.find(tool => tool.name === 'list_stickers')
  const sendTool = tools.find(tool => tool.name === 'send_sticker')
  const exec = { agent: { session: { id: 's1' } } }
  const list = await listTool.execute({}, exec)
  assert.equal(list.ok, true)
  assert.match(list.message, new RegExp(id))
  const sent = await sendTool.execute({ id }, exec)
  assert.equal(sent.ok, true)
  assert.equal(env.sent.length, 1)
})

test('明确静默：本群关闭表情时工具拒绝发送', async () => {
  const env = await setup()
  await env.store.capture(env.ev, { download: env.download, mode: 'chat' })
  const id = env.store.list(env.ev.chatKey)[0].id
  const tools = createStickerTools({
    store: env.store,
    transport: env.transport,
    chatKeyOf: () => env.ev.chatKey,
    modeOf: () => 'chat',
    chatPreference: () => ({ stickers: false }),
  })
  const sendTool = tools.find(tool => tool.name === 'send_sticker')
  const result = await sendTool.execute({ id }, { agent: { session: { id: 's1' } } })
  assert.equal(result.ok, false)
  assert.match(result.message, /关闭表情包/)
  assert.equal(env.sent.length, 0)
})
