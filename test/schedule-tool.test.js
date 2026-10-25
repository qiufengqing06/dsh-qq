import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createScheduleTool } from '../lib/schedule-tool.js'

function env({ mode = 'chat' } = {}) {
  const tasks = []
  const store = {
    chat: () => ({ lastTarget: { kind: 'p2p', id: 'u1' } }),
    modeFor: () => mode,
    schedules: () => tasks.map(task => ({ ...task })),
    scheduleAdd: async task => { tasks.push(task); return task },
    scheduleRemove: async id => {
      const index = tasks.findIndex(task => task.id === id)
      if (index < 0) return false
      tasks.splice(index, 1)
      return true
    },
  }
  const tool = createScheduleTool({
    store,
    config: {},
    clock: () => Date.parse('2026-10-25T09:00:00+08:00'),
    chatKeyOf: () => 'qqbot:1:group:2',
  })
  return { store, tool, tasks }
}

const exec = { agent: { session: { id: 's1' } } }

test('schedule_task：创建固定提醒，目标用结构化 target', async () => {
  const e = env()
  const result = await e.tool.execute({ action: 'add', kind: 'daily', time: '09:00', prompt: '早安' }, exec)
  assert.equal(result.ok, true)
  assert.equal(e.tasks.length, 1)
  assert.deepEqual(e.tasks[0].target, { kind: 'group', groupId: '2' })
  assert.equal(e.tasks[0].social, false)
  assert.match(e.tasks[0].id, /^[0-9a-f-]{36}$/)
})

test('schedule_task：work 模式拒绝社交主动，允许固定提醒', async () => {
  const e = env({ mode: 'work' })
  const social = await e.tool.execute({ action: 'add', kind: 'daily', time: '09:00', prompt: '早安', social: true }, exec)
  assert.equal(social.ok, false)
  const fixed = await e.tool.execute({ action: 'add', kind: 'daily', time: '09:00', prompt: '开会' }, exec)
  assert.equal(fixed.ok, true)
})

test('schedule_task：list/remove 只操作当前对话', async () => {
  const e = env()
  await e.tool.execute({ action: 'add', kind: 'once', inSeconds: 60, prompt: '喝水' }, exec)
  const list = await e.tool.execute({ action: 'list' }, exec)
  assert.equal(list.tasks.length, 1)
  assert.match(list.message, /喝水/)
  const id = list.tasks[0].id
  assert.equal((await e.tool.execute({ action: 'remove', id }, exec)).ok, true)
  assert.equal(e.tasks.length, 0)
})
