/**
 * Web 控制台验收（公开仓库：只覆盖官方 QQBot 线路）：
 * 路由注册、页面自包含、状态脱敏、配置写入、凭据写入、身份授权、动作按钮、CSRF、告警快照。
 *
 * 服务端端点：
 *   GET  /dsh-qq                 页面
 *   GET  /dsh-qq/api/state       脱敏状态（线路 / 身份 / 字段 / 活动 / 告警）
 *   POST /dsh-qq/api/config      白名单配置 → configEditor.edit（校验 + 热重载）
 *   POST /dsh-qq/api/credentials AppID/AppSecret → credentials seam（只写不回显）
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

/** 假 credentials seam。 */
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
    transport: 'qqbot',
    accountId: '1905346673',
    autoConnect: false,
    dataDir: dir,
    agentOptions: { provider: 'deepseek-account', model: 'deepseek-flash' },
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
  if (webServer !== null) services.webServer = webServer
  if (configEditor !== null) services.configEditor = configEditor
  if (credentials !== null) services.credentials = credentials
  const ctx = createCtx(services)
  const logger = createLogger()
  const transport = {
    // 机器人资料：官方线用它在页面显示昵称 + 头像（走注册表 entries，与生产装配一致）
    sentTestMessages: [],
    // 与真实注册表一致：forKind 返回 { kind, transport, config }，不是 transport 本身
    forKind: kind => (kind === 'mock' || kind === 'qqbot'
      ? { kind, transport: { sendText: async (target, text) => { transport.sentTestMessages.push({ target, text }); return { ok: true, messageId: 'tm-1' } } } }
      : null),
    entries: overrides.getProfile === null
      ? []
      : [{ kind: 'qqbot', transport: { getProfile: overrides.getProfile ?? (async () => ({ id: 'bot-openid-1', name: '小Q', avatar: 'http://thirdqq.qlogo.cn/g?b=oidb&k=test&s=0' })) } }],
    status: () => ({
      connected: true,
      phase: 'connected',
      accountId: '1905346673',
      tokenConfigured: true,
      backend: 'qqbot',
      backendVersion: '0.2.1',
      generation: 2,
      pendingCalls: 0,
      lastError: '',
    }),
  }
  const alerts = overrides.alerts === null ? null : (overrides.alerts ?? { snapshot: () => ({ enabled: true, notify: true, active: [], events: [], pending: 0 }) })
  const groupMemory = overrides.groupMemory ?? {
    listNotes: async () => [{ file: 'qqbot_1_group_90001.md', chars: 12, updatedAt: 1_700_000_000_000 }],
    readNoteFile: async file => (file === 'qqbot_1_group_90001.md'
      ? { ok: true, text: '# 群记忆\n- 老板\n', chars: 16 }
      : { ok: false, error: '笔记不存在或读取失败' }),
    writeNoteFile: async (file, text) => {
      groupMemory.writes.push({ file, text })
      return { ok: true, chars: String(text ?? '').length }
    },
    writes: [],
  }
  const webUi = createWebUi({ ctx, config, store, transport, control, alerts, groupMemory, logger })
  transport.sentTestMessages = []
  return { dir, config, store, webServer, configEditor, credentials, control, alerts, groupMemory, ctx, logger, transport, webUi }
}

test('注册：作为 webServer 的 prefix 路由挂到 /dsh-qq，url() 给出完整地址', async () => {
  const env = await setup()
  env.webUi.register()
  assert.equal(env.webServer.routes.length, 1)
  assert.equal(env.webServer.routes[0].path, PAGE_PATH)
  assert.equal(env.webServer.routes[0].kind, 'prefix')
  assert.equal(env.webUi.url(), `http://127.0.0.1:3080${PAGE_PATH}`)
})

test('降级：没有 webServer 服务时静默跳过（插件照常工作）', async () => {
  const env = await setup({ webServer: null })
  env.webUi.register()
  assert.equal(env.webUi.url(), null)
  const res = await call(env.webUi, { url: `${PAGE_PATH}/api/state` })
  assert.equal(res.code, 200, '没有 webServer 时状态仍能算出来')
})

test('页面：自包含 HTML（无外部资源），含线路/凭据/身份/配置容器与 CSRF 头', async () => {
  const env = await setup()
  const res = await call(env.webUi, { url: PAGE_PATH })
  assert.equal(res.code, 200)
  assert.match(res.headers['content-type'], /text\/html/)
  for (const marker of ['dsh-qq 控制台', 'id="chains"', 'id="identity"', 'id="config"', 'x-dsh-qq-panel', 'geist-var.woff2', '最近问题', '人设库', '对话模式', '模式切换暂不可用']) {
    assert.ok(res.body.includes(marker), `页面应包含 ${marker}`)
  }
  // 页面必须自包含：除本机地址外不得有外部 URL，也不得外链脚本/样式
  const external = [...res.body.matchAll(/https?:\/\/[^"'\s)]+/g)].map(match => match[0]).filter(url => !url.startsWith('http://127.0.0.1'))
  assert.deepEqual(external, [], '不得引用外部资源')
  assert.equal(/<script[^>]+src=|<link[^>]+rel=["']stylesheet/i.test(res.body), false, '不得外链脚本/样式')
})

test('状态：最近错误诊断字段透传（启动/恢复失败）', async () => {
  const env = await setup()
  let state = (await call(env.webUi, { url: `${PAGE_PATH}/api/state` })).json().state
  assert.deepEqual(state.issues, { lastStartError: null, lastResumeError: null, lastResumeSessionId: null, lastIssueAt: null }, '没有记录时各字段为 null')

  await env.store.setMeta({
    lastStartError: 'qqbot: disconnected: 频率限制',
    lastResumeError: 'resume failed: 会话不存在',
    lastResumeSessionId: 'qq-1234567890',
    lastIssueAt: 1_700_000_000_000,
  })
  state = (await call(env.webUi, { url: `${PAGE_PATH}/api/state` })).json().state
  assert.deepEqual(state.issues, {
    lastStartError: 'qqbot: disconnected: 频率限制',
    lastResumeError: 'resume failed: 会话不存在',
    lastResumeSessionId: 'qq-1234567890',
    lastIssueAt: 1_700_000_000_000,
  })

  // 空串/非法时间戳按「没有」处理，避免页面显示空错误行
  await env.store.setMeta({ lastStartError: '   ', lastIssueAt: Number.NaN })
  state = (await call(env.webUi, { url: `${PAGE_PATH}/api/state` })).json().state
  assert.equal(state.issues.lastStartError, null)
  assert.equal(state.issues.lastIssueAt, null)
})

test('人设库：state 元数据、正文 GET、增删默认绑定接口', async () => {
  const env = await setup()
  const chatKey = 'qqbot:1905346673:group:90001'
  await env.store.setPersona('tech', { name: '技术顾问', text: '你只聊技术。' })
  await env.store.setPersona('cute', { name: '可爱助手', text: '说话可爱一点。' })
  await env.store.setDefaultPersona('tech')
  await env.store.bindPersona(chatKey, 'cute')

  const state = (await call(env.webUi, { url: `${PAGE_PATH}/api/state` })).json().state
  assert.deepEqual(state.personas.map(item => item.id).sort(), ['cute', 'tech'])
  assert.equal(state.defaultPersonaId, 'tech')
  assert.equal(state.personaModeBindings[chatKey].work.personaId, 'cute')
  assert.equal(state.personas.find(item => item.id === 'tech').chars, '你只聊技术。'.length, 'state 只带元数据，不带正文')

  const one = await call(env.webUi, { url: `${PAGE_PATH}/api/personas?id=tech` })
  assert.equal(one.code, 200)
  assert.equal(one.json().persona.text, '你只聊技术。')
  assert.equal((await call(env.webUi, { url: `${PAGE_PATH}/api/personas?id=nope` })).code, 404)

  const saved = await call(env.webUi, { method: 'POST', url: `${PAGE_PATH}/api/personas`, headers: PANEL, body: { action: 'save', id: 'qa', name: '问答', text: '回答要短。' } })
  assert.equal(saved.code, 200, saved.body)
  assert.equal(env.store.personaOf('qa').name, '问答')

  const badBind = await call(env.webUi, { method: 'POST', url: `${PAGE_PATH}/api/personas`, headers: PANEL, body: { action: 'bind', chatKey: 'not-a-chat-key', personaId: 'tech' } })
  assert.equal(badBind.code, 400, '非法 chatKey 应返回 400')


  const bound = await call(env.webUi, { method: 'POST', url: `${PAGE_PATH}/api/personas`, headers: PANEL, body: { action: 'bind', chatKey, personaId: 'tech' } })
  assert.equal(bound.json().ok, true)
  assert.equal(env.store.personaBinding(chatKey, 'work'), 'tech')

  const unbind = await call(env.webUi, { method: 'POST', url: `${PAGE_PATH}/api/personas`, headers: PANEL, body: { action: 'unbind', chatKey } })
  assert.equal(unbind.json().ok, true)
  assert.equal(env.store.personaBinding(chatKey, 'work'), '')


  const def = await call(env.webUi, { method: 'POST', url: `${PAGE_PATH}/api/personas`, headers: PANEL, body: { action: 'setDefault', id: 'qa' } })
  assert.equal(def.json().ok, true)
  assert.equal(env.store.defaultPersonaId(), 'qa')

  const del = await call(env.webUi, { method: 'POST', url: `${PAGE_PATH}/api/personas`, headers: PANEL, body: { action: 'delete', id: 'qa' } })
  assert.equal(del.json().ok, true)
  assert.equal(env.store.personaOf('qa'), null)
})

test('对话模式：state 透传 + POST /api/mode 切换与校验', async () => {
  const env = await setup()
  const chatKey = 'qqbot:1905346673:group:90001'
  await env.store.setMode(chatKey, 'chat')
  const state = (await call(env.webUi, { url: `${PAGE_PATH}/api/state` })).json().state
  assert.equal(state.modes[chatKey], 'chat')

  const toWork = await call(env.webUi, { method: 'POST', url: `${PAGE_PATH}/api/mode`, headers: PANEL, body: { chatKey, mode: 'work' } })
  assert.equal(toWork.code, 200, toWork.body)
  assert.equal(env.store.modeFor(chatKey), 'work')

  const badMode = await call(env.webUi, { method: 'POST', url: `${PAGE_PATH}/api/mode`, headers: PANEL, body: { chatKey, mode: 'nope' } })
  assert.equal(badMode.code, 400)
  const badKey = await call(env.webUi, { method: 'POST', url: `${PAGE_PATH}/api/mode`, headers: PANEL, body: { chatKey: 'bad', mode: 'chat' } })
  assert.equal(badKey.code, 400)
})

test('配置写入：身份与权限字段（pairingPolicy / controlPolicy）可保存', async () => {
  const env = await setup()
  env.configEditor.current = { transport: 'qqbot' }
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
  const res = await call(env.webUi, { url: PAGE_PATH })
  const scripts = [...res.body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1])
  assert.ok(scripts.length > 0)
  for (const script of scripts) {
    assert.doesNotThrow(() => new Function(script), '内联脚本应能解析')
  }
})

test('状态 API：线路/身份/字段/活动/脱敏凭据', async () => {
  const env = await setup()
  await env.store.recordUsage('qqbot:1905346673:dm:owner-openid', { inputTokens: 7, outputTokens: 3 })
  const res = await call(env.webUi, { url: `${PAGE_PATH}/api/state` })
  assert.equal(res.code, 200)
  const state = res.json().state
  assert.equal(state.version.length > 0, true)
  assert.equal(state.pagePath, PAGE_PATH)
  assert.equal(state.transport, 'qqbot')
  assert.equal(state.routes.qqbot.enabled, true)
  assert.equal(state.routes.qqbot.label, '官方 QQBot')
  assert.deepEqual(state.routes.qqbot.profile, { id: 'bot-openid-1', name: '小Q', avatar: 'http://thirdqq.qlogo.cn/g?b=oidb&k=test&s=0' }, '官方线带上机器人昵称/头像')
  assert.deepEqual(Object.keys(state.routes), ['qqbot'], '公开仓库只有官方线一条线路')
  assert.equal(state.identity.homeChannels.qqbot, '')
  assert.deepEqual(state.identity.pending, [])
  assert.equal(Array.isArray(state.fields), true)
  assert.equal(state.fields.some(field => field.path === 'agentOptions.model'), true)
  assert.equal(state.values['agentOptions.model'], 'deepseek-flash')
  assert.deepEqual(state.credentials, { qqbot: false })
  assert.equal(state.activity.length, 7, '活动序列固定 7 天')
  assert.equal(state.usage.totals.today.total, 10, 'token 用量报表透传')
  assert.equal(state.usage.chats.length, 1)
  assert.equal(state.activity.every(day => day.qqbot === 0), true, '还没有活动计数时全为 0')
  assert.equal(state.alerts.enabled, true, '默认注入告警快照')
  // 模型目录：页面用它渲染 provider/model 下拉（DSH 配了哪些就显示哪些）
  assert.deepEqual(state.models.providers.map(entry => entry.id), ['deepseek-account', 'deepseek-official'])
  assert.deepEqual(state.models.providers[0].models.map(entry => entry.id), ['deepseek-flash', 'deepseek-pro'])
  assert.deepEqual(state.models.globalDefault, { provider: 'deepseek-account', model: 'deepseek-flash' })
  assert.deepEqual(Object.keys(state).sort(), ['activity', 'alerts', 'approvals', 'chatKeys', 'config', 'connections', 'credentials', 'defaultPersonaId', 'fields', 'groups', 'identity', 'issues', 'lines', 'mode', 'models', 'modes', 'pagePath', 'paths', 'personaBindings', 'personaModeBindings', 'personas', 'prompt', 'promptLimit', 'routes', 'stats', 'status', 'transport', 'url', 'usage', 'values', 'version'], '状态字段与文档一致（没有额外面板数据）')
})

test('配置写入：需要 CSRF 头；白名单 + 保留未提交项；非法值不落盘', async () => {
  const env = await setup()
  // 缺少 CSRF 头
  const forbidden = await call(env.webUi, { method: 'POST', url: `${PAGE_PATH}/api/config`, body: { changes: { mentionRequired: false } } })
  assert.equal(forbidden.code, 403)
  // 正常写入
  const ok = await call(env.webUi, { method: 'POST', url: `${PAGE_PATH}/api/config`, headers: PANEL, body: { changes: { mentionRequired: false } } })
  assert.equal(ok.code, 200)
  assert.equal(env.configEditor.saved.mentionRequired, false)
  // 白名单：未知字段被丢弃
  const filtered = await call(env.webUi, { method: 'POST', url: `${PAGE_PATH}/api/config`, headers: PANEL, body: { changes: { notEditable: 1, mentionRequired: true } } })
  assert.equal(filtered.code, 200)
  assert.equal('notEditable' in env.configEditor.saved, false)
  // 非法值：change 抛错，不落盘
  const before = env.configEditor.calls
  const bad = await call(env.webUi, { method: 'POST', url: `${PAGE_PATH}/api/config`, headers: PANEL, body: { changes: { maxFileBytes: 1 } } })
  assert.equal(bad.code, 400)
  assert.equal(env.configEditor.calls, before + 1)
})

test('配置写入：transports 数组可写，非法值被 resolveConfig 拦下', async () => {
  const env = await setup()
  const ok = await call(env.webUi, { method: 'POST', url: `${PAGE_PATH}/api/config`, headers: PANEL, body: { changes: { transports: [{ kind: 'qqbot' }] } } })
  assert.equal(ok.code, 200)
  assert.deepEqual(env.configEditor.saved.transports, [{ kind: 'qqbot' }])
  const dup = await call(env.webUi, { method: 'POST', url: `${PAGE_PATH}/api/config`, headers: PANEL, body: { changes: { transports: [{ kind: 'qqbot' }, { kind: 'qqbot' }] } } })
  assert.equal(dup.code, 400)
})

test('凭据写入：AppID/AppSecret 走 credentials seam，且响应不回显', async () => {
  const env = await setup({ credentials: { values: {} } })
  const bad = await call(env.webUi, { method: 'POST', url: `${PAGE_PATH}/api/credentials`, headers: PANEL, body: { route: 'qqbot', appId: '123', appSecret: '' } })
  assert.equal(bad.code, 400)
  const ok = await call(env.webUi, { method: 'POST', url: `${PAGE_PATH}/api/credentials`, headers: PANEL, body: { route: 'qqbot', appId: '1905346673', appSecret: 'super-secret' } })
  assert.equal(ok.code, 200)
  assert.equal(env.credentials.calls.set.length, 2)
  assert.deepEqual(env.credentials.calls.set.map(entry => entry.ref), ['QQ_APP_ID', 'QQ_CLIENT_SECRET'])
  assert.equal(ok.body.includes('super-secret'), false, '响应不得回显 secret')
  const cleared = await call(env.webUi, { method: 'POST', url: `${PAGE_PATH}/api/credentials`, headers: PANEL, body: { route: 'qqbot', clear: true } })
  assert.equal(cleared.code, 200)
  assert.equal(env.credentials.calls.unset.length >= 1, true)
})

test('身份操作：绑定主人 / 批准 / 拒绝 / 移除授权', async () => {
  const env = await setup()
  const bind = await call(env.webUi, { method: 'POST', url: `${PAGE_PATH}/api/identity`, headers: PANEL, body: { route: 'qqbot', action: 'setHome', userId: 'owner-openid' } })
  assert.equal(bind.code, 200)
  assert.equal(env.store.homeChannel('qqbot'), 'owner-openid')
  const approve = await call(env.webUi, { method: 'POST', url: `${PAGE_PATH}/api/identity`, headers: PANEL, body: { route: 'qqbot', action: 'approve', userId: 'user-1' } })
  assert.equal(approve.code, 200)
  assert.equal(env.store.roleOf('user-1', 'qqbot'), 'authorized')
  const remove = await call(env.webUi, { method: 'POST', url: `${PAGE_PATH}/api/identity`, headers: PANEL, body: { route: 'qqbot', action: 'removeAuthorized', userId: 'user-1' } })
  assert.equal(remove.code, 200)
  assert.equal(env.store.roleOf('user-1', 'qqbot'), 'everyone', '移除授权后回到默认角色')
})

test('动作按钮：登录返回扫码链接；退出/重连走 control', async () => {
  const env = await setup()
  const login = await call(env.webUi, { method: 'POST', url: `${PAGE_PATH}/api/action`, headers: PANEL, body: { action: 'login' } })
  assert.equal(login.code, 200)
  assert.equal(login.json().url, 'https://q.qq.com/x/abc')
  assert.equal(env.control.loginCalls, 1)
  const logout = await call(env.webUi, { method: 'POST', url: `${PAGE_PATH}/api/action`, headers: PANEL, body: { action: 'logout' } })
  assert.equal(logout.code, 200)
  assert.deepEqual(env.control.commands, ['/qq-logout'])
  const reconnect = await call(env.webUi, { method: 'POST', url: `${PAGE_PATH}/api/action`, headers: PANEL, body: { action: 'reconnect' } })
  assert.equal(reconnect.code, 200)
  assert.deepEqual(env.control.commands, ['/qq-logout', '/qq-reconnect'])
})

test('HTTP 边界：错误方法 405 / 未知路径 404 / 坏 JSON 400 / 超大包 400', async () => {
  const env = await setup()
  const wrongMethod = await call(env.webUi, { method: 'POST', url: `${PAGE_PATH}/api/state`, headers: PANEL })
  assert.equal(wrongMethod.code, 405)
  const unknown = await call(env.webUi, { url: `${PAGE_PATH}/api/nope` })
  assert.equal(unknown.code, 404)
  const badJson = await call(env.webUi, { method: 'POST', url: `${PAGE_PATH}/api/config`, headers: PANEL, body: '{bad' })
  assert.equal(badJson.code, 400)
  const huge = await call(env.webUi, { method: 'POST', url: `${PAGE_PATH}/api/config`, headers: PANEL, body: JSON.stringify({ changes: { cwd: 'x'.repeat(200 * 1024) } }) })
  assert.equal(huge.code, 400)
})

test('跨站防护：Origin 与 Host 不同源时拒绝写操作', async () => {
  const env = await setup()
  const cross = await call(env.webUi, { method: 'POST', url: `${PAGE_PATH}/api/config`, headers: { ...PANEL, origin: 'https://evil.example' }, body: { changes: { mentionRequired: false } } })
  assert.equal(cross.code, 403)
})

test('字体：自托管 woff2 由插件直接提供；白名单外 404', async () => {
  const env = await setup()
  const font = await call(env.webUi, { url: `${PAGE_PATH}/fonts/geist-var.woff2` })
  assert.equal(font.code, 200)
  assert.match(font.headers['content-type'], /font\/woff2|application\/octet-stream/)
  const missing = await call(env.webUi, { url: `${PAGE_PATH}/fonts/nope.woff2` })
  assert.equal(missing.code, 404)
})

test('状态 API：没有告警管理器时 alerts 为 null', async () => {
  const env = await setup({ alerts: null })
  const res = await call(env.webUi, { url: `${PAGE_PATH}/api/state` })
  assert.equal(res.json().state.alerts, null)
})

test('状态 API：透传告警快照（页面告警条与事件列表用）', async () => {
  const snapshot = {
    enabled: true,
    notify: true,
    active: [{ kind: 'qqbot', label: '官方线', since: 1_000_000, phase: 'disconnected', lastError: 'ws closed' }],
    events: [{ at: 1_000_000, type: 'down', text: '⚠️ dsh-qq：官方线掉线（disconnected）' }],
    pending: 0,
  }
  const env = await setup({ alerts: { snapshot: () => snapshot } })
  const res = await call(env.webUi, { url: `${PAGE_PATH}/api/state` })
  const state = res.json().state
  assert.equal(state.alerts.active.length, 1)
  assert.equal(state.alerts.active[0].kind, 'qqbot')
  assert.equal(state.alerts.events.length, 1)
  assert.equal(state.config.alerts.enabled, true)
})


test('模型目录：保存时校验 provider/model，非法值不落盘', async () => {
  const env = await setup()
  const badProvider = await call(env.webUi, { method: 'POST', url: `${PAGE_PATH}/api/config`, headers: PANEL, body: { changes: { 'agentOptions.provider': 'no-such-provider' } } })
  assert.equal(badProvider.code, 400)
  assert.match(badProvider.json().error, /未知的 provider/)
  const badModel = await call(env.webUi, { method: 'POST', url: `${PAGE_PATH}/api/config`, headers: PANEL, body: { changes: { 'agentOptions.provider': 'deepseek-official', 'agentOptions.model': 'deepseek-flash' } } })
  assert.equal(badModel.code, 400, '模型不属于该 provider 时应拒绝')
  const ok = await call(env.webUi, { method: 'POST', url: `${PAGE_PATH}/api/config`, headers: PANEL, body: { changes: { 'agentOptions.provider': 'deepseek-official', 'agentOptions.model': 'deepseek-chat' } } })
  assert.equal(ok.code, 200)
  assert.deepEqual(env.configEditor.saved.agentOptions, { provider: 'deepseek-official', model: 'deepseek-chat' })
})

test('模型目录：没有 llm 服务时退回纯文本，不拦配置', async () => {
  const env = await setup({ llm: { listConfigurableProviders: () => [], listProviders: () => [], listModels: async () => [] }, agentDefaultModel: { currentSelection: () => null } })
  const state = (await call(env.webUi, { url: `${PAGE_PATH}/api/state` })).json().state
  assert.deepEqual(state.models, { providers: [], globalDefault: null })
  const ok = await call(env.webUi, { method: 'POST', url: `${PAGE_PATH}/api/config`, headers: PANEL, body: { changes: { 'agentOptions.provider': 'whatever', 'agentOptions.model': 'x' } } })
  assert.equal(ok.code, 200, '目录不可用时不做 provider/model 校验')
})

// ── 群记忆编辑 ──

test('群记忆：state 带笔记列表；GET 正文 / POST 保存走群记忆模块', async () => {
  const env = await setup()
  const state = (await call(env.webUi, { url: '/dsh-qq/api/state' })).json().state
  assert.deepEqual(state.groups, [{ file: 'qqbot_1_group_90001.md', chars: 12, updatedAt: 1_700_000_000_000 }])

  const read = await call(env.webUi, { url: '/dsh-qq/api/groups/note?file=qqbot_1_group_90001.md' })
  assert.equal(read.code, 200)
  assert.match(JSON.parse(read.body).text, /老板/)
  const traversal = await call(env.webUi, { url: '/dsh-qq/api/groups/note?file=../../etc/passwd' })
  assert.equal(traversal.code, 400, '路径穿越必须拒绝')

  const write = await call(env.webUi, {
    method: 'POST',
    url: '/dsh-qq/api/groups/note',
    headers: PANEL,
    body: { file: 'qqbot_1_group_90001.md', text: '# 新内容\n' },
  })
  assert.equal(write.code, 200, write.body)
  assert.deepEqual(env.groupMemory.writes, [{ file: 'qqbot_1_group_90001.md', text: '# 新内容\n' }])
})

// ── 测试消息 ──

test('测试消息：按线路发送，校验空文本/目标', async () => {
  const env = await setup()
  const ok = await call(env.webUi, {
    method: 'POST',
    url: '/dsh-qq/api/test-message',
    headers: PANEL,
    body: { kind: 'mock', targetKind: 'group', targetId: '90001', text: 'ping' },
  })
  assert.equal(ok.code, 200, ok.body)
  assert.equal(JSON.parse(ok.body).messageId, 'tm-1')
  assert.deepEqual(env.transport.sentTestMessages, [{ target: { kind: 'group', groupId: '90001' }, text: 'ping' }])
  const empty = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/test-message', headers: PANEL, body: { kind: 'mock', targetKind: 'group', targetId: '1', text: ' ' } })
  assert.equal(JSON.parse(empty.body).ok, false)
  const badTarget = await call(env.webUi, { method: 'POST', url: '/dsh-qq/api/test-message', headers: PANEL, body: { kind: 'mock', targetKind: 'group', targetId: '', text: 'x' } })
  assert.equal(JSON.parse(badTarget.body).ok, false)
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
    body: { chatKey: 'qqbot:1905346673:dm:A6AB', text: '这个人是管理员' },
  })
  assert.equal(chat.code, 200, chat.body)
  assert.equal(env.store.promptFor('qqbot:1905346673:dm:A6AB'), '这个人是管理员')

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

test('状态：pricing 与最近审批透传', async () => {
  const env = await setup()
  await env.store.recordApproval({ decision: 'deny', summary: 'rm -rf /', actorId: 'owner', chatKey: 'mock:1:group:g' })
  const state = (await call(env.webUi, { url: '/dsh-qq/api/state' })).json().state
  assert.equal(state.approvals.length, 1)
  assert.equal(state.approvals[0].decision, 'deny')
  assert.deepEqual(state.config.pricing, { inputPerMillion: 0, outputPerMillion: 0 })
})
