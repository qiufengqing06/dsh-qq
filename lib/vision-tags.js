/**
 * 表情包视觉打标（可选）：用当前 DSH 的 LLM 给新入库的图片打标签并区分
 * 表情包 / 截图。默认用 deepseek-account / deepseek-flash；失败只记日志，
 * 不影响图片入库，也不阻塞消息。
 *
 * 隐私：图片会以附件形式发给当前配置的模型；不额外落日志/聊天记录。
 */

import { normalizeStickerTag } from './stickers.js'

const PROMPT = [
  '判断这张图片是不是聊天里的表情包/梗图/反应图。',
  '只输出一行 JSON，不要解释、不要代码块：',
  '{"kind":"sticker"或"other","tags":["1-3个中文用途标签"],"desc":"不超过60字，描述角色、动作、表情和图中文字"}',
  'kind=sticker：适合当表情包发的图（角色、动物、梗图、反应表情、带字的搞笑图）。',
  'kind=other：截图、图表、文档、照片、二维码、聊天记录、界面等。',
  'tags 优先表示聊天用途，例如：开心、嫌弃、调侃、得意、无语、害羞、疑惑、安慰、拒绝、晚安、吃饭；不要只写猫猫、人物等主体类别。',
  'desc 只描述图中看得见的内容，保留关键台词，不编造角色身份或画面外的故事。',
].join('\n')

function todayKey(now) {
  const d = new Date(now)
  const p = value => String(value).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function cleanTag(value) {
  return normalizeStickerTag(String(value ?? '').replace(/[\s"'`\\]/g, '')).slice(0, 12)
}

export function parseTagJson(text) {
  const raw = String(text ?? '').trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let data
  try { data = JSON.parse(raw.slice(start, end + 1)) } catch { return null }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  const kind = data.kind === 'sticker' ? 'sticker' : data.kind === 'other' ? 'other' : ''
  if (kind === '') return null
  const tags = Array.isArray(data.tags)
    ? [...new Set(data.tags.map(cleanTag).filter(Boolean))].slice(0, 5)
    : []
  const desc = String(data.desc ?? '').trim().slice(0, 60)
  return { kind, tags, desc }
}

export function createStickerTagger({ ctx, config, store, logger = null, clock = () => Date.now() }) {
  const settings = config.stickers?.vision ?? {}
  const enabled = settings.enabled === true
  const provider = String(settings.provider ?? 'deepseek-account')
  const model = String(settings.model ?? 'deepseek-flash')
  const maxPerDay = Number(settings.maxPerDay ?? 80)
  let day = todayKey(clock())
  let used = 0
  /** 串行队列：视觉模型并发 7 张容易被限流，一张一张来。 */
  let chain = Promise.resolve()
  const jobs = new Map()
  let running = false
  let completed = 0
  let failed = 0
  let lastError = ''
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

  const log = {
    info: message => { try { logger?.info?.(message) } catch { /* ignore */ } },
    warn: message => { try { logger?.warn?.(message) } catch { /* ignore */ } },
  }

  async function callVision(bytes, mediaType) {
    const llm = typeof ctx?.get === 'function' ? ctx.get('llm') : null
    const attachments = typeof ctx?.get === 'function' ? ctx.get('attachments') : null
    if (llm === null || llm === undefined || typeof llm.stream !== 'function') throw new Error('LLM 服务不可用')
    if (attachments === null || attachments === undefined || typeof attachments.saveImage !== 'function') throw new Error('附件服务不可用')
    const ref = await attachments.saveImage({ data: bytes, mediaType })
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: PROMPT },
        { type: 'image', attachment: ref },
      ],
    }]
    let text = ''
    let finish = null
    for await (const chunk of llm.stream({ provider, model, messages, maxTokens: 200, temperature: 0 })) {
      if (chunk?.type === 'text-delta') text += chunk.text
      if (chunk?.type === 'finish') finish = chunk.reason
    }
    if (finish !== null && finish?.kind !== 'stop') {
      throw new Error(`视觉模型未正常结束（${finish.kind ?? 'unknown'}）`)
    }
    return text
  }

  async function tagOne(id) {
    if (!enabled) return false
    if (maxPerDay > 0) {
      const today = todayKey(clock())
      if (today !== day) { day = today; used = 0 }
      if (used >= maxPerDay) return false
    }
    const item = store.itemOf(id)
    if (item === null || item.state === 'trash') return false
    const path = store.pathOf(id)
    if (path === null) return false
    used += 1
    try {
      const { readFile } = await import('node:fs/promises')
      const bytes = await readFile(path)
      let text
      try {
        text = await callVision(bytes, item.mime || 'image/png')
      } catch (error) {
        // 限流/瞬时网络错误：等 700ms 重试一次；仍失败就留给页面“补打标签”。
        await sleep(700)
        text = await callVision(bytes, item.mime || 'image/png')
      }
      const parsed = parseTagJson(text)
      if (parsed === null) throw new Error('视觉模型没有返回合法 JSON')
      const latest = store.itemOf(id)
      if (!latest || latest.state === 'trash') return false
      if (latest.desc !== item.desc || JSON.stringify(latest.tags) !== JSON.stringify(item.tags)) return true
      const tags = parsed.kind === 'other'
        ? [...new Set([...parsed.tags, '非表情包'])].slice(0, 6)
        : parsed.tags
      await store.setMeta(id, {
        tags: [...new Set([...(item.tags ?? []), ...tags])].slice(0, 12),
        desc: parsed.desc || (parsed.kind === 'other' ? '截图/非表情包' : ''),
      })
      if (parsed.kind === 'other' && settings.autoTrashOther !== false && store.itemOf(id)?.state === 'candidate') {
        await store.trash(id)
        log.info(`dsh-qq: 视觉打标 ${id.slice(0, 8)} → 非表情包，已移入回收站`)
      } else {
        log.info(`dsh-qq: 视觉打标 ${id.slice(0, 8)} → ${parsed.kind}（${tags.join('/') || '无标签'}）`)
      }
      return true
    } catch (error) {
      log.warn(`dsh-qq: 视觉打标失败：${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  function tag(id) {
    if (jobs.has(id)) return jobs.get(id)
    const job = chain.then(async () => {
      running = true
      try {
        const ok = await tagOne(id)
        if (ok) { completed += 1; lastError = '' }
        else { failed += 1; lastError = '图片识别未完成，请检查模型额度、图片状态或稍后重试' }
        return ok
      } finally { running = false; jobs.delete(id) }
    })
    jobs.set(id, job)
    chain = job.catch(() => {})
    return job
  }

  async function tagPending({ limit = 20 } = {}) {
    if (!enabled) return { tagged: 0, tried: 0 }
    const items = []
    const max = Math.max(1, Math.min(20, limit))
    for (let offset = 0; items.length < max; offset += 500) {
      const page = store.listAll(500, { offset })
      items.push(...page.filter(item => item.state !== 'trash'
        && (!String(item.desc ?? '').trim() || !Array.isArray(item.tags) || item.tags.length === 0)).slice(0, max - items.length))
      if (page.length < 500) break
    }
    let tagged = 0
    for (const ok of await Promise.all(items.map(item => tag(item.id)))) if (ok) tagged += 1
    return { tagged, tried: items.length }
  }

  return {
    enabled,
    provider,
    model,
    tag,
    tagPending,
    snapshot: () => ({ running, pending: Math.max(0, jobs.size - Number(running)), completed, failed, lastError }),
  }
}

export default createStickerTagger
