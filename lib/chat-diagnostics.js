/** Bounded in-memory delivery history. Never retain message text, images or model output. */
const LABELS = {
  __proto__: null,
  disabled: '参与判断未启用', off: '参与判断已关闭', quiet: '安静时段',
  'chat-paused': '本群暂停主动互动', 'member-paused': '此成员暂停主动互动',
  'addressed-other': '正在对其他群友说话', 'conversation-ended': '对方结束了话题',
  'continuation-limit': '主动插话次数已达上限', cooldown: '主动插话冷却中',
  'daily-limit': '今日主动插话额度已用完', 'low-score': '未达到主动接话条件',
  'not-mentioned': '未被叫到', unauthorized: '尚未授权', forbidden: '没有权限',
  'over-queue': '消息队列已满', 'no-agent': '模型会话创建失败',
  continuation: '正在续聊', 'reply-self': '对方引用了机器人', alias: '对方在叫昵称',
  question: '发现可参与的问题', length: '消息包含可接话内容', media: '消息带有附件',
  'not-group': '非群聊', 'not-chat': '工作模式', mentioned: '被明确提及',
  log: '仅记录参与判断', participation: '本次未触发接话',
}

export function createChatDiagnostics({ clock = () => Date.now(), limit = 100 } = {}) {
  const entries = new Map()
  let sequence = 0
  function begin(ev) {
    const id = `${clock()}-${++sequence}`
    entries.set(id, { id, chatKey: String(ev?.chatKey ?? ''), at: clock(), updatedAt: clock(), status: 'received', reason: '收到消息', steps: [] })
    while (entries.size > limit) entries.delete(entries.keys().next().value)
    return id
  }
  function note(ev, status, reason) {
    const entry = entries.get(typeof ev === 'string' ? ev : ev?.diagnosticId)
    if (!entry) return
    const ranks = { received: 0, queued: 1, generating: 2, sent: 3, ignored: 3, failed: 3, cancelled: 3 }
    if (!Object.hasOwn(ranks, status) || ranks[status] < ranks[entry.status]) return
    const label = String(LABELS[reason] ?? reason ?? '').slice(0, 160)
    if (entry.status === status && entry.reason === label) return
    entry.updatedAt = clock()
    entry.status = status
    entry.reason = label
    entry.steps.push({ at: entry.updatedAt, status, reason: label })
    if (entry.steps.length > 16) entry.steps.splice(0, entry.steps.length - 16)
  }
  function decision(value, ev) {
    const reason = value?.wake ? value.reasons?.[0] ?? '符合接话条件' : value?.skipped
    if (reason) note(ev, 'received', reason)
  }
  function route(ev, result) {
    if (result.handled === 'message') note(ev, 'queued', '已进入回复队列')
    else if (result.handled === 'ignored') {
      const previous = entries.get(ev.diagnosticId)
      const evaluated = ['participation', 'not-mentioned'].includes(result.reason) && previous?.steps.length
      note(ev, 'ignored', evaluated ? previous.reason : result.reason)
    } else if (result.handled === 'message-rejected' || result.handled === 'rejected') note(ev, 'failed', result.reason || '消息未获准处理')
    else note(ev, result.reply ? 'queued' : 'ignored', result.reply ? '正在处理控制命令' : '控制操作已处理，无需文字回复')
  }
  return { begin, note, decision, route,
    cancel: ev => {
      const entry = entries.get(ev?.diagnosticId)
      if (entry && ['received', 'queued', 'generating'].includes(entry.status)) note(ev, 'cancelled', '已停止或切换会话')
    },
    snapshot: () => ({ recent: [...entries.values()].map(entry => ({ ...entry,
      durationMs: Math.max(0, (['received', 'queued', 'generating'].includes(entry.status) ? clock() : entry.updatedAt) - entry.at),
      steps: entry.steps.map(step => ({ ...step })),
    })) }),
  }
}
