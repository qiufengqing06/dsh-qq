/**
 * 表情包图库（Phase 1）。
 *
 *  - 自动收藏只发生在 chat 模式的群聊；图存本机，按 SHA-256 去重；
 *  - 每张图保留多个 sources（来源群/发送者/原消息）；默认跨群共享，noShareGroups 例外；
 *  - candidate（待整理）/ library（已确认）/ trash（回收站）三态；
 *  - 发送闸门：chat 模式、media=image、冷却、每对话日预算、同图 TTL；
 *  - 标签和画面描述用于选图；视觉打标由可选的 tagger 负责。
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

const INDEX_VERSION = 1
const MEDIA_EXT = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' })
const TAG_ALIASES = Object.freeze({
  __proto__: null,
  happy: '开心', angry: '生气', sad: '难过', shy: '害羞', confused: '疑惑', daily: '日常',
  smug: '得意', proud: '得意', laugh: '嘲笑', teasing: '调侃', mock: '调侃',
  awkward: '尴尬', speechless: '无语', shocked: '震惊', surprised: '惊讶',
  cute: '卖萌', comfort: '安慰', apologize: '道歉', goodnight: '晚安', greeting: '问候',
  hungry: '饿了', eating: '吃饭', refusal: '拒绝', agree: '赞同', thinking: '思考',
  dislike: '嫌弃', love: '喜欢', hug: '抱抱', thanks: '感谢',
})

export function normalizeStickerTag(value) {
  const text = safeText(value, 20)
  return TAG_ALIASES[text.toLowerCase()] ?? text
}

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
      tags: Array.isArray(item.tags) ? [...new Set(item.tags.map(normalizeStickerTag).filter(Boolean))].slice(0, 12) : [],
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
  let loadPromise = null
  const sendChains = new Map()
  let captureHook = null

  const log = {
    info: message => { try { logger?.info?.(message) } catch { /* ignore */ } },
    warn: message => { try { logger?.warn?.(message) } catch { /* ignore */ } },
  }

  function queue(fn) {
    const next = writeChain.then(fn, fn)
    writeChain = next.catch(() => {})
    return next
  }

  function load() {
    if (loadPromise === null) loadPromise = loadFiles()
    return loadPromise
  }

  async function loadFiles() {
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
    const words = queryWords(query)
    if (words.length === 0) return true
    const hay = [item.desc, ...item.tags, ...item.sources.map(source => source.text ?? '')].join(' ').toLowerCase()
    return words.every(word => hay.includes(word))
  }

  function queryWords(query) {
    return String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean).map(word => TAG_ALIASES[word] ?? word)
  }

  function recentSends(key, now) {
    return (Array.isArray(state.sent[key]) ? state.sent[key] : [])
      .map(entry => typeof entry === 'number' ? { at: entry, turnId: '' } : entry)
      .filter(entry => entry !== null && typeof entry === 'object' && Number.isFinite(entry.at) && now - entry.at < 24 * 60 * 60 * 1000)
  }

  function chatReason(key, turnId, now) {
    if (!enabled) return '图库未启用'
    const sent = recentSends(key, now)
    const max = settings.send?.perTurnMax ?? 2
    if (turnId && sent.filter(entry => entry.turnId === turnId).length >= max) return `本轮表情已达 ${max} 张上限`
    const daily = settings.send?.dailyPerChat ?? 10
    if (daily > 0 && sent.filter(entry => new Date(entry.at).toDateString() === new Date(now).toDateString()).length >= daily) return '今日表情额度已用完'
    const last = sent[sent.length - 1]
    const cooldown = settings.send?.cooldownMs ?? 10 * 60 * 1000
    // 只有同一真实轮次的连续动作绕过轮间冷却；没有 turnId 时保持逐次冷却。
    if (cooldown > 0 && last && now - last.at < cooldown && !(turnId && last.turnId === turnId)) return '同对话冷却中'
    return ''
  }

  function itemReason(item, key, now) {
    if (item.state === 'trash') return '这张图在回收站'
    if (!item.sources.some(source => source.visibility === 'shared' || source.chatKey === key)) return '这张图不属于当前对话'
    const usedAt = state.used[key]?.[item.id]
    const ttl = settings.send?.duplicateTtlMs ?? 24 * 60 * 60 * 1000
    if (ttl > 0 && Number.isFinite(usedAt) && now - usedAt < ttl) return '这张图最近发过，换一张'
    if (!isInside(itemPath(item))) return '图片路径越界'
    return ''
  }

  function rank(items, key, query) {
    const words = queryWords(query)
    const score = item => words.reduce((total, word) => total
      + (item.tags.some(tag => tag.toLowerCase() === word) ? 4 : 0)
      + (item.desc.toLowerCase().includes(word) ? 2 : 0), 0)
    return items.sort((a, b) => score(b) - score(a)
      || (a.state === 'library' ? 0 : 1) - (b.state === 'library' ? 0 : 1)
      || (state.used[key]?.[a.id] ?? 0) - (state.used[key]?.[b.id] ?? 0)
      || a.sendCount - b.sendCount || b.lastSeenAt - a.lastSeenAt || a.id.localeCompare(b.id))
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
      visibility: ev.target?.kind === 'group'
        && settings.crossGroup === true
        && !(settings.noShareGroups ?? []).includes(String(ev.target?.groupId ?? ''))
        ? 'shared'
        : 'local',
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
    if (ev === null || typeof ev !== 'object') return 0
    const targetKind = ev.target?.kind
    if (targetKind !== 'group' && targetKind !== 'dm') return 0
    const media = Array.isArray(ev.media) ? ev.media.filter(item => item?.kind === 'image').slice(0, settings.maxPerMessage ?? 3) : []
    if (media.length === 0) return 0
    let saved = 0
    const savedIds = []
    for (const item of media) {
      try {
        const id = await captureOne(item, ev, download, mode)
        if (id !== null) {
          saved += 1
          savedIds.push(id)
        }
      } catch (error) {
        log.warn(`dsh-qq: 表情包入库失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (saved > 0) {
      await cleanup()
      await queue(saveIndex)
      log.info(`dsh-qq: 表情包入库 ${saved} 张（当前 ${Object.keys(index.items).length}）`)
      if (typeof captureHook === 'function') {
        for (const id of savedIds) {
          try {
            Promise.resolve(captureHook(id)).catch(error => log.warn(`dsh-qq: 表情包后处理失败：${error instanceof Error ? error.message : String(error)}`))
          } catch (error) {
            log.warn(`dsh-qq: 表情包后处理失败：${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
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

  function listAll(limit = 200) {
    return Object.values(index.items)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, Math.max(1, Math.min(500, limit)))
      .map(item => ({
        id: item.id,
        state: item.state,
        tags: [...item.tags],
        desc: item.desc,
        sourceText: item.sources[0]?.text ?? '',
        sourceName: item.sources[0]?.senderName ?? '',
        sourceAt: item.sources[0]?.at ?? 0,
        sourceGroup: item.sources[0]?.groupId ?? '',
        bytes: item.bytes,
        createdAt: item.createdAt,
        sentAt: item.sentAt,
        sendCount: item.sendCount,
      }))
  }

  function list(chatKey, { query = '', limit = 20, includeCandidates = true, turnId = '' } = {}) {
    const key = String(chatKey ?? '')
    const now = clock()
    const blocked = chatReason(key, String(turnId ?? ''), now)
    const items = rank(visible(key)
      .filter(item => includeCandidates || item.state === 'library')
      .filter(item => match(item, query)), key, query)
      .map(item => ({ item, reason: blocked || itemReason(item, key, now) }))
      .sort((a, b) => Number(Boolean(a.reason)) - Number(Boolean(b.reason)))
    return items.slice(0, Math.max(1, Math.min(100, limit))).map(({ item, reason }) => ({
      id: item.id,
      state: item.state,
      tags: [...item.tags],
      desc: item.desc,
      sourceText: item.sources[0]?.text ?? '',
      sendCount: item.sendCount,
      available: reason === '',
      reason,
    }))
  }

  const gateDenied = reason => ({ ok: false, error: `[sticker-gate] ${reason}` })

  function send(options) {
    const key = String(options.chatKey ?? '')
    // 整个检查→平台发送→记账按对话串行，两个并发工具不能同时占到最后一个额度。
    const previous = sendChains.get(key) ?? Promise.resolve()
    const job = previous.catch(() => {}).then(() => sendOne(options))
    sendChains.set(key, job)
    const clear = () => { if (sendChains.get(key) === job) sendChains.delete(key) }
    job.then(clear, clear)
    return job
  }

  async function sendOne({ chatKey, target, transport, route = {}, mode = 'work', id = '', query = '', tag = '', turnId = '', isValid = () => true }) {
    await load()
    const valid = async () => {
      try { return await isValid() === true } catch { return false }
    }
    if (!await valid()) return gateDenied('本轮已取消或发送权限已变化')
    if (!enabled) return gateDenied('图库未启用')
    if (mode !== 'chat') return gateDenied('仅聊天模式可发表情')
    if (target === null || target === undefined) return gateDenied('没有发送目标')
    const caps = typeof transport?.capabilitiesFor === 'function' ? transport.capabilitiesFor(target, route) : transport?.capabilities?.()
    if (caps === null || caps === undefined || !Array.isArray(caps.media) || !caps.media.includes('image')) return gateDenied('当前线路不支持图片')
    const key = String(chatKey ?? '')
    const turn = String(turnId ?? '')
    const now = clock()
    const blocked = chatReason(key, turn, now)
    if (blocked) return gateDenied(blocked)

    let item = null
    if (id !== '') {
      item = index.items[String(id)] ?? null
      if (item !== null) {
        const reason = itemReason(item, key, now)
        if (reason) return gateDenied(reason)
      }
    } else {
      // 先排除重复/不可见候选，再排序；不能让第一张不可用的图挡住后面的匹配图。
      const wantedTag = normalizeStickerTag(tag)
      const candidates = visible(key)
        .filter(candidate => itemReason(candidate, key, now) === '')
        .filter(candidate => !wantedTag || candidate.tags.includes(wantedTag))
        .filter(candidate => !query || match(candidate, query))
        .filter(candidate => wantedTag || query || candidate.state === 'library')
      item = rank(candidates, key, query || wantedTag)[0] ?? null
    }
    if (item === null) return gateDenied('没有找到合适的表情（可先用 list_stickers 查看）')
    const absolute = itemPath(item)
    try {
      if (!await valid()) return gateDenied('本轮已取消或发送权限已变化')
      const reason = itemReason(item, key, clock())
      if (reason || index.items[item.id] !== item) return gateDenied(reason || '这张图已删除')
      const result = await transport.sendMedia(target, { kind: 'image', path: absolute }, route)
      if (result?.ok === false) return { ok: false, error: result.error ?? '发送失败' }
      const sentAt = clock()
      item.sendCount += 1
      item.sentAt = sentAt
      state.sent[key] = [...recentSends(key, sentAt), { at: sentAt, turnId: turn }].slice(-100)
      state.used[key] = { ...state.used[key], [item.id]: sentAt }
      try {
        await queue(async () => { await saveState(); await saveIndex() })
      } catch (error) {
        // 平台已发送的事实不能被落盘错误改成失败，否则调用方可能再补发一遍。
        log.warn(`dsh-qq: 表情已发送，但本地记录保存失败：${error instanceof Error ? error.message : String(error)}`)
      }
      return { ok: true, id: item.id, state: item.state, desc: item.desc, ...(result?.messageId !== undefined ? { messageId: result.messageId } : {}) }
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
    if (Array.isArray(tags)) item.tags = [...new Set(tags.map(normalizeStickerTag).filter(Boolean))].slice(0, 12)
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

  function describeHash(chatKey, hash) {
    const key = String(chatKey ?? '')
    const item = visible(key).find(candidate => candidate.sha256 === hash)
    if (!item) return null
    const sentAt = state.used[key]?.[item.id]
    const wasSentHere = Number.isFinite(sentAt)
    return { id: item.id, desc: item.desc, tags: [...item.tags], wasSentHere, ...(wasSentHere ? { sentAt } : {}) }
  }

  return {
    enabled,
    load,
    capture,
    stats,
    list,
    listAll,
    send,
    describeHash,
    describeImage: (chatKey, data) => Buffer.isBuffer(data) ? describeHash(chatKey, sha256(data)) : null,
    promote: id => setState(id, 'library'),
    trash: id => setState(id, 'trash'),
    restore: id => setState(id, 'candidate'),
    setMeta,
    remove,
    setCaptureHook: fn => { captureHook = typeof fn === 'function' ? fn : null },
    pathOf: id => {
      const item = index.items[String(id)]
      return item === undefined ? null : itemPath(item)
    },
    indexPath: () => indexPath,
    itemOf: id => (index.items[String(id)] ? { ...index.items[String(id)] } : null),
  }
}

export default createStickerStore
