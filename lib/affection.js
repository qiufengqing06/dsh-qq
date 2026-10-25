/**
 * 关系统计（熟识度）——默认关，只统计，不影响权限/礼貌/回复。
 *
 * 只记肉眼可核的计数：发言条数、被点名次数、发图次数、活跃天数；
 * 不存消息正文、不做“内心/表面”小模型、不根据好感冷落用户。
 * 数据在 dataDir/relations.json；页面可清除。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const KEEP_DAYS_DEFAULT = 30

function todayKey(now) {
  const d = new Date(now)
  const p = value => String(value).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function dayKeyOf(day) {
  return /^\d{4}-\d{2}-\d{2}$/.test(day)
}

export function createAffection({ dir, config, logger = null, clock = () => Date.now() }) {
  const settings = config.affection ?? {}
  const enabled = settings.enabled === true
  const file = join(dir, 'relations.json')
  const retentionDays = settings.retentionDays ?? KEEP_DAYS_DEFAULT
  const maxPeople = settings.maxPeoplePerGroup ?? 500
  let data = { version: 1, groups: {}, updatedAt: 0 }
  let loaded = false
  let writeChain = Promise.resolve()

  const log = {
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
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'))
      data = {
        version: 1,
        groups: parsed?.groups !== null && typeof parsed?.groups === 'object' ? parsed.groups : {},
        updatedAt: Number(parsed?.updatedAt) || 0,
      }
    } catch {
      data = { version: 1, groups: {}, updatedAt: 0 }
    }
  }

  async function save() {
    data.updatedAt = clock()
    await mkdir(dir, { recursive: true })
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    await writeFile(tmp, JSON.stringify(data), 'utf8')
    await rename(tmp, file)
  }

  function pruneGroup(group, now) {
    const cutoff = todayKey(now - retentionDays * 86400000)
    for (const member of Object.values(group.members ?? {})) {
      for (const day of Object.keys(member.days ?? {})) {
        if (day < cutoff) delete member.days[day]
      }
    }
    const rows = Object.entries(group.members ?? {})
    if (rows.length > maxPeople) {
      rows.sort((a, b) => (Number(a[1].lastAt) || 0) - (Number(b[1].lastAt) || 0))
      for (const [id] of rows.slice(0, rows.length - maxPeople)) delete group.members[id]
    }
  }

  function familiarityOf(member, now) {
    const days = member?.days ?? {}
    const activeDays = Object.keys(days).length
    let msgs = 0
    let mentions = 0
    let media = 0
    for (const cell of Object.values(days)) {
      msgs += Number(cell?.msgs) || 0
      mentions += Number(cell?.mentions) || 0
      media += Number(cell?.images) || 0
    }
    const clamp = value => Math.max(0, Math.min(1, value))
    const f = clamp(
      0.35 * Math.min(activeDays / 14, 1)
      + 0.25 * Math.min(msgs / 200, 1)
      + 0.20 * Math.min(mentions / 20, 1)
      + 0.20 * Math.min(media / 20, 1),
    )
    return { f, msgs, mentions, media, activeDays }
  }

  return {
    enabled,
    load,

    /** 记录一条群消息；只在 enabled + chat 模式 + 群聊生效。 */
    async observe(ev, mode = 'work') {
      if (!enabled) return false
      if (mode !== 'chat') return false
      if (ev === null || typeof ev !== 'object' || ev.target?.kind !== 'group') return false
      const senderId = String(ev.sender?.id ?? '')
      if (senderId === '') return false
      await load()
      const now = clock()
      const chatKey = String(ev.chatKey ?? '')
      if (chatKey === '') return false
      const group = data.groups[chatKey] ?? { members: {} }
      data.groups[chatKey] = group
      const member = group.members[senderId] ?? { name: '', firstAt: now, lastAt: 0, days: {} }
      group.members[senderId] = member
      member.name = String(ev.sender?.name ?? member.name ?? '').slice(0, 40)
      member.lastAt = now
      const day = todayKey(now)
      const cell = member.days[day] ?? { msgs: 0, mentions: 0, images: 0 }
      member.days[day] = cell
      cell.msgs += 1
      if (ev.mentioned === true) cell.mentions += 1
      if (Array.isArray(ev.media) && ev.media.some(item => item?.kind === 'image')) cell.images += 1
      pruneGroup(group, now)
      await queue(save)
      return true
    },

    /** 页面用：按群列出熟识度；不含正文。 */
    async snapshot() {
      if (!enabled) return { enabled: false, groups: [] }
      await load()
      const groups = Object.entries(data.groups).map(([chatKey, group]) => {
        const members = Object.entries(group.members ?? {}).map(([userId, member]) => {
          const stats = familiarityOf(member, clock())
          return { userId, name: member.name, lastAt: member.lastAt, ...stats }
        }).sort((a, b) => b.f - a.f)
        return { chatKey, members }
      }).filter(group => group.members.length > 0)
      return { enabled: true, groups }
    },

    async clear(chatKey) {
      await load()
      const key = String(chatKey ?? '')
      if (data.groups[key] === undefined) return false
      delete data.groups[key]
      await queue(save)
      return true
    },

    file: () => file,
  }
}

export default createAffection
