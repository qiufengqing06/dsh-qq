/**
 * Web 控制台验收：路由注册、页面、状态脱敏、配置写入、凭据写入、身份授权、动作按钮、CSRF。
 *
 * 「前端」是自包含 HTML（内联 CSS/JS）；服务端端点：
 *   GET  /dsh-qq                 页面
 *   GET  /dsh-qq/api/state       脱敏状态（含两条线路、身份授权）
 *   POST /dsh-qq/api/config      白名单配置 → configEditor.edit（校验 + 热重载）
 *   POST /dsh-qq/api/credentials 凭据 → credentials seam（只写不回显）
 *   POST /dsh-qq/api/identity    主人绑定 / 批准 / 拒绝 / 移除授权
 *   POST /dsh-qq/api/action      登录（扫码）/ 退出登录 / 重连
 * 所有 POST 必须带 x-dsh-qq-panel: 1（CSRF 防护）。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Readable } from 'node:stream'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveConfig } from '../lib/config.js'
import { createStore } from '../lib/store.js'
import { PAGE_PATH, createWebUi } from '../lib/web-ui.js'
import { createLogger } from './helpers/fake-ctx.js'
import { createConversationState } from '../lib/conversation-state.js'
import { createConversationMemory } from '../lib/conversation-memory.js'
import { createGroupMemory } from '../lib/group-memory.js'

/** 假 webServer：捕获注册的路由，并能给出 origin。 */
function createFakeWebServer(origin = 'http://127.0.0.1:3080') {
  const routes = []
  return {
    routes,
    register(route) {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
    getOrigin() {
      return origin
    },
  }
}

/** 假 configEditor：复刻「change 抛错 → 不落盘」的语义。 */
function createFakeConfigEditor() {
  return {
    saved: undefined,
    calls: 0,
    current: {},
    inherited: {},
    async edit(entry, change) {
      this.calls += 1
      this.entry = entry
      const next = change(this.current ?? {}, this.inherited ?? {})
      this.saved = next // 只有 change 没抛错才会走到这里
      return undefined
    },
  }
}

/** 假 credentials：记录 set/unset，resolve 按 values 返回。 */
function createFakeCredentials(values = {}) {
  const calls = { set: [], unset: [] }
  return {
    calls,
    values,
    async resolve(ref) {
      return this.values[ref] === undefined ? undefined : { value: this.values[ref] }
    },
    async set(ref, value) {
      calls.set.push({ ref, value })
      this.values[ref] = value
    },
    async unset(ref) {
      calls.unset.push({ ref })
      delete this.values[ref]
    },
  }
}

/** 假 control：登录/命令执行。 */
function createFakeControl({ login = { url: 'https://q.qq.com/x/abc' } } = {}) {
  return {
    loginCalls: 0,
    commands: [],
    async beginQrLogin() {
      this.loginCalls += 1
      return login
    },
    async executeWeb(line) {
      this.commands.push(line)
      return { reply: `web:${line}` }
    },
  }
}

/** 假 NapCat 控制器。 */
function createFakeNapcat(overrides = {}) {
  const calls = []
  return {
    calls,
    status: async () =>
      overrides.status ?? {
        enabled: true,
        running: false,
        loggedIn: false,
        onebotListening: false,
        webuiReachable: false,
        qr: { configured: true, available: false, updatedAt: 0, ageMs: null },
        ctlConfigured: true,
        webuiUrl: 'http://127.0.0.1:6099',
      },
    qrImage: async () => overrides.qrBytes ?? null,
    run: async action => {
      calls.push(action)
      return { ok: true, output: 'napcat ' + action + ' done' }
    },
    qrStale: () => false,
    webuiLinksWithToken: async () => overrides.webuiLinks ?? ({ preferred: 'http://localhost:6099/webui?token=fake-token', alternates: [] }),
  }
}

/** 假 ctx：get/inject/fiber。 */
function createCtx(services) {
  const ctx = {
    get: name => services[name],
    fiber: { entry: { id: 'dsh-qq' } },
    inject(names, callback) {
      const sub = { ...ctx }
      for (const name of names) if (services[name] !== undefined) sub[name] = services[name]
      const result = callback(sub)
      return typeof result === 'function' ? result : () => {}
    },
  }
  return ctx
}

function createRes() {
  const captured = { code: 0, headers: {}, body: '' }
  return {
    captured,
    writeHead(code, headers) {
      captured.code = code
      captured.headers = headers ?? {}
      return this
    },
    end(body) {
      captured.body = String(body ?? '')
    },
  }
}

const PANEL = { 'x-dsh-qq-panel': '1' }

function createReq({ method = 'GET', url = PAGE_PATH, body = undefined, headers = {} } = {}) {
  const payload = body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const stream = Readable.from(payload)
  stream.method = method
  stream.url = url
  stream.headers = body === undefined ? { ...headers } : { 'content-type': 'application/json', ...headers }
  return stream
}

async function call(webUi, options) {
  const req = createReq(options)
  const res = createRes()
  await webUi._handler(req, res)
  return { code: res.captured.code, headers: res.captured.headers, body: res.captured.body, json: () => JSON.parse(res.captured.body) }
}

async function setup(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qq-console-'))
  const config = resolveConfig({
    transport: 'onebot',
    autoConnect: false,
    dataDir: dir,
    onebot: { wsUrl: 'ws://127.0.0.1:3001', sendRateLimitMs: 300, accessToken: 'super-secret-token' },
    agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' },
    ...overrides.config,
  })
  const store = createStore({ dir })
  await store.load()
  const webServer = overrides.webServer === null ? null : createFakeWebServer()
  const configEditor = overrides.configEditor === null ? null : createFakeConfigEditor()
  const credentials = overrides.credentials === null ? null : createFakeCredentials(overrides.credentials?.values ?? {})
  const control = overrides.control === null ? null : (overrides.control ?? createFakeControl())
  const llm = overrides.llm ?? {
    listConfigurableProviders: () => [
      { provider: 'deepseek-account', displayName: 'DeepSeek（账号登录）' },
      { provider: 'deepseek-official', displayName: 'DeepSeek 官方 API' },
    ],
    listModels: async provider => (provider === 'deepseek-account'
      ? [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }, { id: 'deepseek-pro', name: 'DeepSeek Pro' }]
      : provider === 'deepseek-official' ? [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] : []),
  }
  const agentDefaultModel = overrides.agentDefaultModel ?? { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) }
  const services = { llm, agentDefaultModel }
  if (overrides.attachments) services.attachments = overrides.attachments
  if (webServer !== null) services.webServer = webServer
  if (configEditor !== null) services.configEditor = configEditor
  if (credentials !== null) services.credentials = credentials
  const ctx = createCtx(services)
  const logger = createLogger()
  const transport = {
    // 机器人资料：页面用它在官方线显示昵称 + 头像（否则退回「官」占位）。
    // 走注册表 entries（生产装配就是这样：每条线路一个 transport 实现）。
    sentTestMessages: [],
    // 与真实注册表一致：forKind 返回 { kind, transport, config }，不是 transport 本身
    forKind: kind => (kind === 'mock' || kind === 'qqbot' || kind === 'onebot'
      ? { kind, transport: { sendText: async (target, text) => { transport.sentTestMessages.push({ target, text }); return { ok: true, messageId: 'tm-1' } } } }
      : null),
    entries: overrides.getProfile === null
      ? []
      : [
          { kind: 'qqbot', transport: { getProfile: overrides.getProfile ?? (async () => ({ id: 'bot-openid-1', name: '小Q', avatar: 'http://thirdqq.qlogo.cn/g?b=oidb&k=test&s=0' })) } },
          { kind: 'onebot', transport: { getProfile: async () => ({ id: '100002', name: '示例机器人', avatar: '' }) } },
        ],
    status: () => ({
      connected: true,
      phase: 'connected',
      accountId: '100002',
      tokenConfigured: true,
      backend: 'napcat',
      backendVersion: '4.18.28',
      endpoint: 'ws://127.0.0.1:3001',
      generation: 2,
      pendingCalls: 0,
      lastError: '',
    }),
  }
  const napcat = overrides.napcat === null ? null : (overrides.napcat ?? createFakeNapcat())
  const alerts = overrides.alerts === null ? null : (overrides.alerts ?? { snapshot: () => ({ enabled: true, notify: true, active: [], events: [], pending: 0 }) })
  const groupMemory = overrides.groupMemory ?? {
    listNotes: async () => [{ file: 'onebot_1_group_90001.md', chars: 12, updatedAt: 1_700_000_000_000 }],
    readNoteFile: async file => (file === 'onebot_1_group_90001.md'
      ? { ok: true, text: '# 群记忆\n- 老板\n', chars: 16 }
      : { ok: false, error: '笔记不存在或读取失败' }),
    writeNoteFile: async (file, text) => {
      groupMemory.writes.push({ file, text })
      return { ok: true, chars: String(text ?? '').length }
    },
    writes: [],
  }
  const memory = overrides.memoryFactory?.({ dir, config, store }) ?? null
  const webUi = createWebUi({ ctx, config, store, transport, control, napcat, alerts, groupMemory, memory, stickers: overrides.stickers, stickerTagger: overrides.stickerTagger, diagnostics: overrides.diagnostics, logger })
  transport.sentTestMessages = []
  return { dir, config, store, webServer, configEditor, credentials, control, napcat, alerts, groupMemory, memory, ctx, logger, transport, webUi }
}

test('注册：作为 webServer 的 prefix 路由挂到 /dsh-qq，url() 给出完整地址', async () => {
  const env = await setup()
  env.webUi.register()
  assert.equal(env.webServer.routes.length, 1)
  assert.deepEqual([env.webServer.routes[0].kind, env.webServer.routes[0].path], ['prefix', '/dsh-qq'])
  assert.equal(env.webUi.url(), 'http://127.0.0.1:3080/dsh-qq')
})

test('降级：没有 webServer 服务时静默跳过（插件照常工作）', async () => {
  const env = await setup({ webServer: null })
  env.webUi.register()
  assert.equal(env.webUi.url(), null)
  assert.equal(env.logger.entries.warn.some(line => line.includes('Web 控制台未注册')), true)
})

test('页面：自包含 HTML（无外部资源），含线路卡/凭据/身份/分组配置容器与 CSRF 头', async () => {
  const env = await setup()
  const page = await call(env.webUi)
  assert.equal(page.code, 200)
  assert.match(page.headers['content-type'], /text\/html/)
  for (const marker of ['dsh-qq 控制台', 'id="chains"', 'id="napcat"', 'id="identity"', 'id="config"', 'x-dsh-qq-panel', 'geist-var.woff2', '最近问题', '人设库', '对话模式', '模式切换暂不可用', 'id="stickers"', '表情包', 'id="chat-control"', '聊天控制', 'id="relations"', '关系']) {
    assert.ok(page.body.includes(marker), `页面应包含 ${marker}`)
  }
  // 页面必须自包含：字体、脚本、样式都由插件自己提供。唯一允许的外部引用是 QQ 头像 CDN
  // （个人号头像，加载失败会退回文字，不阻塞页面）。
  const external = [...page.body.matchAll(/https?:\/\/[^"'\s)]+/g)].map(match => match[0])
  const allowed = external.filter(url => url.startsWith('https://q1.qlogo.cn/'))
  assert.equal(allowed.length, external.length, '除 QQ 头像外不得引用外部资源：' + external.filter(url => !allowed.includes(url)).join(', '))
  assert.equal(/<script[^>]+src=|<link[^>]+rel=["']stylesheet/i.test(page.body), false, '不得外链脚本/样式')
})

test('状态 API：两条线路/身份/字段/脱敏 token', async () => {
  const env = await setup({ credentials: { values: { QQ_APP_ID: '100001', QQ_CLIENT_SECRET: 'sec' } } })
  await env.store.setHomeChannel('EXAMPLE_OPENID', 'qqbot')
  await env.store.setHomeChannel('100004', 'onebot')
  await env.store.addPendingPairing({ userId: 'stranger-1', name: '路人', transportKind: 'onebot' })
  await env.store.recordUsage('qqbot:100001:dm:EXAMPLE_OPENID', { inputTokens: 7, outputTokens: 3 })

  const res = await call(env.webUi, { url: '/dsh-qq/api/state' })
  assert.equal(res.code, 200)
  const state = JSON.parse(res.body).state
  assert.equal(state.version.length > 0, true)
  assert.equal(state.routes.onebot.active, true)
  assert.equal(state.routes.qqbot.active, false)
  assert.equal(state.routes.qqbot.credentials.configured, true)
  assert.equal(state.routes.qqbot.credentials.appId, '100001')
  assert.deepEqual(state.routes.qqbot.profile, { id: 'bot-openid-1', name: '小Q', avatar: 'http://thirdqq.qlogo.cn/g?b=oidb&k=test&s=0' }, '官方线带上机器人昵称/头像')
  assert.deepEqual(state.routes.onebot.profile, { id: '100002', name: '示例机器人', avatar: '' }, '个人线带上昵称')
  assert.equal(state.routes.onebot.credentials.configured, true)
  assert.equal(state.identity.homeChannels.qqbot, 'EXAMPLE_OPENID')
  assert.equal(state.identity.homeChannels.onebot, '100004')
  assert.equal(state.identity.pending.length, 1)
  assert.equal(state.identity.pending[0].transportKind, 'onebot')
  assert.equal(state.fields.some(field => field.path === 'mentionRequired'), true)
  // 模型目录：页面用它渲染 provider/model 下拉（DSH 配了哪些就显示哪些）
  assert.deepEqual(state.models.providers.map(entry => entry.id), ['deepseek-account', 'deepseek-official'])
  assert.deepEqual(state.models.providers[0].models.map(entry => entry.id), ['deepseek-flash', 'deepseek-pro'])
  assert.deepEqual(state.models.globalDefault, { provider: 'deepseek-account', model: 'deepseek-flash' })
  // token 用量报表：页面「Token 消耗」卡片用
  assert.equal(state.usage.totals.today.total, 10)
  assert.equal(state.usage.totals.today.input, 7)
  assert.equal(state.usage.chats.length, 1)
  assert.equal(state.usage.chats[0].turns, 1)
  assert.equal(res.body.includes('super-secret-token'), false, 'token 原文绝不能出现在响应里')
  assert.equal(res.body.includes('"sec"'), false, 'AppSecret 绝不能出现在响应里')
})

test('状态：最近错误诊断字段透传（启动/恢复失败）', async () => {
  const env = await setup()
  let state = JSON.parse((await call(env.webUi, { url: '/dsh-qq/api/state' })).body).state
  assert.deepEqual(state.issues, { lastStartError: null, lastResumeError: null, lastResumeSessionId: null, lastIssueAt: null }, '没有记录时各字段为 null')

  await env.store.setMeta({
    lastStartError: 'qqbot: disconnected: 频率限制',
    lastResumeError: 'resume failed: 会话不存在',
    lastResumeSessionId: 'qq-1234567890',
    lastIssueAt: 1_700_000_000_000,
  })
  state = JSON.parse((await call(env.webUi, { url: '/dsh-qq/api/state' })).body).state
  assert.deepEqual(state.issues, {
    lastStartError: 'qqbot: disconnected: 频率限制',
    lastResumeError: 'resume failed: 会话不存在',
    lastResumeSessionId: 'qq-1234567890',
    lastIssueAt: 1_700_000_000_000,
  })

  // 空串/非法时间戳按「没有」处理，避免页面显示空错误行
  await env.store.setMeta({ lastStartError: '   ', lastIssueAt: Number.NaN })
  state = JSON.parse((await call(env.webUi, { url: '/dsh-qq/api/state' })).body).state
  assert.equal(state.issues.lastStartError, null)
  assert.equal(state.issues.lastIssueAt, null)
})

test('人设库：state 元数据、正文 GET、增删默认绑定接口', async () => {
  const env = await setup()
  const chatKey = 'qqbot:100001:group:90001'
  await env.store.setPersona('tech', { name: '技术顾问', text: '你只聊技术。' })
  await env.store.setPersona('cute', { name: '可爱助手', text: '说话可爱一点。' })
  await env.store.setDefaultPersona('tech')
  await env.store.bindPersona(chatKey, 'cute')

  let state = JSON.parse((await call(env.webUi, { url: '/dsh-qq/api/state' })).body).state
  assert.deepEqual(state.personas.map(item => item.id).sort(), ['cute', 'tech'])
  assert.equal(state.defaultPersonaId, 'tech')
  assert.equal(state.personaModeBindings[chatKey].work.personaId, 'cute')
  assert.deepEqual(state.personaRecent, ['cute', 'tech'])
  assert.equal(state.personas.find(item => item.id === 'tech').chars, '你只聊技术。'.length, 'state 只带元数据，不带正文')

  const one = await call(env.webUi, { url: '/dsh-qq/api/personas?id=tech' })
  assert.equal(one.code, 200)
  assert.equal(JSON.parse(one.body).persona.id, 'tech')
  assert.equal(JSON.parse(one.body).persona.text, '你只聊技术。')
  const missing = await call(env.webUi, { url: '/dsh-qq/api/personas?id=nope' })
  assert.equal(missing.code, 404)

  const saved = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/personas', headers: PANEL, body: { action: 'save', id: '002', name: '问答', text: '回答要短。' } })
  assert.equal(saved.code, 200, saved.body)
  assert.equal(JSON.parse(saved.body).persona.id, '002')
  assert.equal(env.store.personaOf('002').name, '问答')

  // 编辑器仅依赖详情返回的 id，复刻打开已有项→保存→删除的实际契约。
  const detail = await call(env.webUi, { url: '/dsh-qq/api/personas?id=002' })
  const draft = JSON.parse(detail.body).persona
  assert.equal(draft.id, '002')
  const edited = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/personas', headers: PANEL, body: { action: 'save', id: draft.id, name: '更新问答', text: '更新后的临时内容。' } })
  assert.equal(edited.code, 200, edited.body)
  const updatedPersona = JSON.parse(edited.body).persona
  assert.equal(updatedPersona.id, '002')
  assert.equal(env.store.personaOf('002').text, '更新后的临时内容。')

  const badBind = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/personas', headers: PANEL, body: { action: 'bind', chatKey: 'not-a-chat-key', personaId: 'tech' } })
  assert.equal(badBind.code, 400, '非法 chatKey 应返回 400')
  assert.equal(JSON.parse(badBind.body).ok, false)
  assert.match(JSON.parse(badBind.body).error, /chatKey|kind|target/)

  const bound = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/personas', headers: PANEL, body: { action: 'bind', chatKey, personaId: 'tech' } })
  assert.equal(JSON.parse(bound.body).ok, true)
  assert.equal(env.store.personaBinding(chatKey, 'work'), 'tech')

  const unbind = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/personas', headers: PANEL, body: { action: 'unbind', chatKey } })
  assert.equal(JSON.parse(unbind.body).ok, true)
  assert.equal(env.store.personaBinding(chatKey, 'work'), '')

  const def = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/personas', headers: PANEL, body: { action: 'setDefault', id: '002' } })
  assert.equal(JSON.parse(def.body).ok, true)
  assert.equal(env.store.defaultPersonaId(), '002')

  const del = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/personas', headers: PANEL, body: { action: 'delete', id: updatedPersona.id } })
  assert.equal(JSON.parse(del.body).ok, true)
  assert.equal(env.store.personaOf('002'), null)
})

test('对话模式：state 透传 + POST /api/mode 切换与校验', async () => {
  const env = await setup()
  const chatKey = 'qqbot:100001:group:90001'
  await env.store.setMode(chatKey, 'chat')
  let state = JSON.parse((await call(env.webUi, { url: '/dsh-qq/api/state' })).body).state
  assert.equal(state.modes[chatKey], 'chat')

  const toWork = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/mode', headers: PANEL, body: { chatKey, mode: 'work' } })
  assert.equal(toWork.code, 200, toWork.body)
  assert.equal(env.store.modeFor(chatKey), 'work')

  const badMode = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/mode', headers: PANEL, body: { chatKey, mode: 'nope' } })
  assert.equal(badMode.code, 400)
  const badKey = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/mode', headers: PANEL, body: { chatKey: 'bad', mode: 'chat' } })
  assert.equal(badKey.code, 400)
})

test('偏好 API：暂停/恢复/表情开关', async () => {
  const env = await setup()
  const chatKey = 'qqbot:100001:group:90001'
  const pause = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/preferences', headers: PANEL, body: { action: 'pause', chatKey, minutes: 60 } })
  assert.equal(pause.code, 200, pause.body)
  assert.ok(env.store.chatPreference(chatKey).proactiveUntil > Date.now())
  const off = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/preferences', headers: PANEL, body: { action: 'stickers', chatKey, enabled: false } })
  assert.equal(off.code, 200)
  assert.equal(env.store.chatPreference(chatKey).stickers, false)
  const resume = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/preferences', headers: PANEL, body: { action: 'resume', chatKey } })
  assert.equal(resume.code, 200)
  assert.equal(env.store.chatPreference(chatKey).proactiveUntil, 0)
})

test('定时任务：state 列表 + 删除接口', async () => {
  const env = await setup()
  const chatKey = 'qqbot:100001:group:90001'
  await env.store.scheduleAdd({
    id: 's1', chatKey, transportKind: 'qqbot', accountId: '100001',
    target: { kind: 'group', groupId: '90001' }, prompt: '喝水', kind: 'daily', time: '09:00',
    at: null, enabled: true, social: false, createdAt: 1, lastRun: '', lastError: '',
  })
  const state = JSON.parse((await call(env.webUi, { url: '/dsh-qq/api/state' })).body).state
  assert.equal(state.schedules.length, 1)
  assert.equal(state.schedules[0].prompt, '喝水')
  const remove = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/schedules', headers: PANEL, body: { action: 'remove', id: 's1' } })
  assert.equal(remove.code, 200, remove.body)
  assert.equal(env.store.schedules().length, 0)
})

test('配置写入：需要 CSRF 头；白名单 + 保留未提交项；非法值不落盘', async () => {
  const env = await setup()
  env.configEditor.current = { transport: 'onebot', onebot: { wsUrl: 'ws://127.0.0.1:3001' }, mentionRequired: true }

  const blocked = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/config', body: { changes: { mentionRequired: false } } })
  assert.equal(blocked.code, 403, '缺少 CSRF 头必须拒绝')

  const cross = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/config', body: { changes: { mentionRequired: false } }, headers: { ...PANEL, origin: 'http://evil.example' } })
  assert.equal(cross.code, 403, '跨站 Origin 必须拒绝')

  const ok = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/config', body: { changes: { mentionRequired: false, 'groupMemory.bufferMessages': 50 } }, headers: PANEL })
  assert.equal(ok.code, 200, ok.body)
  assert.equal(env.configEditor.saved.mentionRequired, false)
  assert.equal(env.configEditor.saved.groupMemory.bufferMessages, 50)
  assert.equal(env.configEditor.saved.transport, 'onebot', '未提交的既有配置必须保留')

  env.configEditor.saved = undefined
  const bad = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/config', body: { changes: { midTurnDelivery: 'nope' } }, headers: PANEL })
  assert.equal(bad.code, 400)
  assert.match(JSON.parse(bad.body).error, /midTurnDelivery/)
  assert.equal(env.configEditor.saved, undefined, '校验失败不得落盘')

  const unknown = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/config', body: { changes: { 'onebot.accessToken': 'x' } }, headers: PANEL })
  assert.equal(unknown.code, 400, '凭证字段不可经配置接口修改')
})

test('配置写入：线路切换（transport）走同一通道', async () => {
  const env = await setup()
  env.configEditor.current = { transport: 'onebot' }
  const res = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/config', body: { changes: { transport: 'qqbot' } }, headers: PANEL })
  assert.equal(res.code, 200, res.body)
  assert.equal(env.configEditor.saved.transport, 'qqbot')
})

test('凭据写入：官方 AppID/AppSecret 走 credentials seam，且响应不回显', async () => {
  const env = await setup({ credentials: { values: {} } })
  const res = await call(env.webUi, {
    method: 'POST',
    url: '/dsh-qq/api/credentials',
    body: { route: 'qqbot', appId: '100001', appSecret: 'top-secret' },
    headers: PANEL,
  })
  assert.equal(res.code, 200, res.body)
  assert.deepEqual(env.credentials.calls.set, [
    { ref: 'QQ_APP_ID', value: '100001' },
    { ref: 'QQ_CLIENT_SECRET', value: 'top-secret' },
  ])
  assert.equal(res.body.includes('top-secret'), false, 'secret 不得回显')
  assert.deepEqual(env.control.commands, ['/qq-reconnect'], '保存凭据后应重连生效')
})

test('凭据写入：个人线 token；缺字段如实报错；清除走 unset', async () => {
  const env = await setup({ credentials: { values: {} } })
  const missing = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/credentials', body: { route: 'onebot', accessToken: '' }, headers: PANEL })
  assert.equal(missing.code, 400)

  const ok = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/credentials', body: { route: 'onebot', accessToken: 'tok-1' }, headers: PANEL })
  assert.equal(ok.code, 200, ok.body)
  assert.deepEqual(env.credentials.calls.set, [{ ref: 'ONEBOT_ACCESS_TOKEN', value: 'tok-1' }])

  const cleared = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/credentials', body: { route: 'onebot', clear: true }, headers: PANEL })
  assert.equal(cleared.code, 200)
  assert.deepEqual(env.credentials.calls.unset, [{ ref: 'ONEBOT_ACCESS_TOKEN' }])
})

test('身份操作：绑定主人 / 批准 / 拒绝 / 移除授权', async () => {
  const env = await setup()
  await env.store.addPendingPairing({ userId: 'stranger-9', name: '路人', transportKind: 'qqbot' })

  const setHome = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/identity', body: { route: 'qqbot', action: 'setHome', userId: 'openid-owner' }, headers: PANEL })
  assert.equal(setHome.code, 200, setHome.body)
  assert.equal(env.store.roleOf('openid-owner', 'qqbot'), 'owner')
  assert.equal(env.store.roleOf('openid-owner', 'onebot'), 'everyone', '绑定只对来源线生效')

  const approve = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/identity', body: { route: 'qqbot', action: 'approve', userId: 'stranger-9' }, headers: PANEL })
  assert.equal(approve.code, 200)
  assert.equal(env.store.roleOf('stranger-9', 'qqbot'), 'authorized')
  assert.equal(env.store.pendingPairing().length, 0, '批准后待批条目应清除')

  await env.store.addPendingPairing({ userId: 'stranger-10', transportKind: 'onebot' })
  const deny = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/identity', body: { route: 'onebot', action: 'deny', userId: 'stranger-10' }, headers: PANEL })
  assert.equal(deny.code, 200)
  assert.equal(env.store.pendingPairing().length, 0)

  const remove = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/identity', body: { route: 'qqbot', action: 'removeAuthorized', userId: 'stranger-9' }, headers: PANEL })
  assert.equal(remove.code, 200)
  assert.equal(env.store.roleOf('stranger-9', 'qqbot'), 'everyone')
})

test('动作按钮：登录返回扫码链接；退出/重连走 control', async () => {
  const env = await setup()
  const login = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/action', body: { action: 'login' }, headers: PANEL })
  assert.equal(login.code, 200, login.body)
  assert.equal(JSON.parse(login.body).url, 'https://q.qq.com/x/abc')
  assert.equal(env.control.loginCalls, 1)

  const logout = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/action', body: { action: 'logout' }, headers: PANEL })
  assert.equal(logout.code, 200)
  const reconnect = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/action', body: { action: 'reconnect' }, headers: PANEL })
  assert.equal(reconnect.code, 200)
  assert.deepEqual(env.control.commands, ['/qq-logout', '/qq-reconnect'])
})

test('HTTP 边界：错误方法 405 / 未知路径 404 / 坏 JSON 400 / 超大包 400', async () => {
  const env = await setup()
  assert.equal((await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/state', headers: PANEL })).code, 405)
  assert.equal((await call(env.webUi, { url: '/dsh-qq/api/config' })).code, 405)
  assert.equal((await call(env.webUi, { url: '/dsh-qq/nope' })).code, 404)

  const badJson = createReq({ method: 'POST', url: '/dsh-qq/api/config', body: '{not json', headers: PANEL })
  const res = createRes()
  await env.webUi._handler(badJson, res)
  assert.equal(res.captured.code, 400)

  const huge = createReq({ method: 'POST', url: '/dsh-qq/api/config', body: Buffer.alloc(70 * 1024, 0x61), headers: PANEL })
  const hugeRes = createRes()
  await env.webUi._handler(huge, hugeRes)
  assert.equal(hugeRes.captured.code, 400)
})


test('状态与端点：state 带 napcat；二维码 PNG 与字体由插件直接提供', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])
  const env = await setup({ napcat: createFakeNapcat({ qrBytes: png, status: { enabled: true, running: true, loggedIn: false, onebotListening: false, webuiReachable: true, qr: { configured: true, available: true, updatedAt: 1, ageMs: 100 }, ctlConfigured: true, webuiUrl: null } }) })
  const state = await call(env.webUi, { url: '/dsh-qq/api/state' })
  const data = JSON.parse(state.body).state
  assert.equal(data.napcat.running, true)
  assert.equal(data.napcat.loggedIn, false)

  const qr = await call(env.webUi, { url: '/dsh-qq/api/napcat/qr.png' })
  assert.equal(qr.code, 200)
  assert.equal(qr.headers['content-type'], 'image/png')

  const font = await call(env.webUi, { url: '/dsh-qq/fonts/geist-var.woff2' })
  assert.equal(font.code, 200)
  assert.equal(font.headers['content-type'], 'font/woff2')
  assert.equal((await call(env.webUi, { url: '/dsh-qq/fonts/nope.woff2' })).code, 404)
})

test('NapCat 动作：需要 CSRF 头；动作透传给控制器', async () => {
  const env = await setup()
  const blocked = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/napcat/action', body: { action: 'start' } })
  assert.equal(blocked.code, 403)
  const ok = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/napcat/action', body: { action: 'start' }, headers: PANEL })
  assert.equal(ok.code, 200, ok.body)
  assert.deepEqual(env.napcat.calls, ['start'])
  assert.match(JSON.parse(ok.body).message, /napcat start done/)
})

test('无 NapCat 控制器时二维码端点 404、动作如实报错', async () => {
  const env = await setup({ napcat: null })
  assert.equal((await call(env.webUi, { url: '/dsh-qq/api/napcat/qr.png' })).code, 404)
  const action = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/napcat/action', body: { action: 'start' }, headers: PANEL })
  assert.equal(action.code, 400)
  assert.match(JSON.parse(action.body).error, /不可用/)
})

test('配置写入：napcat 只开放 webuiUrl；脚本/二维码路径不可在页面改（M2）', async () => {
  const env = await setup()
  env.configEditor.current = { transport: 'onebot' }
  const res = await call(env.webUi, {
    method: 'POST',
    url: '/dsh-qq/api/config',
    body: { changes: { 'napcat.ctlScript': '/tmp/evil.sh', 'napcat.qrFile': '/tmp/evil.png', 'napcat.webuiUrl': 'http://localhost:6099' } },
    headers: PANEL,
  })
  assert.equal(res.code, 200, res.body)
  assert.equal(env.configEditor.saved.napcat.webuiUrl, 'http://localhost:6099')
  assert.equal(env.configEditor.saved.napcat.ctlScript, undefined, '管理脚本不能从页面写')
  assert.equal(env.configEditor.saved.napcat.qrFile, undefined, '二维码路径不能从页面写')
})

test('WebUI 带 token 链接：POST 端点返回，GET state 不含 token', async () => {
  const env = await setup()
  const state = (await call(env.webUi, { url: '/dsh-qq/api/state' })).json().state
  assert.equal(JSON.stringify(state).includes('fake-token'), false, 'state 不得回显 token')
  const noHeader = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/napcat/webui-url', body: {} })
  assert.equal(noHeader.code, 403, '写操作仍需 CSRF 头')
  const res = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/napcat/webui-url', headers: PANEL, body: {} })
  assert.equal(res.code, 200, res.body)
  assert.equal(JSON.parse(res.body).preferred, 'http://localhost:6099/webui?token=fake-token')
})

test('配置写入：身份与权限字段（pairingPolicy / controlPolicy）可保存', async () => {
  const env = await setup()
  env.configEditor.current = { transport: 'onebot' }
  const res = await call(env.webUi, {
    method: 'POST',
    url: '/dsh-qq/api/config',
    headers: PANEL,
    body: { changes: { pairingPolicy: 'allowlist', 'controlPolicy.chat': 'authorized', 'controlPolicy.approvals': 'admin' } },
  })
  assert.equal(res.code, 200, res.body)
  assert.equal(env.configEditor.saved.pairingPolicy, 'allowlist')
  assert.equal(env.configEditor.saved.controlPolicy.chat, 'authorized')
  assert.equal(env.configEditor.saved.controlPolicy.approvals, 'admin')
})

test('页面内联脚本必须能解析（历史上一次换行转义写坏，导致整页空白）', async () => {
  const env = await setup()
  const page = await call(env.webUi)
  const scripts = [...page.body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1])
  assert.ok(scripts.length > 0, '页面应包含内联脚本')
  for (const script of scripts) {
    // new Function 只编译不执行：语法错误会在这里抛出
    assert.doesNotThrow(() => new Function(script), '内联脚本必须能解析')
  }
})

test('配置写入：transports 数组可写（多线路启用/停用），非法值被 resolveConfig 拦下', async () => {
  const env = await setup()
  env.configEditor.current = { transport: 'qqbot' }
  const ok = await call(env.webUi, {
    method: 'POST',
    url: '/dsh-qq/api/config',
    body: { changes: { transports: [{ kind: 'qqbot' }, { kind: 'onebot' }] } },
    headers: PANEL,
  })
  assert.equal(ok.code, 200, ok.body)
  assert.deepEqual(env.configEditor.saved.transports, [{ kind: 'qqbot' }, { kind: 'onebot' }])

  env.configEditor.saved = undefined
  const bad = await call(env.webUi, {
    method: 'POST',
    url: '/dsh-qq/api/config',
    body: { changes: { transports: [{ kind: 'qqbot' }, { kind: 'qqbot' }] } },
    headers: PANEL,
  })
  assert.equal(bad.code, 400)
  assert.match(JSON.parse(bad.body).error, /重复线路/)
  assert.equal(env.configEditor.saved, undefined, '校验失败不得落盘')
})


test('状态 API：透传告警快照（页面告警条与事件列表用）', async () => {
  const snapshot = {
    enabled: true,
    notify: true,
    active: [{ kind: 'onebot', label: '个人线', since: 1_000_000, phase: 'disconnected', lastError: 'ws closed' }],
    events: [{ at: 1_000_000, type: 'down', text: '⚠️ dsh-qq：个人线掉线（disconnected）' }],
    pending: 0,
  }
  const env = await setup({ alerts: { snapshot: () => snapshot } })
  const res = await call(env.webUi, { url: '/dsh-qq/api/state' })
  const data = JSON.parse(res.body).state
  assert.equal(data.alerts.active.length, 1)
  assert.equal(data.alerts.active[0].kind, 'onebot')
  assert.equal(data.alerts.events.length, 1)
  assert.equal(data.config.alerts.enabled, true, '配置里也要能看到提醒开关的状态')
})


test('模型目录：保存时校验 provider/model，非法值不落盘', async () => {
  const env = await setup()
  const badProvider = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/config', headers: PANEL, body: { changes: { 'agentOptions.provider': 'no-such-provider' } } })
  assert.equal(badProvider.code, 400)
  assert.match(badProvider.json().error, /未知的 provider/)
  const badModel = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/config', headers: PANEL, body: { changes: { 'agentOptions.provider': 'deepseek-official', 'agentOptions.model': 'deepseek-flash' } } })
  assert.equal(badModel.code, 400, '模型不属于该 provider 时应拒绝')
  const ok = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/config', headers: PANEL, body: { changes: { 'agentOptions.provider': 'deepseek-official', 'agentOptions.model': 'deepseek-chat' } } })
  assert.equal(ok.code, 200)
  assert.deepEqual(env.configEditor.saved.agentOptions, { provider: 'deepseek-official', model: 'deepseek-chat' })
})

test('模型目录：没有 llm 服务时退回纯文本，不拦配置', async () => {
  const env = await setup({ llm: { listConfigurableProviders: () => [], listProviders: () => [], listModels: async () => [] }, agentDefaultModel: { currentSelection: () => null } })
  const state = (await call(env.webUi, { url: '/dsh-qq/api/state' })).json().state
  assert.deepEqual(state.models, { providers: [], globalDefault: null })
  const ok = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/config', headers: PANEL, body: { changes: { 'agentOptions.provider': 'whatever', 'agentOptions.model': 'x' } } })
  assert.equal(ok.code, 200, '目录不可用时不做 provider/model 校验')
})

// ── 群记忆编辑 ──

test('群记忆：state 带笔记列表；GET 正文 / POST 保存走群记忆模块', async () => {
  const env = await setup()
  const state = (await call(env.webUi, { url: '/dsh-qq/api/state' })).json().state
  assert.deepEqual(state.groups, [{ file: 'onebot_1_group_90001.md', chars: 12, updatedAt: 1_700_000_000_000 }])

  const read = await call(env.webUi, { url: '/dsh-qq/api/groups/note?file=onebot_1_group_90001.md' })
  assert.equal(read.code, 200)
  assert.match(JSON.parse(read.body).text, /老板/)

  const traversal = await call(env.webUi, { url: '/dsh-qq/api/groups/note?file=../../etc/passwd' })
  assert.equal(traversal.code, 400, '路径穿越必须拒绝')

  const write = await call(env.webUi, {
    method: 'POST',
    url: '/dsh-qq/api/groups/note',
    headers: PANEL,
    body: { file: 'onebot_1_group_90001.md', text: '# 新内容\n' },
  })
  assert.equal(write.code, 200, write.body)
  assert.deepEqual(env.groupMemory.writes, [{ file: 'onebot_1_group_90001.md', text: '# 新内容\n' }])
})

// ── 测试消息 ──

test('测试消息：按线路发送，校验空文本/目标', async () => {
  const env = await setup()
  const ok = await call(env.webUi, {
    method: 'POST',
    url: '/dsh-qq/api/test-message',
    headers: PANEL,
    body: { kind: 'mock', targetKind: 'dm', targetId: '70007', text: 'ping' },
  })
  assert.equal(ok.code, 200, ok.body)
  assert.equal(JSON.parse(ok.body).ok, true)
  assert.equal(JSON.parse(ok.body).messageId, 'tm-1')
  assert.deepEqual(env.transport.sentTestMessages, [{ target: { kind: 'dm', userId: '70007' }, text: 'ping' }])

  const empty = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/test-message', headers: PANEL, body: { kind: 'mock', targetKind: 'dm', targetId: '1', text: '  ' } })
  assert.equal(JSON.parse(empty.body).ok, false)
  const badTarget = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/test-message', headers: PANEL, body: { kind: 'mock', targetKind: 'dm', targetId: '', text: 'x' } })
  assert.equal(JSON.parse(badTarget.body).ok, false)
  const unknownLine = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/test-message', headers: PANEL, body: { kind: 'nope', targetKind: 'dm', targetId: '1', text: 'x' } })
  assert.equal(JSON.parse(unknownLine.body).ok, false)
})

test('状态：pricing 与最近审批透传', async () => {
  const env = await setup()
  await env.store.recordApproval({ decision: 'deny', summary: 'rm -rf /', actorId: 'owner', chatKey: 'mock:1:dm:u' })
  const state = (await call(env.webUi, { url: '/dsh-qq/api/state' })).json().state
  assert.equal(state.approvals.length, 1)
  assert.equal(state.approvals[0].decision, 'deny')
  assert.deepEqual(state.config.pricing, { inputPerMillion: 0, outputPerMillion: 0 })
})

test('会话提示词：state 透传 + POST 保存默认/按对话 + 校验', async () => {
  const env = await setup()
  await env.store.setDefaultPrompt('默认人设')

  const state = (await call(env.webUi, { url: '/dsh-qq/api/state' })).json().state
  assert.equal(state.prompt.default, '默认人设')
  assert.equal(state.promptLimit, 4000)
  assert.ok(Array.isArray(state.chatKeys))

  const chat = await call(env.webUi, {
    method: 'POST',
    url: '/dsh-qq/api/prompts',
    headers: PANEL,
    body: { chatKey: 'qqbot:100001:dm:OPENID', text: '这个人是管理员' },
  })
  assert.equal(chat.code, 200, chat.body)
  assert.equal(env.store.promptFor('qqbot:100001:dm:OPENID'), '这个人是管理员')

  const def = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/prompts', headers: PANEL, body: { chatKey: '', text: '新默认' } })
  assert.equal(def.code, 200)
  assert.equal(env.store.defaultPrompt(), '新默认')

  const badKey = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/prompts', headers: PANEL, body: { chatKey: 'not-a-chat-key', text: 'x' } })
  assert.equal(JSON.parse(badKey.body).ok, false, '非法 chatKey 必须拒绝')
  const tooLong = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/prompts', headers: PANEL, body: { chatKey: '', text: 'x'.repeat(4001) } })
  assert.equal(JSON.parse(tooLong.body).ok, false, '超长必须拒绝')
  const noHeader = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/prompts', body: { text: 'x' } })
  assert.equal(noHeader.code, 403, '写操作需要 CSRF 头')
})

test('人设精选与试聊API：保存校验、历史ID保留、CSRF、草稿隔离', async () => {
  const id = 'a'.repeat(64)
  const oldId = 'b'.repeat(64)
  const missing = 'c'.repeat(64)
  const env = await setup({ stickers: {
    listAll: () => [{ id, state: 'library', tags: ['得意'], desc: '得意鱼' }],
    itemOf: key => key === id ? { id, state: 'library', tags: [], desc: '得意鱼' } : null,
  }, llm: { async *stream() { yield { type: 'text-delta', text: '一条鱼成交' }; yield { type: 'finish', reason: { kind: 'stop' } } } } })
  await env.store.setPersona('fish', { text: '已保存', stickerIds: [oldId] })
  const post = (url, body, headers = PANEL) => call(env.webUi, { method: 'POST', url: `/dsh-qq/api/${url}`, body, headers })
  assert.equal((await post('personas', { action: 'save', id: 'fish', text: '更新', stickerIds: [id, oldId] })).code, 200)
  assert.equal((await post('personas', { action: 'save', id: 'fish', text: '更新', stickerIds: [missing] })).code, 400)
  assert.deepEqual(env.store.personaOf('fish').stickerIds, [id, oldId])
  const picker = (await call(env.webUi, { url: `/dsh-qq/api/persona-stickers?ids=${oldId}` })).json()
  assert.equal(picker.items.find(item => item.id === oldId).missing, true)
  assert.equal((await post('persona-preview', { message: 'hi' }, {})).code, 403)
  const before = env.store.snapshot()
  const response = await post('persona-preview', { draft: { text: '未保存的鱼', stickerIds: [id] }, message: '摸头多少钱' })
  assert.equal(response.code, 200, response.body)
  assert.equal(response.json().reply, '一条鱼成交')
  assert.equal(response.json().effective.text, '未保存的鱼')
  assert.deepEqual(env.store.snapshot(), before)
  assert.equal(env.transport.sentTestMessages.length, 0)
})

test('表情包分页API：完整分类计数、越界回退及参数校验', async () => {
  let args
  const env = await setup({ stickers: {
    stats: () => ({ total: 131, candidates: 125, library: 6, trash: 0 }),
    listAll: (limit, options) => { args = { limit, ...options }; return [] },
  } })
  const get = query => call(env.webUi, { url: '/dsh-qq/api/stickers?' + query })
  let result = await get('filter=candidate&page=10&pageSize=12')
  assert.equal(result.code, 200)
  assert.equal(result.json().total, 125)
  assert.deepEqual(args, { limit: 12, state: 'candidate', offset: 120, missingDescription: false })
  result = await get('filter=library&page=10&pageSize=12')
  assert.equal(result.json().page, 0)
  assert.equal(result.json().total, 6)
  result = await get('filter=trash&page=10&pageSize=4')
  assert.equal(result.json().page, 0)
  assert.equal(result.json().total, 0)
  for (const query of ['filter=bad', 'page=-1', 'page=1.1', 'pageSize=0', 'pageSize=101', 'pageSize=no']) {
    assert.equal((await get(query)).code, 400, query)
  }
})

test('昵称与群档位API：保存、继承、覆盖、读取及非法输入保持旧值', async () => {
  const env = await setup()
  const post = (path, body) => call(env.webUi, { method: 'POST', url: '/dsh-qq/api/' + path, headers: PANEL, body })
  const chatKey = 'qqbot:example:group:test'
  assert.equal((await post('personas', { action: 'save', id: 'fish', text: '群友', aliases: ['鱼鱼'], activity: 'active' })).code, 200)
  await env.store.bindPersona(chatKey, 'fish', 'chat')
  assert.equal((await post('preferences', { action: 'activity', chatKey, activity: 'quiet' })).code, 200)
  const state = (await call(env.webUi, { url: '/dsh-qq/api/state' })).json().state
  assert.deepEqual(state.behaviors[chatKey], { aliases: ['鱼鱼'], activity: 'quiet', source: 'chat' })
  assert.equal((await post('preferences', { action: 'activity', chatKey, activity: 'invalid' })).code, 400)
  assert.equal(env.store.chatPreference(chatKey).activity, 'quiet')
  assert.equal((await post('personas', { action: 'save', id: 'fish', text: '更新', aliases: ['x'] })).code, 400)
  assert.deepEqual(env.store.personaOf('fish').aliases, ['鱼鱼'])
  assert.equal((await post('personas', { action: 'save', id: 'fish', text: '只改正文' })).code, 200)
  assert.deepEqual(env.store.personaOf('fish').aliases, ['鱼鱼'])
  assert.equal((await post('preferences', { action: 'activity', chatKey, activity: 'inherit' })).code, 200)
  assert.equal(env.store.effectiveBehaviorFor(chatKey, 'chat').activity, 'active')
})

test('图库描述API：缺描述分页、编辑校验、识别入队立即返回并展示进度', async () => {
  const id = 'a'.repeat(64)
  const edits = [], jobs = []
  let finish
  const pending = new Promise(resolve => { finish = resolve })
  const env = await setup({ stickers: {
    stats: () => ({ total: 100, library: 100 }),
    countAll: options => options.missingDescription ? 3 : 100,
    listAll: (_limit, options) => options?.missingDescription ? [{ id, state: 'library', desc: '', tags: ['开心'] }] : [],
    itemOf: key => key === id ? { id, state: 'library' } : null,
    setMeta: async (key, patch) => { edits.push({ key, patch }); return true },
  }, stickerTagger: {
    enabled: true, tag: key => { jobs.push(key); return pending },
    tagPending: () => { jobs.push('missing'); return pending },
    snapshot: () => ({ running: true, pending: 1, completed: 0, failed: 0, lastError: '' }),
  } })
  const post = body => call(env.webUi, { method: 'POST', url: '/dsh-qq/api/stickers', headers: PANEL, body })
  try {
    const page = (await call(env.webUi, { url: '/dsh-qq/api/stickers?filter=library&missingDescription=1&page=20&pageSize=4' })).json()
    assert.equal(page.page, 0)
    assert.equal(page.total, 3)
    assert.equal(page.items[0].id, id)
    assert.equal((await call(env.webUi, { url: '/dsh-qq/api/stickers?missingDescription=bad' })).code, 400)
    assert.equal((await post({ action: 'tag', id, desc: '玩偶托腮，配字“何意味”' })).code, 200)
    assert.equal(edits.length, 1)
    assert.equal((await post({ action: 'tag', id, desc: '长'.repeat(301) })).code, 400)
    assert.equal((await post({ action: 'tag', id, tags: [42] })).code, 400)
    assert.equal((await post({ action: 'retag', id })).json().queued, true)
    assert.equal((await post({ action: 'retag', id: 'missing' })).code, 400)
    assert.equal((await post({ action: 'tagPending' })).json().queued, true)
    assert.deepEqual(jobs, [id, 'missing'])
    const state = (await call(env.webUi, { url: '/dsh-qq/api/state' })).json().state
    assert.equal(state.stickers.tagging.pending, 1)
  } finally { finish({ tagged: 1, tried: 1 }) }
})

test('图文预演API：超过旧64KB的图片可入站，无真实发送且仍需CSRF', async () => {
  const saved = [], calls = []
  const env = await setup({
    attachments: { saveImage: async value => { saved.push(value); return { attachmentId: 'preview-image', mediaType: value.mediaType } } },
    llm: { async *stream(request) { calls.push(request); yield { type: 'text-delta', text: '{"actions":[{"type":"text","text":"行，当我没说"}]}' }; yield { type: 'finish', reason: { kind: 'stop' } } } },
    diagnostics: { snapshot: () => ({ recent: [{ id: 'trace', chatKey: 'qqbot:a:group:g', status: 'ignored', reason: '安静时段', steps: [] }] }) },
  })
  const data = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(70000)])
  const body = { draft: { text: '做个群友' }, previewActions: true, message: '', image: { data: data.toString('base64'), mime: 'image/png' } }
  const request = headers => call(env.webUi, { method: 'POST', url: '/dsh-qq/api/persona-preview', headers, body })
  assert.equal((await request({})).code, 403)
  const result = await request(PANEL)
  assert.equal(result.code, 200, result.body)
  assert.equal(result.json().actions[0].text, '行，当我没说')
  assert.equal(saved[0].data.length, data.length)
  assert.equal(calls.length, 1)
  assert.equal(env.transport.sentTestMessages.length, 0)
  const state = (await call(env.webUi, { url: '/dsh-qq/api/state' })).json().state
  assert.equal(state.diagnostics.recent[0].reason, '安静时段')
})

test('对话记忆API：真实存储、分页过滤、严格开关、冲突与写入保护', async t => {
  const env = await setup({ memoryFactory: ({ dir, config, store }) => createConversationMemory({
    state: createConversationState({ dir }), store, config, groupMemory: createGroupMemory({ dir, config }),
  }) })
  t.after(() => env.memory.dispose())
  const chatKey = 'onebot:100:group:memory'
  await env.store.setMode(chatKey, 'chat')
  await env.store.setPersona('fish', { text: '基础鱼人设' })
  await env.store.bindPersona(chatKey, 'fish', 'chat')
  const get = extra => call(env.webUi, { url: `${PAGE_PATH}/api/memory?${new URLSearchParams({ chatKey, mode: 'chat', ...extra })}` })
  const post = (path, body, headers = PANEL) => call(env.webUi, { method: 'POST', url: `${PAGE_PATH}/api/${path}`, headers, body: { chatKey, mode: 'chat', ...body } })
  let view = (await get()).json()
  const forbidden = await post('memory', { action: 'create', text: '不该写入', expectedRevision: view.revision }, {})
  assert.equal(forbidden.code, 403)
  const result = await post('memory', { action: 'create', kind: 'preference', key: 'food', subjectId: 'a', text: '不吃香菜', expectedRevision: view.revision })
  assert.equal(result.code, 200, result.body)
  const id = result.json().recordId
  const stale = await post('memory', { action: 'correct', id, text: '错误覆盖', expectedRevision: view.revision })
  assert.equal(stale.code, 409)
  view = (await get({ kind: 'preference', memberId: 'a', query: '香菜' })).json()
  assert.equal(view.total, 1)
  assert.equal((await get({ memberId: 'b' })).json().total, 0)
  assert.equal((await post('growth', { action: 'settings', learningEnabled: 'false', expectedRevision: view.revision })).code, 400)
  assert.equal((await post('growth', { action: 'settings', learningEnabled: true, expectedRevision: view.revision })).code, 200)
  view = (await get()).json()
  const snapshot = await post('persona-preview', { memorySnapshot: { chatKey, mode: 'chat', personaId: 'fish' } })
  assert.equal(snapshot.code, 200, snapshot.body)
  assert.equal(snapshot.json().memorySnapshot.readOnly, true)
  assert.equal((await get()).json().revision, view.revision)
  const state = (await call(env.webUi, { url: `${PAGE_PATH}/api/state` })).json().state
  assert.equal(state.memory.available, true)
  assert.doesNotMatch(JSON.stringify(state.memory), /不吃香菜/)
  const exported = await post('memory', { action: 'export', expectedRevision: view.revision })
  assert.equal(exported.code, 200, exported.body)
  assert.match(exported.json().text, /不吃香菜/)
  view = (await get()).json()
  assert.equal((await post('memory', { action: 'forget', id, expectedRevision: view.revision })).code, 200)
  assert.equal((await get()).json().total, 0)
  const emptyExport = await post('memory', { action: 'export', expectedRevision: (await get()).json().revision })
  assert.equal(emptyExport.code, 200, emptyExport.body)
  assert.doesNotMatch(emptyExport.json().text, /不吃香菜/)
  assert.equal(env.transport.sentTestMessages.length, 0)
})
