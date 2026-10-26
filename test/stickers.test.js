import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveConfig } from '../lib/config.js'
import { createStickerStore, imageExtOf } from '../lib/stickers.js'
import { createStickerTools } from '../lib/sticker-tools.js'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)])

async function setup({ stickers = {}, groupId = '100', clock = () => Date.now(), preferredIdsForChat = () => [] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-stickers-'))
  const config = resolveConfig({ transport: 'mock', dataDir: dir, autoConnect: false, stickers })
  const store = createStickerStore({ dir, config, clock, preferredIdsForChat })
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

async function addSticker(env, marker, tags = ['开心']) {
  const data = Buffer.concat([PNG, Buffer.from([marker])])
  await env.store.capture({ ...env.ev, messageId: `image-${marker}` }, {
    mode: 'chat', download: async () => ({ ok: true, data, contentType: 'image/png' }),
  })
  const item = env.store.listAll().find(item => env.store.itemOf(item.id).sources.some(source => source.messageId === `image-${marker}`))
  await env.store.setMeta(item.id, { tags, desc: `小鲸鱼第${marker}张图，笑着捧饭碗` })
  return { id: item.id, data }
}

function sendOptions(env, extra = {}) {
  return { chatKey: env.ev.chatKey, target: env.ev.target, transport: env.transport, mode: 'chat', ...extra }
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

test('自动收藏只在 chat 模式；work 不采集，私聊采集', async () => {
  const env = await setup()
  assert.equal(await env.store.capture(env.ev, { download: env.download, mode: 'work' }), 0)
  const dm = { ...env.ev, target: { kind: 'dm', userId: 'u1' }, chatKey: 'qqbot:1:dm:u1' }
  assert.equal(await env.store.capture(dm, { download: env.download, mode: 'chat' }), 1)
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

test('私聊图片也收藏，但只在本私聊可见（不跨群）', async () => {
  const env = await setup()
  const dm = {
    ...env.ev,
    target: { kind: 'dm', userId: 'u1' },
    chatKey: 'qqbot:1:dm:u1',
  }
  assert.equal(await env.store.capture(dm, { download: env.download, mode: 'chat' }), 1)
  assert.equal(env.store.list(dm.chatKey).length, 1)
  assert.equal(env.store.list('qqbot:1:dm:other').length, 0)
  assert.equal(env.store.list('qqbot:1:group:200').length, 0, '私聊图不跨群')
})

test('先排除重复再选图；英文标签兼容中文，同轮两张与轮间冷却分开', async () => {
  let now = Date.now()
  const env = await setup({ clock: () => now, stickers: { send: { perTurnMax: 2, cooldownMs: 1000 } } })
  const a = await addSticker(env, 1, ['happy'])
  const b = await addSticker(env, 2)
  const c = await addSticker(env, 3)
  assert.deepEqual(env.store.itemOf(a.id).tags, ['开心'])
  assert.equal((await env.store.send(sendOptions(env, { id: a.id, turnId: 'turn-1' }))).ok, true)
  const available = env.store.list(env.ev.chatKey, { query: 'happy', turnId: 'turn-1' })
  assert.equal(available.length, 3)
  assert.equal(available[0].available, true)
  assert.equal(available.at(-1).id, a.id)
  assert.match(available.at(-1).reason, /最近发过/)
  const second = await env.store.send(sendOptions(env, { tag: 'happy', turnId: 'turn-1' }))
  assert.equal(second.ok, true)
  assert.notEqual(second.id, a.id)
  assert.match(second.desc, /笑着捧饭碗/)
  assert.equal(second.messageId, 'm1')
  const remaining = [b.id, c.id].find(id => id !== second.id)
  assert.match((await env.store.send(sendOptions(env, { id: remaining, turnId: 'turn-1' }))).error, /本轮.*上限/)
  assert.match((await env.store.send(sendOptions(env, { id: remaining, turnId: 'turn-2' }))).error, /冷却/)
  now += 1001
  assert.equal((await env.store.send(sendOptions(env, { id: remaining, turnId: 'turn-2' }))).ok, true)
  assert.match((await env.store.send(sendOptions(env, { id: a.id, turnId: 'turn-2' }))).error, /最近发过/)
})

test('人设精选优先匹配，但不适合或已发过时回退普通图库', async () => {
  let selected = []
  const env = await setup({ preferredIdsForChat: () => selected, stickers: { send: { perTurnMax: 5, cooldownMs: 0 } } })
  const regular = await addSticker(env, 1)
  await env.store.promote(regular.id)
  const preferred = await addSticker(env, 2)
  const otherUse = await addSticker(env, 3, ['拒绝'])
  selected = [preferred.id]
  const listed = env.store.list(env.ev.chatKey, { query: '开心' })
  assert.equal(listed[0].id, preferred.id, '匹配的精选候选排在普通收藏之前')
  assert.equal(listed[0].preferred, true)
  assert.equal(listed.find(item => item.id === regular.id).preferred, false)
  assert.equal((await env.store.send(sendOptions(env, { query: '拒绝', turnId: 't' }))).id, otherUse.id, '精选不匹配时允许普通候选')
  assert.equal((await env.store.send(sendOptions(env, { tag: 'happy', turnId: 't' }))).id, preferred.id)
  const after = env.store.list(env.ev.chatKey, { query: '开心', turnId: 't' })
  assert.equal(after[0].id, regular.id, '可发送普通图排在重复精选之前')
  assert.equal(after.at(-1).preferred, true)
  assert.match(after.at(-1).reason, /最近发过/)
  assert.equal((await env.store.send(sendOptions(env, { tag: '开心', turnId: 't' }))).id, regular.id)
  selected = [otherUse.id]
  assert.equal(env.store.list(env.ev.chatKey, { ids: [preferred.id] })[0].preferred, false, '人设选择变化即时生效')
  assert.deepEqual(selected, [otherUse.id], '选图不修改全局人设数组')
})

test('精选候选可用于默认选图，显式 id 仍可选择非精选', async () => {
  let selected = []
  const env = await setup({ preferredIdsForChat: () => selected, stickers: { send: { cooldownMs: 0 } } })
  const preferred = await addSticker(env, 1)
  const other = await addSticker(env, 2)
  selected = [preferred.id]
  assert.equal((await env.store.send(sendOptions(env, { id: other.id, turnId: 't' }))).id, other.id)
  assert.equal((await env.store.send(sendOptions(env, { turnId: 't' }))).id, preferred.id)
})

test('精选不突破私聊/群来源与回收限制，预览按指定 ID 先筛选再限制数量', async () => {
  let now = Date.now()
  let selected = []
  const env = await setup({ groupId: '200', clock: () => now, preferredIdsForChat: () => selected,
    stickers: { noShareGroups: ['100'], send: { cooldownMs: 0 } } })
  const regular = await addSticker(env, 1)
  now += 1000
  const newer = await addSticker(env, 2)
  const privateImage = await addSticker({ ...env, ev: { ...env.ev, chatKey: 'qqbot:1:dm:u', target: { kind: 'dm', userId: 'u' } } }, 3)
  const localImage = await addSticker({ ...env, ev: { ...env.ev, chatKey: 'qqbot:1:group:100', target: { kind: 'group', groupId: '100' } } }, 4)
  const trashed = await addSticker(env, 5)
  await env.store.trash(trashed.id)
  selected = [privateImage.id, localImage.id, trashed.id]
  const listed = env.store.list(env.ev.chatKey, { limit: 1 })
  assert.equal(listed[0].id, newer.id)
  const preview = env.store.list(env.ev.chatKey, { ids: [regular.id, ...selected], limit: 1 })
  assert.deepEqual(preview.map(item => item.id), [regular.id], '先按 ID 筛选，且不返回不可见图片描述')
  assert.deepEqual(env.store.list(env.ev.chatKey, { ids: selected }), [])
  assert.deepEqual(env.store.list(env.ev.chatKey, { ids: [] }), [])
  assert.equal(env.store.list('qqbot:1:dm:u', { ids: [privateImage.id] })[0].preferred, true)
  assert.match((await env.store.send(sendOptions(env, { id: privateImage.id, turnId: 't' }))).error, /不属于当前对话/)
  assert.match((await env.store.send(sendOptions(env, { id: trashed.id, turnId: 't' }))).error, /回收站/)
  assert.equal((await env.store.send(sendOptions(env, { tag: '开心', turnId: 't' }))).id, newer.id, '不可见精选不阻挡普通库回退')
  assert.deepEqual(selected, [privateImage.id, localImage.id, trashed.id], '不因当前对话不可见而删除全局选择')
})

test('同对话并发发送串行复查每轮与日额度，不让两个工具同时抢到额度', async () => {
  const env = await setup({ stickers: { send: { perTurnMax: 2, cooldownMs: 0, dailyPerChat: 2 } } })
  const images = await Promise.all([1, 2, 3].map(marker => addSticker(env, marker)))
  let active = 0
  let peak = 0
  env.transport.sendMedia = async () => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 5))
    active -= 1
    return { ok: true }
  }
  const results = await Promise.all(images.map(image => env.store.send(sendOptions(env, { id: image.id, turnId: 'same-turn' }))))
  assert.equal(results.filter(result => result.ok).length, 2)
  assert.equal(peak, 1)
  assert.match(results[2].error, /本轮.*上限/)
  assert.match((await env.store.send(sendOptions(env, { id: images[2].id, turnId: 'next-turn' }))).error, /今日.*额度/)
})

test('排队期间取消或临发复查失效，未发图不占额度；已在途的发送正常记账', async () => {
  const env = await setup({ stickers: { send: { perTurnMax: 2, cooldownMs: 0 } } })
  const a = await addSticker(env, 1)
  const b = await addSticker(env, 2)
  let valid = true
  let release
  let started
  const inFlight = new Promise(resolve => { started = resolve })
  env.transport.sendMedia = () => new Promise(resolve => {
    started()
    release = () => resolve({ ok: true })
  })
  const first = env.store.send(sendOptions(env, { id: a.id, turnId: 't', isValid: () => valid }))
  await inFlight
  const second = env.store.send(sendOptions(env, { id: b.id, turnId: 't', isValid: () => valid }))
  valid = false
  release()
  assert.equal((await first).ok, true)
  assert.match((await second).error, /取消|权限/)
  assert.equal(env.store.itemOf(b.id).sendCount, 0)
  env.transport.sendMedia = async () => ({ ok: true })
  let checks = 0
  assert.equal((await env.store.send(sendOptions(env, { id: b.id, turnId: 't', isValid: () => ++checks < 2 }))).ok, false)
  assert.equal(env.store.itemOf(b.id).sendCount, 0)
  assert.equal((await env.store.send(sendOptions(env, { id: b.id, turnId: 't' }))).ok, true)
})

test('平台发送失败不占额度，后续同图可重试；已发送轮次额度重载后仍生效', async () => {
  const env = await setup({ stickers: { send: { perTurnMax: 1, cooldownMs: 0 } } })
  const a = await addSticker(env, 1)
  const b = await addSticker(env, 2)
  env.transport.sendMedia = async () => ({ ok: false, error: '网络暂时不可用' })
  assert.equal((await env.store.send(sendOptions(env, { id: a.id, turnId: 't' }))).ok, false)
  assert.equal(env.store.itemOf(a.id).sendCount, 0)
  env.transport.sendMedia = async () => ({ ok: true })
  assert.equal((await env.store.send(sendOptions(env, { id: a.id, turnId: 't' }))).ok, true)
  const restored = createStickerStore({ dir: env.dir, config: env.config })
  assert.match((await restored.send(sendOptions(env, { id: b.id, turnId: 't' }))).error, /本轮.*上限/)
})

test('兼容旧发送时间数组，按真实历史执行冷却和日预算', async () => {
  const now = Date.now()
  const env = await setup({ clock: () => now })
  const a = await addSticker(env, 1)
  await writeFile(join(env.dir, 'stickers', 'state.json'), JSON.stringify({ sent: { [env.ev.chatKey]: [now - 10] }, used: {} }))
  const restored = createStickerStore({ dir: env.dir, config: env.config, clock: () => now })
  assert.match((await restored.send(sendOptions(env, { id: a.id, turnId: 'new' }))).error, /冷却/)
})

test('平台已发送后索引落盘失败仍返回真实成功，额度记录防止重复补发', async () => {
  const env = await setup({ stickers: { send: { perTurnMax: 1, cooldownMs: 0 } } })
  const image = await addSticker(env, 1)
  env.transport.sendMedia = async () => {
    await rm(env.store.indexPath())
    await mkdir(env.store.indexPath())
    return { ok: true, messageId: 'already-sent' }
  }
  const result = await env.store.send(sendOptions(env, { id: image.id, turnId: 't' }))
  assert.equal(result.ok, true)
  assert.equal(result.messageId, 'already-sent')
  assert.equal(env.store.describeImage(env.ev.chatKey, image.data).wasSentHere, true)
  assert.match((await env.store.send(sendOptions(env, { id: image.id, turnId: 't' }))).error, /本轮.*上限/)
  const saved = JSON.parse(await readFile(join(env.dir, 'stickers', 'state.json'), 'utf8'))
  assert.equal(saved.sent[env.ev.chatKey][0].turnId, 't')
})

test('同图说明遵守来源权限，其他群可共享画面但看不到本群发送历史', async () => {
  const env = await setup()
  const a = await addSticker(env, 1)
  assert.equal(env.store.describeImage(env.ev.chatKey, a.data).wasSentHere, false)
  assert.equal((await env.store.send(sendOptions(env, { id: a.id, turnId: 't' }))).ok, true)
  const own = env.store.describeImage(env.ev.chatKey, a.data)
  assert.equal(own.wasSentHere, true)
  assert.equal(typeof own.sentAt, 'number')
  assert.match(own.desc, /捧饭碗/)
  const shared = env.store.describeHash('qqbot:1:group:200', a.id)
  assert.equal(shared.wasSentHere, false)
  assert.equal(shared.sentAt, undefined)
  const local = await setup({ stickers: { noShareGroups: ['100'] } })
  const privateImage = await addSticker(local, 2)
  assert.equal(local.store.describeImage('qqbot:1:group:200', privateImage.data), null)
  await env.store.trash(a.id)
  assert.equal(env.store.describeImage(env.ev.chatKey, a.data), null)
})
