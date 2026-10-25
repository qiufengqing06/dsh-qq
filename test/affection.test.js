import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveConfig } from '../lib/config.js'
import { createAffection } from '../lib/affection.js'

function at(day, hour = 12) {
  return new Date(2026, 9, day, hour, 0, 0).getTime()
}

async function setup({ enabled = true, retentionDays = 30 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-affection-'))
  const config = resolveConfig({ transport: 'mock', dataDir: dir, affection: { enabled, retentionDays } })
  const state = { now: at(25) }
  const affection = createAffection({ dir, config, clock: () => state.now })
  await affection.load()
  return { dir, config, affection, state }
}

const ev = (id = 'u1', extra = {}) => ({
  chatKey: 'qqbot:1:group:2',
  target: { kind: 'group', groupId: '2' },
  sender: { id, name: '甲' },
  messageId: 'm1',
  text: '你好',
  ...extra,
})

test('关系统计：只统计 chat 群消息，保留活跃天数/发言/点名/发图', async () => {
  const env = await setup()
  await env.affection.observe(ev('u1'), 'chat')
  await env.affection.observe(ev('u1', { mentioned: true, media: [{ kind: 'image', url: 'x' }] }), 'chat')
  await env.affection.observe(ev('u2'), 'chat')
  assert.equal(await env.affection.observe(ev('u1'), 'work'), false, 'work 不统计')
  const snap = await env.affection.snapshot()
  assert.equal(snap.enabled, true)
  assert.equal(snap.groups.length, 1)
  const u1 = snap.groups[0].members.find(row => row.userId === 'u1')
  assert.equal(u1.msgs, 2)
  assert.equal(u1.mentions, 1)
  assert.equal(u1.media, 1)
  assert.equal(u1.activeDays, 1)
  assert.ok(u1.f > 0 && u1.f <= 1)
})

test('关系统计：默认关、清除、保留期裁剪', async () => {
  const off = await setup({ enabled: false })
  assert.equal(await off.affection.observe(ev(), 'chat'), false)
  assert.deepEqual(await off.affection.snapshot(), { enabled: false, groups: [] })

  const env = await setup({ retentionDays: 2 })
  await env.affection.observe(ev(), 'chat')
  env.state.now = at(30)
  await env.affection.observe(ev(), 'chat')
  const snap = await env.affection.snapshot()
  const u1 = snap.groups[0].members.find(row => row.userId === 'u1')
  assert.equal(u1.activeDays, 1, '旧日期被裁剪')
  assert.equal(await env.affection.clear('qqbot:1:group:2'), true)
  assert.deepEqual(await env.affection.snapshot(), { enabled: true, groups: [] })
})
