import assert from 'node:assert/strict'
import { test } from 'node:test'

import { APPROVAL_BUTTON_PREFIX, createApprovalRegistry } from '../lib/approval.js'

const build = (options = {}) => createApprovalRegistry({ ttlMs: 60_000, ...options })

test('创建与查询待决审批', () => {
  const registry = build()
  const record = registry.create({ sessionId: 's1', chatKey: 'c1', allowedUserId: 'u1', summary: 'exec rm -rf' })
  assert.match(record.approvalId, /^ap-/)
  assert.equal(record.consumed, false)
  assert.equal(registry.get(record.approvalId).summary, 'exec rm -rf')
  assert.equal(registry.pending({ chatKey: 'c1' }).length, 1)
  assert.equal(registry.pending({ chatKey: 'c2' }).length, 0)
  assert.equal(registry.pending({ chatKey: 'c1', actorId: 'other' }).length, 0, '非允许者看不到')
})

test('按钮数据往返解析', () => {
  const registry = build()
  const record = registry.create({ sessionId: 's1', chatKey: 'c1' })
  const allow = registry.buttonData(record.approvalId, 'allow')
  assert.ok(allow.startsWith(`${APPROVAL_BUTTON_PREFIX}:${record.approvalId}:allow:`))
  const parsed = registry.parseButtonData(allow)
  assert.deepEqual(parsed, { approvalId: record.approvalId, decision: 'allow', nonce: record.nonce })
  assert.equal(registry.parseButtonData('garbage'), null)
  assert.equal(registry.parseButtonData(`${APPROVAL_BUTTON_PREFIX}:x:maybe:n`), null)
})

test('允许一次后即消费；重放被拒', () => {
  const registry = build()
  const record = registry.create({ sessionId: 's1', chatKey: 'c1', allowedUserId: 'u1' })
  const first = registry.decide({
    approvalId: record.approvalId,
    nonce: record.nonce,
    decision: 'allow',
    actorId: 'u1',
    chatKey: 'c1',
    sessionId: 's1',
  })
  assert.equal(first.ok, true)
  assert.equal(first.outcome, 'allowed-once')
  assert.equal(first.record.decision, 'allow')
  const replay = registry.decide({ approvalId: record.approvalId, nonce: record.nonce, decision: 'allow', actorId: 'u1' })
  assert.deepEqual(replay, { ok: false, reason: 'consumed' })
  assert.equal(registry.pending({ chatKey: 'c1' }).length, 0)
})

test('拒绝、nonce 不匹配、跨会话、他人代批都被拦下', () => {
  const registry = build()
  const record = registry.create({ sessionId: 's1', chatKey: 'c1', allowedUserId: 'u1' })
  assert.equal(registry.decide({ approvalId: record.approvalId, nonce: 'wrong', decision: 'allow', actorId: 'u1' }).reason, 'mismatch')
  assert.equal(registry.decide({ approvalId: record.approvalId, decision: 'allow', actorId: 'u1', chatKey: 'c9' }).reason, 'mismatch')
  assert.equal(registry.decide({ approvalId: record.approvalId, decision: 'allow', actorId: 'intruder', chatKey: 'c1' }).reason, 'mismatch')
  assert.equal(registry.decide({ approvalId: record.approvalId, decision: 'maybe' }).reason, 'bad-decision')
  assert.equal(registry.decide({ approvalId: 'ap-nope', decision: 'allow' }).reason, 'unknown')
  const denied = registry.decide({ approvalId: record.approvalId, nonce: record.nonce, decision: 'deny', actorId: 'u1', chatKey: 'c1' })
  assert.equal(denied.outcome, 'rejected')
})

test('过期审批不可用（sweep 清理）', () => {
  let now = 1000
  const registry = createApprovalRegistry({ ttlMs: 100, now: () => now })
  const record = registry.create({ sessionId: 's1', chatKey: 'c1' })
  now = 1200
  assert.equal(registry.decide({ approvalId: record.approvalId, decision: 'allow' }).reason, 'expired')
  const stale = registry.create({ sessionId: 's1', chatKey: 'c1' })
  now = 1400
  assert.equal(registry.sweep(), 1)
  assert.equal(registry.get(stale.approvalId), null)
  assert.equal(registry.size(), 0)
})

test('文本审批仅在单一待决时接受（评审 §7.2）', () => {
  const registry = build()
  const only = registry.create({ sessionId: 's1', chatKey: 'c1', allowedUserId: 'u1' })
  const ok = registry.decideByText({ actorId: 'u1', chatKey: 'c1', sessionId: 's1', decision: 'allow' })
  assert.equal(ok.ok, true)
  assert.equal(ok.record.approvalId, only.approvalId)

  assert.equal(registry.decideByText({ actorId: 'u1', chatKey: 'c1', sessionId: 's1', decision: 'allow' }).reason, 'none')

  // 同一 session 两个待决 → 歧义，必须点按钮
  registry.create({ sessionId: 's1', chatKey: 'c1', allowedUserId: 'u1' })
  registry.create({ sessionId: 's1', chatKey: 'c1', allowedUserId: 'u1' })
  assert.equal(registry.decideByText({ actorId: 'u1', chatKey: 'c1', sessionId: 's1', decision: 'allow' }).reason, 'ambiguous')
  // 其他 session 的单一待决仍可用文本批
  registry.create({ sessionId: 's2', chatKey: 'c1', allowedUserId: 'u1' })
  assert.equal(registry.decideByText({ actorId: 'u1', chatKey: 'c1', sessionId: 's2', decision: 'deny' }).ok, true)
})
