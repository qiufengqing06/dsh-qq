/**
 * schedule_task 工具：让模型给当前 QQ 对话创建/查看/删除提醒或定时任务。
 *
 * 固定提醒（social=false）work/chat 都可；社交主动（social=true）仅 chat。
 * 权限：当前会话的 QQ 对话已由入站 ACL 授权；工具不再扩大写文件/命令权限。
 */

import { randomUUID } from 'node:crypto'
import { parseChatKey } from './transport.js'

/** "HH:MM" 校验。 */
function validTime(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim())
  if (match === null) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

export function createScheduleTool({ store, config = {}, clock = () => Date.now(), chatKeyOf }) {
  return {
    name: 'schedule_task',
    description:
      '给当前 QQ 对话创建、查看或删除定时任务/提醒。固定提醒（social=false）在工作/聊天模式都可用；' +
      '社交主动（social=true）只在聊天模式可用。时间用本地时区；一次性任务支持 at（ISO 时间）或 inSeconds；' +
      '每日任务用 time=HH:MM。只对当前对话生效，重启后保留。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'remove'] },
        kind: { type: 'string', enum: ['once', 'daily'] },
        at: { type: 'string', description: '一次性任务的 ISO 时间' },
        inSeconds: { type: 'integer', minimum: 30, description: '一次性任务：多少秒后' },
        time: { type: 'string', description: '每日任务：HH:MM' },
        prompt: { type: 'string', description: '到点后要执行/说的话' },
        social: { type: 'boolean', description: 'true=社交主动（仅 chat）' },
        id: { type: 'string', description: 'remove 的任务 id' },
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
          tasks: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
        required: ['ok', 'message'],
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.message ?? '') }],
    },
    async execute(args, exec) {
      const sessionId = String(exec?.agent?.session?.id ?? '')
      const chatKey = sessionId === '' ? null : chatKeyOf(sessionId)
      if (chatKey === null || chatKey === undefined) return { ok: false, message: 'schedule_task 只能在 QQ 对话里使用。' }
      const action = String(args?.action ?? '')
      const chat = store.chat(chatKey)
      const lastTarget = chat.lastTarget
      if (lastTarget === null || lastTarget === undefined) return { ok: false, message: '当前对话还没有可用的发送目标，先发一条消息再建任务。' }
      const route = parseChatKey(chatKey)
      const social = args?.social === true
      if (social && store.modeFor(chatKey) !== 'chat') return { ok: false, message: '社交主动仅聊天模式可用；固定提醒请把 social 设为 false。' }

      if (action === 'list') {
        const tasks = store.schedules().filter(task => task.chatKey === chatKey)
        const lines = tasks.length === 0
          ? ['当前对话没有定时任务。']
          : tasks.map(task => `- ${task.id} · ${task.kind === 'daily' ? `每天 ${task.time}` : new Date(task.at).toLocaleString()} · ${task.social ? '社交' : '提醒'} · ${task.prompt.slice(0, 40)}`)
        return { ok: true, message: lines.join('\n'), tasks }
      }

      if (action === 'remove') {
        const id = String(args?.id ?? '').trim()
        const task = store.schedules().find(item => item.id === id)
        if (task === undefined || task.chatKey !== chatKey) return { ok: false, message: '没有找到属于当前对话的任务 id。' }
        await store.scheduleRemove(id)
        return { ok: true, message: `已删除定时任务 ${id}。` }
      }

      if (action !== 'add') return { ok: false, message: 'action 必须是 add / list / remove。' }
      const prompt = String(args?.prompt ?? '').trim()
      if (prompt === '') return { ok: false, message: 'add 需要 prompt。' }
      const kind = args?.kind === 'daily' ? 'daily' : 'once'
      let at = null
      let time = ''
      if (kind === 'daily') {
        time = validTime(args?.time)
        if (time === null) return { ok: false, message: '每日任务需要 time=HH:MM。' }
      } else {
        const seconds = Number(args?.inSeconds)
        if (Number.isFinite(seconds) && seconds >= 30) at = clock() + Math.floor(seconds) * 1000
        else if (typeof args?.at === 'string' && args.at !== '') {
          const parsed = Date.parse(args.at)
          if (!Number.isFinite(parsed)) return { ok: false, message: 'at 必须是可解析的 ISO 时间。' }
          at = parsed
        } else return { ok: false, message: '一次性任务需要 inSeconds（≥30）或 at（ISO 时间）。' }
        if (at <= clock()) return { ok: false, message: '一次性任务的时间必须在未来。' }
      }
      const task = {
        id: randomUUID(),
        chatKey,
        transportKind: route.transportKind,
        accountId: route.accountId,
        target: route.target,
        prompt: prompt.slice(0, 2000),
        kind,
        time,
        at,
        enabled: true,
        social,
        createdBy: '',
        createdAt: clock(),
        lastRun: '',
        lastError: '',
      }
      try {
        const saved = await store.scheduleAdd(task)
        return { ok: true, message: `已创建定时任务 ${saved.id}（${kind === 'daily' ? `每天 ${time}` : new Date(at).toLocaleString()}）。` }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

export default createScheduleTool
