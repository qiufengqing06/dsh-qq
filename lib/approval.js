/**
 * 审批记录与回调校验（执行文档 §5.7，评审 §7 采纳）。
 *
 * 问题：QQ 里同时存在多个待审批请求时，纯文本「approve」无法确定批的是哪一个。
 * 方案：每条审批生成 ApprovalRecord，绑定 approvalId + nonce + 会话 + chat + 允许者，
 * 按钮回调数据携带 approvalId/nonce；校验通过才返回 allowed-once 并置 consumed。
 * 文本 approve/deny 仅在「同一 sender + chat + session 恰好一个 pending」时接受。
 */

import { randomBytes as nodeRandomBytes } from 'node:crypto'

export const APPROVAL_BUTTON_PREFIX = 'qqapproval'
export const APPROVAL_DECISIONS = Object.freeze(['allow', 'deny'])

/**
 * 创建审批注册表。
 * @param {object} [options]
 * @param {number} [options.ttlMs] - 审批有效期。
 * @param {() => number} [options.now]
 * @param {(size: number) => Buffer} [options.randomBytes]
 * @returns {object} registry
 */
export function createApprovalRegistry({ ttlMs = 5 * 60 * 1000, now = () => Date.now(), randomBytes = nodeRandomBytes } = {}) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new TypeError('approval ttlMs must be a positive integer')
  /** @type {Map<string, object>} */
  const records = new Map()

  const token = () => randomBytes(16).toString('hex')

  const isExpired = record => record.expiresAt <= now()

  const registry = {
    ttlMs,

    /**
     * 新建审批记录。
     * @param {object} spec
     * @param {string} spec.sessionId
     * @param {string} spec.chatKey
     * @param {string} [spec.allowedUserId] - 只允许该用户决策（空 = 该 chat 内任意已授权用户）。
     * @param {string} [spec.summary] - 展示给用户的动作摘要（可含命令，不得含密钥）。
     * @param {object} [spec.target] - 结构化 target（用于回发按钮）。
     * @returns {object} 冻结后的记录
     */
    create({ sessionId, chatKey, allowedUserId = '', summary = '', target = null } = {}) {
      const record = Object.freeze({
        approvalId: `ap-${token().slice(0, 12)}`,
        nonce: token(),
        sessionId: String(sessionId ?? ''),
        chatKey: String(chatKey ?? ''),
        allowedUserId: String(allowedUserId ?? ''),
        summary: String(summary ?? ''),
        target,
        createdAt: now(),
        expiresAt: now() + ttlMs,
        consumed: false,
      })
      records.set(record.approvalId, record)
      return record
    },

    get(approvalId) {
      const record = records.get(String(approvalId))
      return record === undefined ? null : { ...record }
    },

    size() {
      return records.size
    },

    /** 该 (chat, session, actor) 下的待决审批（未过期、未消费）。 */
    pending({ chatKey = null, sessionId = null, actorId = null } = {}) {
      const result = []
      for (const record of records.values()) {
        if (record.consumed || isExpired(record)) continue
        if (chatKey !== null && record.chatKey !== chatKey) continue
        if (sessionId !== null && record.sessionId !== sessionId) continue
        if (actorId !== null && record.allowedUserId !== '' && record.allowedUserId !== actorId) continue
        result.push({ ...record })
      }
      return result
    },

    /** 过期清理（插件定时调用，避免 Map 无界增长）。 */
    sweep() {
      let expired = 0
      for (const [id, record] of records) {
        if (record.consumed || isExpired(record)) {
          records.delete(id)
          if (!record.consumed) expired += 1
        }
      }
      return expired
    },

    /** 按钮回调数据：qqapproval:<approvalId>:<allow|deny>:<nonce>。 */
    buttonData(approvalId, decision) {
      const record = records.get(String(approvalId))
      if (record === undefined) throw new TypeError(`unknown approval: ${approvalId}`)
      if (!APPROVAL_DECISIONS.includes(decision)) throw new TypeError(`decision must be allow|deny, got ${decision}`)
      return `${APPROVAL_BUTTON_PREFIX}:${record.approvalId}:${decision}:${record.nonce}`
    },

    /**
     * 解析按钮回调数据。
     * @param {string} data
     * @returns {{approvalId: string, decision: string, nonce: string}|null}
     */
    parseButtonData(data) {
      const parts = String(data ?? '').split(':')
      if (parts.length !== 4 || parts[0] !== APPROVAL_BUTTON_PREFIX) return null
      const [, approvalId, action, nonce] = parts
      if (!APPROVAL_DECISIONS.includes(action)) return null
      return { approvalId, decision: action, nonce }
    },

    /**
     * 校验并消费一条审批。
     * @param {object} spec
     * @param {string} spec.approvalId
     * @param {string} [spec.nonce]
     * @param {'allow'|'deny'} spec.decision
     * @param {string} [spec.actorId]
     * @param {string} [spec.chatKey]
     * @param {string} [spec.sessionId]
     * @returns {{ok: true, outcome: 'allowed-once'|'rejected', record: object}
     *   | {ok: false, reason: 'unknown'|'expired'|'consumed'|'mismatch'|'bad-decision'}}
     */
    decide({ approvalId, nonce = '', decision, actorId = '', chatKey = '', sessionId = '' } = {}) {
      if (!APPROVAL_DECISIONS.includes(decision)) return { ok: false, reason: 'bad-decision' }
      const record = records.get(String(approvalId))
      if (record === undefined) return { ok: false, reason: 'unknown' }
      if (record.consumed) return { ok: false, reason: 'consumed' }
      if (isExpired(record)) {
        records.delete(record.approvalId)
        return { ok: false, reason: 'expired' }
      }
      if (nonce !== '' && nonce !== record.nonce) return { ok: false, reason: 'mismatch' }
      if (record.chatKey !== '' && chatKey !== '' && record.chatKey !== chatKey) return { ok: false, reason: 'mismatch' }
      if (record.sessionId !== '' && sessionId !== '' && record.sessionId !== sessionId) return { ok: false, reason: 'mismatch' }
      if (record.allowedUserId !== '' && actorId !== '' && record.allowedUserId !== actorId) {
        return { ok: false, reason: 'mismatch' }
      }
      const consumed = Object.freeze({ ...record, consumed: true, decision, decidedAt: now(), decidedBy: actorId })
      records.set(record.approvalId, consumed)
      return {
        ok: true,
        outcome: decision === 'allow' ? 'allowed-once' : 'rejected',
        record: consumed,
      }
    },

    /**
     * 文本审批：仅当同一 sender+chat+session 恰好一个 pending 时接受（评审 §7.2）。
     * @param {object} spec
     * @returns {{ok: true, outcome: string, record: object} | {ok: false, reason: 'none'|'ambiguous'|'expired'|'consumed'|'mismatch'|'bad-decision'}}
     */
    decideByText({ actorId, chatKey, sessionId, decision } = {}) {
      const candidates = registry.pending({ chatKey, sessionId, actorId })
      if (candidates.length === 0) return { ok: false, reason: 'none' }
      if (candidates.length > 1) return { ok: false, reason: 'ambiguous' }
      return registry.decide({
        approvalId: candidates[0].approvalId,
        nonce: candidates[0].nonce,
        decision,
        actorId,
        chatKey,
        sessionId,
      })
    },
  }

  return registry
}

export default createApprovalRegistry
