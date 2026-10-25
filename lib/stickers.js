/**
 * 表情包图库（Phase 1）。
 *
 *  - 自动收藏只发生在 chat 模式的群聊；图存本机，按 SHA-256 去重；
 *  - 每张图保留多个 sources（来源群/发送者/原消息）；默认跨群共享，noShareGroups 例外；
 *  - candidate（待整理）/ library（已确认）/ trash（回收站）三态；
 *  - 发送闸门：chat 模式、media=image、冷却、每对话日预算、同图 TTL；
 *  - 不做视觉打标（零依赖）；tags 由用户/管理员写，检索用 tags + 来源文本。
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

const INDEX_VERSION = 1
const MEDIA_EXT = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' })

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** 通过文件头判断真实图片类型；不信任扩展名/MIME。 */
export function imageExtOf(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return ''
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg'
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png'
  if (buffer.slice(0, 6).toString('ascii') === 'GIF87a' || buffer.slice(0, 6).toString('ascii') === 'GIF89a') return 'gif'
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'webp'
  return ''
}

function safeText(value, max = 200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function normalizeIndex(raw) {
  if (raw === null || typeof raw !== 'object' || raw.items === null || typeof raw.items !== 'object') {
    return { version: INDEX_VERSION, updatedAt: 0, items: {} }
  }
  const items = {}
  for (const [id, item] of Object.entries(raw.items)) {
    if (item === null || typeof item !== 'object') continue
    if (typeof item.sha256 !== 'string' || typeof item.file !== 'string') continue
    items[id] = {
      id,
      sha256: item.sha256,
      file: item.file,
      mime: String(item.mime ?? ''),
      bytes: Number(item.bytes) || 0,
      state: item.state === 'library' || item.state === 'trash' ? item.state : 'candidate',
      sources: Array.isArray(item.sources) ? item.sources.filter(s => s !== null && typeof s === 'object').slice(0, 8) : [],
      tags: Array.isArray(item.tags) ? item.tags.map(tag => safeText(tag, 20)).filter(Boolean).slice(0, 12) : [],
      desc: safeText(item.desc, 300),
      createdAt: Number(item.createdAt) || 0,
      lastSeenAt: Number(item.lastSeenAt) || 0,
      sentAt: Number(item.sentAt) || 0,
      sendCount: Number(item.sendCount) || 0,
    }
  }
  return { version: INDEX_VERSION, updatedAt: Number(raw.updatedAt) || 0, items }
}

export function createStickerStore({ dir, config, logger = null, clock = () => Date.now() }) {
  const settings = config.stickers ?? {}
  const enabled = settings.enabled !== false
  const root = join(dir, 'stickers')
  const filesDir = join(root, 'files')
  const trashDir = join(root, 'trash')
  const indexPath = join(root, 'index.json')
  const statePath = join(root, 'state.json')
  let index = { version: INDEX_VERSION, updatedAt: 0, items: {} }
  let state = { sent: {}, used: {} }
  let writeChain = Promise.resolve()
  let loaded = false

  const log = {
    info: message => { try { logger?.info?.(message) } catch { /* ignore */ } },
    warn: message => { try { logger?.warn?.(message) } catch { /* ignore */ } },
  }

  function queue(fn) {
    const next = writeChain.then(fn, fn)
    writeChain = next.catch(() => {})
    return next
  }

  async function load() {
    if (loaded) return
    loaded = true
    await mkdir(filesDir, { recursive: true })
    await mkdir(trashDir, { recursive: true })
    try {
      index = normalizeIndex(JSON.parse(await readFile(indexPath, 'utf8')))
    } catch {
      index = { version: INDEX_VERSION, updatedAt: 0, items: {} }
    }
    try {
      const raw = JSON.parse(await readFile(statePath, 'utf8'))
      state = {
        sent: raw?.sent !== null && typeof raw?.sent === 'object' ? raw.sent : {},
        used: raw?.used !== null && typeof raw?.used === 'object' ? raw.used : {},
      }
    } catch {
      state = { sent: {}, used: {} }
    }
  }

  async function saveIndex() {
    index.updatedAt = clock()
    const tmp = `${indexPath}.tmp-${process.pid}-${randomUUID()}`
    await writeFile(tmp, JSON.stringify(index), 'utf8')
    await rename(tmp, indexPath)
  }

  async function saveState() {
    const tmp = `${statePath}.tmp-${process.pid}-${randomUUID()}`
    await writeFile(tmp, JSON.stringify(state), 'utf8')
    await rename(tmp, statePath)
  }

  const itemPath = item => join(root, item.file)
  const isInside = path => {
    const absolute = resolve(path)
    return absolute === root || absolute.startsWith(`${root}${sep}`)
  }

  function visible(chatKey) {
    const key = String(chatKey ?? '')
    return Object.values(index.items).filter(item => {
      if (item.state === 'trash') return false
      if (item.sources.some(source => source.visibility === 'shared' || source.chatKey === key)) return true
      return false
    })
  }

  function match(item, query) {
    const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
    if (words.length === 0) return true
    const hay = [item.desc, ...item.tags, ...item.sources.map(source => source.text ?? '')].join(' ').toLowerCase()
    return words.every(word => hay.includes(word))
  }

  async function cleanup() {
    const candidates = Object.values(index.items).filter(item => item.state === 'candidate').sort((a, b) => a.lastSeenAt - b.lastSeenAt)
    const maxCandidates = settings.maxCandidates ?? 300
    for (const item of candidates.slice(0, Math.max(0, candidates.length - maxCandidates))) {
      item.state = 'trash'
    }
    const trash = Object.values(index.items).filter(item => item.state === 'trash').sort((a, b) => a.lastSeenAt - b.lastSeenAt)
    const maxTrash = settings.maxTrash ?? 100
    for (const item of trash.slice(0, Math.max(0, trash.length - maxTrash))) {
      try { await rm(itemPath(item), { force: true }) } catch { /* ignore */ }
      delete index.items[item.id]
    }
    let total = Object.values(index.items).reduce((sum, item) => sum + (item.bytes || 0), 0)
    const maxTotal = settings.maxTotalBytes ?? 200 * 1024 * 1024
    if (total > maxTotal) {
      for (const item of Object.values(index.items).filter(item => item.state === 'trash').sort((a, b) => a.lastSeenAt - b.lastSeenAt)) {
        await rm(itemPath(item), { force: true }).catch(() => {})
        total -= item.bytes || 0
        delete index.items[item.id]
        if (total <= maxTotal) break
      }
    }
  }

  async function captureOne(media, ev, download, mode) {
    if (media.kind !== 'image' || typeof media.url !== 'string' || media.url === '') return null
    const downloaded = await download(media.url, { maxBytes: settings.maxBytes ?? 4 * 1024 * 1024 })
    if (downloaded?.ok !== true || !Buffer.isBuffer(downloaded.data)) return null
    if (downloaded.data.byteLength > (settings.maxBytes ?? 4 * 1024 * 1024)) return null
    const ext = imageExtOf(downloaded.data)
    if (ext === '') return null
    const hash = sha256(downloaded.data)
    const existing = index.items[hash]
    const source = {
      transportKind: String(ev.transportKind ?? ''),
      accountId: String(ev.accountId ?? ''),
      chatKey: String(ev.chatKey ?? ''),
      groupId: ev.target?.kind === 'group' ? String(ev.target.groupId ?? '') : '',
      senderId: String(ev.sender?.id ?? ''),
      senderName: safeText(ev.sender?.name ?? '', 40),
      messageId: String(ev.messageId ?? ''),
      text: safeText(ev.text ?? '', 120),
      visibility: settings.crossGroup === true && !(settings.noShareGroups ?? []).includes(String(ev.target?.groupId ?? '')) ? 'shared' : 'local',
      at: clock(),
    }
    if (existing !== undefined) {
      const duplicate = existing.sources.some(item => item.chatKey === source.chatKey && (item.messageId === source.messageId || (item.messageId === '' && item.at === source.at)))
      if (!duplicate && source.chatKey !== '') existing.sources = [...existing.sources, source].slice(-8)
      if (source.visibility === 'shared') for (const item of existing.sources) item.visibility = 'shared'
      existing.lastSeenAt = clock()
      return hash
    }
    const file = `files/${hash}.${ext}`
    await writeFile(join(root, file), downloaded.data)
    index.items[hash] = {
      id: hash,
      sha256: hash,
      file,
      mime: downloaded.contentType ?? `image/${ext === 'jpg' ? 'jpeg' : ext}`,
      bytes: downloaded.data.byteLength,
      state: 'candidate',
      sources: [source],
      tags: [],
      desc: '',
      createdAt: clock(),
      lastSeenAt: clock(),
      sentAt: 0,
      sendCount: 0,
    }
    return hash
  }

  async function capture(ev, { download, mode = 'work' } = {}) {
    await load()
    if (!enabled || settings.autoCollect !== true) return 0
    if (mode !== 'chat') return 0
    if (ev === null || typeof ev !== 'object' || ev.target?.kind !== 'group') return 0
    const media = Array.isArray(ev.media) ? ev.media.filter(item => item?.kind === 'image').slice(0, settings.maxPerMessage ?? 3) : []
    if (media.length === 0) return 0
    let saved = 0
    for (const item of media) {
      try {
        const id = await captureOne(item, ev, download, mode)
        if (id !== null) saved += 1
      } catch (error) {
        log.warn(`dsh-qq: 表情包入库失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (saved > 0) {
      await cleanup()
      await queue(saveIndex)
      log.info(`dsh-qq: 表情包入库 ${saved} 张（当前 ${Object.keys(index.items).length}）`)
    }
    return saved
  }

  function stats() {
    const items = Object.values(index.items)
    return {
      enabled,
      total: items.length,
      candidates: items.filter(item => item.state === 'candidate').length,
      library: items.filter(item => item.state === 'library').length,
      trash: items.filter(item => item.state === 'trash').length,
      bytes: items.reduce((sum, item) => sum + (item.bytes || 0), 0),
    }
  }

  function list(chatKey, { query = '', limit = 20, includeCandidates = true } = {}) {
    const items = visible(chatKey)
      .filter(item => includeCandidates || item.state === 'library')
      .filter(item => match(item, query))
      .sort((a, b) => (a.state === 'library' ? 0 : 1) - (b.state === 'library' ? 0 : 1) || b.lastSeenAt - a.lastSeenAt)
    return items.slice(0, Math.max(1, Math.min(100, limit))).map(item => ({
      id: item.id,
      state: item.state,
      tags: [...item.tags],
      desc: item.desc,
      sourceText: item.sources[0]?.text ?? '',
      sendCount: item.sendCount,
    }))
  }

  const gateDenied = reason => ({ ok: false, error: `[sticker-gate] ${reason}` })

  async function send({ chatKey, target, transport, route = {}, mode = 'work', id = '', query = '', tag = '' }) {
    await load()
    if (!enabled) return gateDenied('图库未启用')
    if (mode !== 'chat') return gateDenied('仅聊天模式可发表情')
    if (target === null || target === undefined) return gateDenied('没有发送目标')
    const caps = typeof transport?.capabilitiesFor === 'function' ? transport.capabilitiesFor(target, route) : transport?.capabilities?.()
    if (caps === null || caps === undefined || !Array.isArray(caps.media) || !caps.media.includes('image')) return gateDenied('当前线路不支持图片')
    const key = String(chatKey ?? '')
    const now = clock()
    const sent = Array.isArray(state.sent[key]) ? state.sent[key].filter(at => now - at < 24 * 60 * 60 * 1000) : []
    const cooldown = settings.send?.cooldownMs ?? 10 * 60 * 1000
    if (cooldown > 0 && sent.length > 0 && now - sent[sent.length - 1] < cooldown) return gateDenied('同对话冷却中')
    const daily = settings.send?.dailyPerChat ?? 10
    if (daily > 0 && sent.filter(at => new Date(at).toDateString() === new Date(now).toDateString()).length >= daily) return gateDenied('今日表情额度已用完')

    let item = null
    if (id !== '') item = index.items[String(id)]
    if (item === undefined) item = null
    if (item === null && tag !== '') item = visible(key).find(candidate => candidate.tags.includes(String(tag))) ?? null
    if (item === null && query !== '') item = visible(key).find(candidate => match(candidate, query)) ?? null
    if (item === null && id === '' && tag === '' && query === '') {
      const library = visible(key).filter(candidate => candidate.state === 'library')
      item = library.length > 0 ? library[Math.floor(Math.random() * library.length)] : null
    }
    if (item === null) return gateDenied('没有找到合适的表情（可先用 list_stickers 查看）')
    if (item.state === 'trash') return gateDenied('这张图在回收站')
    if (!item.sources.some(source => source.visibility === 'shared' || source.chatKey === key)) return gateDenied('这张图不属于当前对话')
    const used = state.used[key] ?? {}
    const dupTtl = settings.send?.duplicateTtlMs ?? 24 * 60 * 60 * 1000
    if (dupTtl > 0 && used[item.id] !== undefined && now - used[item.id] < dupTtl) return gateDenied('这张图最近发过，换一张')
    const absolute = itemPath(item)
    if (!isInside(absolute)) return gateDenied('图片路径越界')
    try {
      const result = await transport.sendMedia(target, { kind: 'image', path: absolute }, route)
      if (result?.ok === false) return { ok: false, error: result.error ?? '发送失败' }
      item.sendCount += 1
      item.sentAt = now
      state.sent[key] = [...sent, now].slice(-100)
      state.used[key] = { ...used, [item.id]: now }
      await queue(async () => { await saveIndex(); await saveState() })
      return { ok: true, id: item.id, state: item.state }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async function setState(id, next) {
    await load()
    const item = index.items[String(id)]
    if (item === undefined) return false
    item.state = next
    await queue(saveIndex)
    return true
  }

  async function setMeta(id, { tags, desc } = {}) {
    await load()
    const item = index.items[String(id)]
    if (item === undefined) return false
    if (Array.isArray(tags)) item.tags = [...new Set(tags.map(tag => safeText(tag, 20)).filter(Boolean))].slice(0, 12)
    if (typeof desc === 'string') item.desc = safeText(desc, 300)
    await queue(saveIndex)
    return true
  }

  async function remove(id) {
    await load()
    const item = index.items[String(id)]
    if (item === undefined) return false
    await rm(itemPath(item), { force: true }).catch(() => {})
    delete index.items[item.id]
    await queue(saveIndex)
    return true
  }

  return {
    enabled,
    load,
    capture,
    stats,
    list,
    send,
    promote: id => setState(id, 'library'),
    trash: id => setState(id, 'trash'),
    restore: id => setState(id, 'candidate'),
    setMeta,
    remove,
    pathOf: id => {
      const item = index.items[String(id)]
      return item === undefined ? null : itemPath(item)
    },
    indexPath: () => indexPath,
    itemOf: id => (index.items[String(id)] ? { ...index.items[String(id)] } : null),
  }
}

export default createStickerStore
