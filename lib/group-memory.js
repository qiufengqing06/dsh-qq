/**
 * 群记忆（执行文档二期 P7：热闹群里的「长期约定/梗/知识」不丢，又不炸上下文）。
 *
 * 为什么不做「全量归档」：真实的群一天几千条消息 + 媒体 MB 级，落盘就是无界增长、
 * 还要定义 TTL/配额/清理，并且把**别人的聊天记录**永久保存下来——
 * 对一个「一条命令装卸」的渠道插件来说成本远大于收益（评估见执行文档）。
 *
 * 本模块用三层解决同一问题，且**不产生任何额外 LLM 调用**：
 *   ① 环境缓冲：所有入站群消息（**含未 @ 机器人的**）按群进一个有界环形缓冲；
 *   ② 动态上下文：机器人被 @ 时，把「上次投递之后」的群消息注入这一轮内容（有字符预算）；
 *   ③ 长期记忆：每群一份人可读的笔记文件（`groups/<群>.md`），由模型用 `qq_group_note`
 *      工具维护，被 @ 时注入——落盘、跨重启、可人工编辑。
 *
 * 与 DSH 记忆的关系：群事实**不再写进 daily/project 记忆**（那是用户工作区的记忆，
 * 群聊闲聊混进去就是污染）；这里给群一个专属落点，边界清楚。
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { speakerTag } from './bridge.js'

/** 环形缓冲里单条消息保留的文本长度（超出即截断，缓冲只用于「刚才在聊什么」）。 */
const ENTRY_TEXT_MAX = 160
/** 笔记文件的标题行（人可读，也便于手工整理）。 */
const NOTES_HEADER = '# 群记忆（由 dsh-qq 维护，可手工编辑）\n'

/** 媒体种类 → 缓冲里的可读占位（缓冲只给模型看「刚才发生了什么」）。 */
const MEDIA_LABEL = Object.freeze({ image: '[图片]', file: '[文件]', audio: '[语音]', video: '[视频]' })

/**
 * 创建群记忆。
 * @param {object} deps
 * @param {string} deps.dir - 数据目录（与 store 同一个；笔记写 `<dir>/groups/`）。
 * @param {object} deps.config - resolveConfig 结果（读 groupMemory 段）。
 * @param {object} [deps.logger]
 * @param {() => number} [deps.clock]
 * @returns {object} groupMemory
 */
export function createGroupMemory({ dir, config, logger = null, clock = () => Date.now() }) {
  const settings = config.groupMemory
  const enabled = settings?.enabled === true
  const groupsDir = join(dir, 'groups')
  /** chatKey → { entries: [], seq: number, watermark: number } */
  const buffers = new Map()
  /** chatKey → { text: string, loaded: boolean } */
  const notes = new Map()

  const log = {
    info: message => {
      try {
        logger?.info?.(message)
      } catch {
        /* ignore */
      }
    },
    warn: message => {
      try {
        logger?.warn?.(message)
      } catch {
        /* ignore */
      }
    },
  }

  /** chatKey → 安全的文件名（可读优先：qqbot_1905346673_group_798898058.md）。 */
  const fileNameOf = chatKey => `${String(chatKey).replace(/[^A-Za-z0-9_.-]+/g, '_')}.md`
  const pathOf = chatKey => join(groupsDir, fileNameOf(chatKey))

  /**
   * 同一笔记文件的「读 → 改 → 写」必须串行：页面编辑与模型工具可能同时写同一个群，
   * 并发时后写入者会拿着旧快照覆盖前一次更新。锁按文件名排队，不同群互不阻塞。
   */
  const noteChains = new Map()
  function withNoteLock(fileName, fn) {
    const previous = noteChains.get(fileName) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(fn)
    noteChains.set(fileName, next.catch(() => {}))
    return next
  }

  const bufferOf = chatKey => {
    let state = buffers.get(chatKey)
    if (state === undefined) {
      state = { entries: [], seq: 0, watermark: 0 }
      buffers.set(chatKey, state)
    }
    return state
  }

  /** 入站消息 → 缓冲条目（只有群消息进缓冲：私聊本来就句句对着机器人）。 */
  function toEntry(ev) {
    const text = String(ev.text ?? '').replace(/\s+/g, ' ').trim().slice(0, ENTRY_TEXT_MAX)
    const mediaLabel = (Array.isArray(ev.media) ? ev.media : [])
      .map(item => MEDIA_LABEL[item.kind] ?? '[附件]')
      .join('')
    const body = `${text}${mediaLabel}`.trim()
    if (body === '') return null
    return {
      at: Number(ev.timestamp ?? clock()),
      sender: { id: ev.sender?.id ?? '', name: ev.sender?.name ?? '' },
      text: body,
    }
  }

  const formatLine = entry => {
    const at = new Date(entry.at)
    const hh = String(at.getHours()).padStart(2, '0')
    const mm = String(at.getMinutes()).padStart(2, '0')
    return `${hh}:${mm} ${speakerTag(entry.sender)}${entry.text}`
  }

  return {
    enabled,

    /**
     * 记录一条入站消息（由 index.js 在**路由之后**调用：本条不该出现在自己的注入里）。
     * 未 @ 机器人的群消息同样记录——这正是「群里聊得热闹」能变成上下文的前提。
     * @param {object} ev - 归一化入站事件
     */
    observe(ev) {
      if (!enabled) return false
      if (ev === null || typeof ev !== 'object') return false
      if (ev.target?.kind !== 'group') return false
      const entry = toEntry(ev)
      if (entry === null) return false
      const state = bufferOf(ev.chatKey)
      state.seq += 1
      state.entries.push({ ...entry, seq: state.seq })
      const limit = Math.max(1, settings.bufferMessages)
      if (state.entries.length > limit) state.entries.splice(0, state.entries.length - limit)
      return true
    },

    /**
     * 取「上次投递之后」的群消息，用于注入这一轮（并推进水位，不重复注入）。
     * @param {string} chatKey
     * @returns {{text: string, count: number, omitted: number}} text 为空表示没有新消息
     */
    pendingContext(chatKey) {
      if (!enabled) return { text: '', count: 0, omitted: 0 }
      const state = buffers.get(chatKey)
      if (state === undefined) return { text: '', count: 0, omitted: 0 }
      const fresh = state.entries.filter(entry => entry.seq > state.watermark)
      if (fresh.length === 0) return { text: '', count: 0, omitted: 0 }
      const budget = Math.max(0, settings.contextMaxChars)
      const picked = []
      let used = 0
      // 从最新往前装，保证「刚才」优先；装不下的旧消息丢弃并如实告知
      for (let index = fresh.length - 1; index >= 0; index -= 1) {
        const line = formatLine(fresh[index])
        if (used + line.length + 1 > budget) break
        picked.push(line)
        used += line.length + 1
      }
      picked.reverse()
      state.watermark = fresh[fresh.length - 1].seq
      const omitted = fresh.length - picked.length
      return {
        text: picked.join('\n'),
        count: picked.length,
        omitted,
      }
    },

    /** 读取某群笔记（首次访问从磁盘加载；不存在返回空串）。 */
    async notesOf(chatKey) {
      if (!enabled) return ''
      const cached = notes.get(chatKey)
      if (cached !== undefined) return cached.text
      let text = ''
      try {
        text = await readFile(pathOf(chatKey), 'utf8')
      } catch {
        text = '' // 首次使用：还没有笔记文件，不是错误
      }
      const normalized = text === '' ? '' : text.slice(0, settings.notesMaxChars)
      notes.set(chatKey, { text: normalized })
      return normalized
    },

    /**
     * 修改某群笔记（`qq_group_note` 工具的执行体）。
     * 容量上限是**硬闸门**：写超了不落盘，返回可操作的提示让模型自己收敛（避免无界增长）。
     * @param {string} chatKey
     * @param {{action: string, text?: string, match?: string}} args
     * @returns {Promise<{ok: boolean, message: string, chars: number}>}
     */
    async editNotes(chatKey, args) {
      return withNoteLock(fileNameOf(chatKey), () => this.editNotesUnlocked(chatKey, args))
    },

    /** editNotes 的实际执行体：调用方必须已经持有该文件的写锁。 */
    async editNotesUnlocked(chatKey, args) {
      if (!enabled) return { ok: false, message: '群记忆功能未启用（配置 groupMemory.enabled=false）。', chars: 0 }
      const action = String(args?.action ?? '')
      const current = await this.notesOf(chatKey)
      const clean = value =>
        String(value ?? '')
          .replace(/[\r\n]+/g, ' ')
          .trim()
      const text = clean(args?.text)
      const match = clean(args?.match)
      const lines = current.replace(/^# .*\n/, '').split('\n').filter(line => line.trim() !== '')

      if (action === 'add') {
        if (text === '') return { ok: false, message: 'add 需要 text。', chars: current.length }
        const line = `- ${text}`
        if (lines.includes(line)) {
          return { ok: true, message: `该条已在群记忆里，无需重复记录（当前 ${current.length} 字）。`, chars: current.length }
        }
        lines.push(line)
      } else if (action === 'replace') {
        if (match === '' || text === '') return { ok: false, message: 'replace 需要 match 与 text。', chars: current.length }
        const index = lines.findIndex(line => line.includes(match))
        if (index < 0) return { ok: false, message: `群记忆里没有匹配「${match}」的条目。`, chars: current.length }
        lines[index] = `- ${text}`
      } else if (action === 'remove') {
        if (match === '') return { ok: false, message: 'remove 需要 match。', chars: current.length }
        const index = lines.findIndex(line => line.includes(match))
        if (index < 0) return { ok: false, message: `群记忆里没有匹配「${match}」的条目。`, chars: current.length }
        lines.splice(index, 1)
      } else {
        return { ok: false, message: 'action 必须是 add / replace / remove。', chars: current.length }
      }

      const next = lines.length === 0 ? '' : `${NOTES_HEADER}${lines.join('\n')}\n`
      if (next.length > settings.notesMaxChars) {
        return {
          ok: false,
          message: `群记忆已满（${next.length} > ${settings.notesMaxChars} 字），本次未写入。请先用 replace/remove 合并或删掉过时条目，再记新的。`,
          chars: current.length,
        }
      }
      try {
        await mkdir(groupsDir, { recursive: true })
        const tmp = `${pathOf(chatKey)}.tmp-${process.pid}-${randomUUID()}`
        await writeFile(tmp, next, 'utf8')
        await rename(tmp, pathOf(chatKey))
      } catch (error) {
        log.warn(`dsh-qq: 群记忆写入失败：${error instanceof Error ? error.message : String(error)}`)
        return { ok: false, message: `群记忆写入失败：${error instanceof Error ? error.message : String(error)}`, chars: current.length }
      }
      notes.set(chatKey, { text: next })
      return { ok: true, message: `已更新群记忆（当前 ${next.length} 字）。`, chars: next.length }
    },

    /**
     * 列出已有群笔记（控制台「群记忆」卡片用）。
     * @returns {Promise<Array<{file: string, chars: number, updatedAt: number}>>}
     */
    async listNotes() {
      if (!enabled) return []
      let names = []
      try {
        names = await readdir(groupsDir)
      } catch {
        return [] // 目录还不存在：没有笔记
      }
      const rows = []
      for (const name of names) {
        if (!/\.md$/.test(name)) continue
        try {
          const [text, info] = await Promise.all([readFile(join(groupsDir, name), 'utf8'), stat(join(groupsDir, name))])
          rows.push({ file: name, chars: text.length, updatedAt: info.mtimeMs })
        } catch {
          /* 文件刚被删掉：跳过 */
        }
      }
      rows.sort((a, b) => b.updatedAt - a.updatedAt)
      return rows
    },

    /** 读整篇群笔记（编辑用；文件名必须落在 groups/ 下且是 .md）。 */
    async readNoteFile(file) {
      const name = String(file ?? '')
      if (!/^[A-Za-z0-9_.-]+\.md$/.test(name)) return { ok: false, error: '文件名不合法' }
      try {
        const text = await readFile(join(groupsDir, name), 'utf8')
        return { ok: true, text, chars: text.length }
      } catch {
        return { ok: false, error: '笔记不存在或读取失败' }
      }
    },

    /**
     * 整篇写入群笔记（控制台人工编辑用）。容量上限同样是硬闸门。
     * @param {string} file
     * @param {string} text
     * @returns {Promise<{ok: boolean, chars?: number, error?: string}>}
     */
    async writeNoteFile(file, text) {
      return withNoteLock(String(file ?? ''), () => this.writeNoteFileUnlocked(file, text))
    },

    /** writeNoteFile 的实际执行体：调用方必须已经持有该文件的写锁。 */
    async writeNoteFileUnlocked(file, text) {
      if (!enabled) return { ok: false, error: '群记忆功能未启用（配置 groupMemory.enabled=false）' }
      const name = String(file ?? '')
      if (!/^[A-Za-z0-9_.-]+\.md$/.test(name)) return { ok: false, error: '文件名不合法' }
      const body = String(text ?? '')
      if (body.length > settings.notesMaxChars) {
        return { ok: false, error: `超过容量上限（${body.length} > ${settings.notesMaxChars} 字）` }
      }
      try {
        await mkdir(groupsDir, { recursive: true })
        const target = join(groupsDir, name)
        const tmp = `${target}.tmp-${process.pid}-${randomUUID()}`
        await writeFile(tmp, body, 'utf8')
        await rename(tmp, target)
      } catch (error) {
        return { ok: false, error: `写入失败：${error instanceof Error ? error.message : String(error)}` }
      }
      // 让注入缓存失效：下次被 @ 时读到的是页面刚写的新内容
      for (const [chatKey] of notes) {
        if (fileNameOf(chatKey) === name) notes.delete(chatKey)
      }
      return { ok: true, chars: body.length }
    },

    /** chatKey → 文件名（页面新建笔记时用）。 */
    fileNameOf,

    /** 诊断用：缓冲与笔记规模。 */
    stats() {
      return {
        enabled,
        groups: buffers.size,
        buffered: [...buffers.values()].reduce((sum, state) => sum + state.entries.length, 0),
        notesLoaded: [...notes.values()].filter(entry => entry.text !== '').length,
      }
    },
  }
}

/**
 * `qq_group_note` 工具定义：让模型自己维护当前群的长期记忆。
 * 与 DSH 的 memory 工具同一种模式（模型在自己的回合里写），不额外花钱、不黑箱。
 * @param {object} deps
 * @param {object} deps.memory - createGroupMemory 结果
 * @param {(sessionId: string) => string|null} deps.chatKeyOf - 会话 → 群 chatKey（非群会话返回 null）
 * @returns {object} ToolDefinition
 */
export function createGroupNoteTool({ memory, chatKeyOf }) {
  return {
    name: 'qq_group_note',
    description:
      '记录或修改「当前 QQ 群」的长期记忆（群里的约定、称呼、梗、群知识、重要背景）。' +
      '只能在 QQ 群会话里使用：写入的是该群专属笔记，换群不会串；机器人下次被 @ 时会自动带上这段记忆。' +
      '只记长期有效的内容，不要记闲聊流水与临时安排（那些由「群最近消息」上下文覆盖）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['add', 'replace', 'remove'], description: 'add 追加、replace 替换匹配到的条目、remove 删除匹配到的条目' },
        text: { type: 'string', description: 'add/replace 的新内容（一句话，不要换行）' },
        match: { type: 'string', description: 'replace/remove 要匹配的现有条目片段' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          chars: { type: 'integer' },
        },
        required: ['ok', 'message'],
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.message ?? '') }],
    },
    async execute(args, exec) {
      const sessionId = String(exec?.agent?.session?.id ?? '')
      const chatKey = sessionId === '' ? null : chatKeyOf(sessionId)
      if (chatKey === null) {
        return { ok: false, message: 'qq_group_note 只能在 QQ 群会话里使用（当前会话不是由 QQ 群托管的）。' }
      }
      return await memory.editNotes(chatKey, args ?? {})
    },
  }
}

export default createGroupMemory
