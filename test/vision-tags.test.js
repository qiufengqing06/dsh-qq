import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveConfig } from '../lib/config.js'
import { createStickerStore } from '../lib/stickers.js'
import { createStickerTagger, parseTagJson } from '../lib/vision-tags.js'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)])

async function setup(reply, stickers = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-vision-'))
  const config = resolveConfig({ transport: 'mock', dataDir: dir, stickers })
  const store = createStickerStore({ dir, config })
  await store.load()
  const ev = {
    transportKind: 'qqbot', accountId: '1', chatKey: 'qqbot:1:group:2',
    target: { kind: 'group', groupId: '2' }, sender: { id: 'u1', name: '甲' },
    messageId: 'm1', text: '', media: [{ kind: 'image', url: 'https://example.com/x.png' }],
  }
  await store.capture(ev, { mode: 'chat', download: async () => ({ ok: true, data: PNG, contentType: 'image/png' }) })
  const id = store.listAll()[0].id
  const calls = []
  const ctx = {
    get: name => name === 'llm'
      ? {
        stream: async function* (options) {
          calls.push(options)
          yield { type: 'text-delta', text: reply }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
      : name === 'attachments'
        ? { saveImage: async input => ({ attachmentId: 'ref-1', mediaType: input.mediaType, bytes: input.data.length }) }
        : null,
  }
  const tagger = createStickerTagger({ ctx, config, store })
  return { store, id, tagger, calls }
}

test('parseTagJson：解析 kind/tags/desc，拒绝非 JSON', () => {
  assert.deepEqual(parseTagJson('```json\n{"kind":"sticker","tags":["猫猫","开心"],"desc":"猫猫开心"}\n```'), { kind: 'sticker', tags: ['猫猫', '开心'], desc: '猫猫开心' })
  assert.equal(parseTagJson('随便说说'), null)
  assert.equal(parseTagJson('{"kind":"other","tags":["截图"]}').kind, 'other')
  assert.deepEqual(parseTagJson('{"kind":"sticker","tags":["happy","开心","smug"],"desc":"捧着饭碗的鲸鱼"}').tags, ['开心', '得意'])
  assert.deepEqual(parseTagJson('{"kind":"sticker","tags":["constructor","__proto__"]}').tags, ['constructor', '__proto__'])
})

test('视觉打标：表情包加标签；截图自动移回收站；调用 deepseek-flash', async () => {
  const sticker = await setup('{"kind":"sticker","tags":["猫猫","开心"],"desc":"猫猫开心"}')
  assert.equal(await sticker.tagger.tag(sticker.id), true)
  const item = sticker.store.itemOf(sticker.id)
  assert.ok(item.tags.includes('猫猫'))
  assert.equal(item.state, 'candidate')
  assert.equal(sticker.calls[0].provider, 'deepseek-account')
  assert.equal(sticker.calls[0].model, 'deepseek-flash')
  assert.equal(sticker.calls[0].messages[0].content[1].type, 'image')
  assert.match(sticker.calls[0].messages[0].content[0].text, /中文用途标签/)
  assert.match(sticker.calls[0].messages[0].content[0].text, /图中文字/)

  const other = await setup('{"kind":"other","tags":["截图"],"desc":"数据截图"}')
  assert.equal(await other.tagger.tag(other.id), true)
  const trashed = other.store.itemOf(other.id)
  assert.equal(trashed.state, 'trash')
  assert.ok(trashed.tags.includes('非表情包'))
})

test('视觉打标：关闭/非法 JSON 不改变图片', async () => {
  const off = await setup('{"kind":"sticker","tags":["猫猫"]}', { vision: { enabled: false } })
  assert.equal(await off.tagger.tag(off.id), false)
  assert.equal(off.calls.length, 0)

  const bad = await setup('不是 JSON')
  assert.equal(await bad.tagger.tag(bad.id), false)
  assert.equal(bad.store.itemOf(bad.id).tags.length, 0)
})

test('视觉补打：tagPending 处理已入库未打标图片', async () => {
  const env = await setup('{"kind":"sticker","tags":["猫猫"],"desc":"猫猫"}')
  const result = await env.tagger.tagPending({ limit: 5 })
  assert.equal(result.tried, 1)
  assert.equal(result.tagged, 1)
  assert.ok(env.store.itemOf(env.id).tags.includes('猫猫'))
})
