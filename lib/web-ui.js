/**
 * dsh-qq 的 Web 控制台（插件自带，零构建、零依赖）。
 *
 * 形态决策（2026-10-19/20/21）：
 * - DSH 原生设置页只渲染「插件 Config schema 的 volatile 字段」，本插件用自定义 resolveConfig
 *   （无 schemastery Config），原生不会给它生成表单；
 * - 官方客户端插件必须是 tsdown 构建产物 + React（要引入构建管线），与「零依赖、无构建」冲突，
 *   且易随 DSH rc 版本的客户端模块系统漂移；
 * - 结论：插件通过 webServer 注册自己的 HTTP 路由，服务一个**自包含 HTML 页**（内联 CSS/JS），
 *   读写走 JSON API。浏览器打开 `http://<dsh-web>/dsh-qq` 即可。
 *
 * 设计方向（tasteskill v2 抽签，seed 501975947，style `achromatic-ledger`）：
 * - 机身无彩色：主线走 ink，唯一的数据色 #1d5fbf 只落在「信号链」这个主数据元素上；
 * - 主按钮近黑，次按钮灰底；无阴影、无渐变、无图标色块、无大写字母标签；
 * - 面板 = 白底 + 1px 边框 + 8px 圆角；字号 12/14/16/24/30；数字用 tabular figures；
 * - 字体 Geist（自托管 woff2，OFL 1.1），ID/路径用 Geist Mono。
 * 设计上的主语：这是一个「通道诊断台」，屏幕先回答「哪一段断了」，并把修复动作放在断点旁边。
 *
 * 安全边界：
 * - 所有写操作要求 `x-dsh-qq-panel: 1` 头（跨站请求带不上，挡住 CSRF）；Origin 存在时必须同源；
 * - 页面只暴露**脱敏**信息：token/secret 永远只有「是否已配置」，绝不回显；
 * - 凭据写入只走 credentials seam（`credentials.set/unset`），不落 profile YAML、不进聊天记录；
 * - NapCat 启停只执行配置里指定的脚本 + 固定动作白名单，不接受页面传参；
 * - webServer 默认只绑本机回环地址，页面不会对局域网暴露。
 */

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

import { MAX_PROMPT_CHARS, normalizePersonaStickerIds } from './store.js'
import { createPersonaPreview } from './persona-preview.js'
import { normalizeActivity } from './chat-behavior.js'
import { assertTarget, parseChatKey } from './transport.js'
import {
  ONEBOT_CREDENTIAL_REFS,
  ROLES,
  clearCredentials,
  resolveConfig,
  resolveCredentials,
  saveCredentials,
} from './config.js'

/** 页面与 API 的路径前缀（webServer 的 prefix 路由，不能带尾斜杠）。 */
export const PAGE_PATH = '/dsh-qq'

/** POST 请求体上限：配置项都是小字段，64KB 绰绰有余（也挡住恶意大包）。 */
const MAX_BODY_BYTES = 64 * 1024

/** 写操作必须带的请求头（页面 fetch 会带；跨站表单/脚本带不上）。 */
const PANEL_HEADER = 'x-dsh-qq-panel'

/** 自托管字体（latin 子集）：路径白名单 + MIME。 */
const FONT_FILES = Object.freeze({
  'geist-var.woff2': 'font/woff2',
  'geist-mono-400.woff2': 'font/woff2',
})

/**
 * 可编辑字段白名单 + 表单元数据。
 *
 * 页面按这份描述动态渲染表单，服务端也按它的 `path` 过滤提交，两边共用一份定义，不会漂移。
 * type: text | number | boolean | select | list
 * group: chat | model | advanced
 */
export const EDITABLE_FIELDS = Object.freeze([
  { path: 'onebot.wsUrl', label: 'NapCat 的 WS 地址', type: 'text', group: 'chat', help: 'NapCat 正向 WS，例如 ws://127.0.0.1:3001' },
  { path: 'onebot.allowRemote', label: '允许连接公网 NapCat', type: 'boolean', group: 'chat', help: '默认只允许回环/私网；把 NapCat 暴露在公网时打开（自行承担风险）' },
  { path: 'onebot.sendRateLimitMs', label: '出站限速（毫秒）', type: 'number', group: 'chat', help: '0 表示不限速；300 对个人号风控更友好' },
  { path: 'mentionRequired', label: '群聊必须 @ 才回复', type: 'boolean', group: 'chat' },
  { path: 'groupOpen', label: '群聊开放给所有群成员', type: 'boolean', group: 'chat', help: '默认开：群成员聊天不再逐个配对；DM 仍按陌生人策略。allowlist 模式保持严格。' },
  { path: 'freeReplyGroups', label: '免 @ 群白名单', type: 'list', group: 'chat', help: '逗号分隔群号；留空表示没有免 @ 的群' },
  { path: 'midTurnDelivery', label: '连发消息的投递方式', type: 'select', options: ['steer', 'queue'], group: 'chat', help: 'steer：后面的消息进入正在跑的回合；queue：各自排队' },
  { path: 'markdown', label: 'Markdown 模式', type: 'select', options: ['auto', 'on', 'off'], group: 'chat', help: 'auto：按协议能力决定（个人 QQ 不渲染 Markdown）' },
  { path: 'agentOptions.provider', label: '渠道默认模型 provider', type: 'select', dynamic: 'provider', group: 'model', help: '下拉里是 DSH 已配置的 provider；留空则跟随 DSH 全局默认' },
  { path: 'agentOptions.model', label: '渠道默认模型', type: 'select', dynamic: 'model', group: 'model', help: '按选中的 provider 列出可选模型；留空则跟随 DSH 全局默认' },
  { path: 'agentOptions.reasoningEffort', label: '渠道默认推理强度', type: 'select', options: ['', 'off', 'low', 'medium', 'high', 'max'], group: 'model', help: '留空则用模型默认' },
  { path: 'stickers.enabled', label: '启用表情包图库', type: 'boolean', group: 'chat' },
  { path: 'stickers.autoCollect', label: '自动收藏群/私聊图片', type: 'boolean', group: 'chat', help: '会保存所有图片（不区分表情包/截图），只进候选，不会自动发。' },
  { path: 'stickers.crossGroup', label: '表情包跨群共享', type: 'boolean', group: 'chat', help: '关闭后每张图只在本群/本私聊可见。' },
  { path: 'stickers.noShareGroups', label: '禁止跨群的群号', type: 'list', group: 'chat', help: '逗号分隔；这些群的图只在本群可见' },
  { path: 'stickers.vision.enabled', label: '视觉自动打标', type: 'boolean', group: 'chat', help: '用 DSH 当前模型判断表情包/截图并自动打标签；会消耗图片 token。' },
  { path: 'stickers.vision.provider', label: '视觉模型 provider', type: 'text', group: 'chat', help: '默认 deepseek-account' },
  { path: 'stickers.vision.model', label: '视觉模型', type: 'text', group: 'chat', help: '默认 deepseek-flash' },
  { path: 'stickers.vision.autoTrashOther', label: '非表情包自动进回收站', type: 'boolean', group: 'chat', help: '截图/图表/照片自动移入回收站（可恢复）' },
  { path: 'affection.enabled', label: '启用关系统计（熟识度）', type: 'boolean', group: 'chat', help: '默认关；只统计发言/被点名/发图/活跃天数，不存正文，不影响权限/礼貌。' },
  { path: 'affection.retentionDays', label: '关系统计保留天数', type: 'number', group: 'chat' },
  { path: 'participation.enabled', label: '启用参与判断（未 @ 群聊）', type: 'boolean', group: 'chat', help: '默认关；先 log 观察，再切 block。官方线只能看到 @ 消息，个人线才有效。' },
  { path: 'participation.mode', label: '参与判断模式', type: 'select', options: ['off', 'log', 'block'], group: 'chat', help: 'log 只记录不唤醒；block 低分不唤醒' },
  { path: 'participation.threshold', label: '参与判断阈值（0–1）', type: 'number', group: 'chat', help: '越高越保守；建议先 log 观察再调' },
  { path: 'participation.dailyWakeLimit', label: '每群每日自动接话上限', type: 'number', group: 'chat' },
  { path: 'groupMemory.enabled', label: '启用群记忆', type: 'boolean', group: 'model' },
  { path: 'groupMemory.bufferMessages', label: '群环境缓冲条数', type: 'number', group: 'model' },
  { path: 'groupMemory.contextMaxChars', label: '群上下文注入预算（字符）', type: 'number', group: 'model' },
  { path: 'groupMemory.notesMaxChars', label: '群笔记容量上限（字符）', type: 'number', group: 'model' },
  { path: 'pairingPolicy', label: '陌生人策略', type: 'select', options: ['pairing', 'open', 'allowlist'], group: 'identity', help: 'pairing：需要批准；open：所有人可聊；allowlist：仅白名单' },
  { path: 'controlPolicy.chat', label: '对话权限', type: 'select', options: [...ROLES], group: 'identity', help: '谁能在这个渠道里正常对话' },
  { path: 'controlPolicy.sessionControl', label: '会话命令权限', type: 'select', options: [...ROLES], group: 'identity', help: '谁能用 /qq-new、/qq-sessions、/qq-switch、/qq-title、/qq-stop' },
  { path: 'controlPolicy.modelControl', label: '模型命令权限', type: 'select', options: [...ROLES], group: 'identity', help: '谁能用 /qq-model、/qq-reasoning' },
  { path: 'controlPolicy.approvals', label: '管理命令权限', type: 'select', options: [...ROLES], group: 'identity', help: '谁能用登录/退出/审批/重连等管理命令' },
  { path: 'stt.baseUrl', label: '外部语音转写 baseUrl', type: 'text', group: 'model', help: '可选；留空则只用 QQ 自带语音转写' },
  { path: 'stt.model', label: '外部语音转写模型', type: 'text', group: 'model', help: '可选；例如 glm-asr' },
  { path: 'agentPreset', label: '新会话 preset', type: 'text', group: 'model', help: '留空则用 DSH 默认 preset' },
  { path: 'autoConnect', label: '插件加载后自动连接', type: 'boolean', group: 'advanced', help: '关掉后需要手动 /qq-reconnect（调试用）' },
  { path: 'cwd', label: '新会话工作目录', type: 'text', group: 'advanced', help: '留空则用 DSH 默认工作目录' },
  { path: 'watchdogIntervalMs', label: '看门狗间隔（毫秒）', type: 'number', group: 'advanced' },
  { path: 'maxQueuedMessagesPerChat', label: '单对话在途消息上限', type: 'number', group: 'advanced' },
  { path: 'maxMediaPerMessage', label: '单条消息媒体上限', type: 'number', group: 'advanced' },
  { path: 'maxFileBytes', label: '单文件上限（字节）', type: 'number', group: 'advanced' },
  { path: 'media.allowedHosts', label: '媒体白名单主机', type: 'list', group: 'advanced', help: '自建/私网媒体源必须列在这里：host、host:port 或 *.example.com，逗号分隔' },
  { path: 'media.allowPrivateHosts', label: '允许媒体访问私网', type: 'boolean', group: 'advanced', help: '默认关闭；打开后任何解析到私网的媒体 URL 都可下载（风险自担）' },
  { path: 'media.tokenHosts', label: '媒体鉴权白名单', type: 'list', group: 'advanced', help: '默认只给 transport 自己的源站带 token；官方 CDN 需要鉴权时再加' },
  { path: 'media.maxRedirects', label: '媒体重定向上限', type: 'number', group: 'advanced' },
  { path: 'approvalTtlMs', label: '审批有效期（毫秒）', type: 'number', group: 'advanced' },
  { path: 'replyWindowMs', label: '被动回复窗口（毫秒）', type: 'number', group: 'advanced' },
  { path: 'dedupWindowMs', label: '入站去重窗口（毫秒）', type: 'number', group: 'advanced' },
  { path: 'dedupMaxSize', label: '入站去重容量', type: 'number', group: 'advanced' },
  { path: 'napcat.webuiUrl', label: 'NapCat WebUI 地址', type: 'text', group: 'advanced', help: '留空则按 NapCat 的 webui.json 自动生成。Windows 浏览器访问 WSL 时建议写 http://localhost:6099：127.0.0.1 在 Windows 侧可能打不开' },
  { path: 'pricing.inputPerMillion', label: '输入价格（元/百万 token）', type: 'number', group: 'advanced', help: '可选：填了就在「Token 消耗」卡片里换算成约 ¥；0 表示不换算' },
  { path: 'pricing.outputPerMillion', label: '输出价格（元/百万 token）', type: 'number', group: 'advanced', help: '可选：填了就在「Token 消耗」卡片里换算成约 ¥；0 表示不换算' },
  { path: 'alerts.notify', label: '掉线时 QQ 私聊通知', type: 'boolean', group: 'advanced', help: '用另一条还活着的线路私聊主人；页面告警条始终生效' },
  { path: 'alerts.downAfterMs', label: '掉线多久才提醒（毫秒）', type: 'number', group: 'advanced', help: '防抖阈值，默认 60000（1 分钟）' },
])

const EDITABLE_PATHS = new Set(EDITABLE_FIELDS.map(field => field.path))

/** 读插件版本（页面标题展示；读不到不影响功能）。 */
function packageVersion() {
  try {
    return String(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '')
  } catch {
    return ''
  }
}

/** 版本号缓存：按需读 package.json，避免模块被缓存后标签永远停在旧值。 */
let versionCache = { value: '', at: 0 }

/** 读插件版本（60 秒缓存；读不到返回空串）。 */
function pluginVersion() {
  const now = Date.now()
  if (now - versionCache.at < 60_000) return versionCache.value
  const value = packageVersion()
  versionCache = { value, at: now }
  return value
}

/** 路径取值（`a.b.c`）。 */
function getPath(source, path) {
  let current = source
  for (const key of String(path).split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined
    current = current[key]
  }
  return current
}

/** 路径赋值（自动建中间对象）。 */
function setPath(target, path, value) {
  const keys = String(path).split('.')
  let current = target
  for (let index = 0; index < keys.length - 1; index += 1) {
    const key = keys[index]
    if (current[key] === null || current[key] === undefined || typeof current[key] !== 'object') current[key] = {}
    current = current[key]
  }
  current[keys[keys.length - 1]] = value
}

/** 路径删除（用于「留空 = 恢复继承」的字段）。 */
function deletePath(target, path) {
  const keys = String(path).split('.')
  let current = target
  for (let index = 0; index < keys.length - 1; index += 1) {
    const key = keys[index]
    if (current[key] === null || current[key] === undefined || typeof current[key] !== 'object') return
    current = current[key]
  }
  delete current[keys[keys.length - 1]]
}

/** 收尾：删掉因为清空字段而变空的父对象（避免写了 `agentOptions: {}` 这种噪音）。 */
function pruneEmpty(source, path) {
  const keys = String(path).split('.')
  if (keys.length < 2) return
  const parentPath = keys.slice(0, -1).join('.')
  const parent = getPath(source, parentPath)
  if (parent !== null && parent !== undefined && typeof parent === 'object' && Object.keys(parent).length === 0) {
    deletePath(source, parentPath)
    pruneEmpty(source, parentPath)
  }
}

const sendJson = (res, code, payload) => {
  const body = JSON.stringify(payload)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

const sendHtml = (res, html) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(html)
}

/** 读 JSON 请求体（带上限）。 */
function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        reject(new Error(`请求体超过 ${limit} 字节上限`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${error instanceof Error ? error.message : String(error)}`))
      }
    })
    req.on('error', error => reject(error))
  })
}

/** 把一个提交值转成配置值（number 字段做一次数字转换，其它原样）。 */
function coerceValue(field, value) {
  if (field.type === 'number') {
    const number = Number(value)
    if (!Number.isFinite(number)) throw new Error(`${field.label} 必须是数字`)
    return number
  }
  if (field.type === 'boolean') return value === true
  if (field.type === 'list') {
    return Array.isArray(value)
      ? value.map(item => String(item).trim()).filter(item => item !== '')
      : String(value ?? '')
          .split(',')
          .map(item => item.trim())
          .filter(item => item !== '')
  }
  return value === null || value === undefined ? '' : String(value)
}

/**
 * 创建 Web 控制台。
 * @param {object} deps
 * @param {object} deps.ctx - Cordis 上下文（用 ctx.get('webServer'|'configEditor'|'credentials')）。
 * @param {object} deps.config - resolveConfig 结果（当前生效配置）。
 * @param {object} deps.store - store（统计/身份/路径）。
 * @param {object} deps.transport - transport（读 status / loginHint）。
 * @param {object} [deps.control] - control 模块（登录/登出/重连）。
 * @param {object} [deps.napcat] - NapCat 控制器（状态/二维码/启停）。
 * @param {object} [deps.logger]
 * @returns {object} webUi
 */
export function createWebUi({ ctx, config, store, transport, control = null, napcat = null, alerts = null, groupMemory = null, memory = null, stickers = null, participation = null, affection = null, stickerTagger = null, diagnostics = null, logger = null }) {
  const personaPreview = createPersonaPreview({ ctx, config, store, stickers, control, memory })
  const personaWrite = run => memory?.withPersonaWrite ? memory.withPersonaWrite(run) : run()
  /** 模型目录缓存（30s）。 */
  let modelCatalogCache = null
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

  /** 已注册的 webServer（注入完成后才有）。 */
  let webServer = null
  let disposeRoute = null

  /** 页面地址（webServer 未挂载或尚未绑定端口时返回 null）。 */
  function url() {
    if (webServer === null || typeof webServer.getOrigin !== 'function') return null
    try {
      return `${webServer.getOrigin()}${PAGE_PATH}`
    } catch {
      return null
    }
  }

  /**
   * 模型目录：DSH 里已配置的 provider + 每个 provider 的可用模型 + 全局默认模型。
   *
   * 用途：配置页的 provider / model 下拉（用户要求「dsh 中配置了哪些就显示哪些」）。
   * 走 DSH 的 llm 服务：listConfigurableProviders() 拿已配置的 provider，listModels() 拿模型；
   * 服务缺失或调用失败时返回空目录，页面退化成「留空 = 跟随全局默认」的纯文本输入。
   * 缓存 30 秒：页面 5 秒轮询一次，不宜每次都枚举全部 provider 的模型。
   */
  async function modelCatalog() {
    const cached = modelCatalogCache
    if (cached !== null && Date.now() - cached.at < 30_000) return cached.value
    const llm = ctx.get?.('llm')
    const providers = []
    if (llm !== null && llm !== undefined) {
      const pick = () => {
        try {
          if (typeof llm.listConfigurableProviders === 'function') return llm.listConfigurableProviders()
        } catch {
          /* ignore */
        }
        try {
          if (typeof llm.listProviders === 'function') return llm.listProviders()
        } catch {
          /* ignore */
        }
        return []
      }
      const entries = Array.isArray(pick()) ? pick() : []
      for (const entry of entries) {
        const id = String(entry?.provider ?? entry?.id ?? '').trim()
        if (id === '') continue
        let models = []
        if (typeof llm.listModels === 'function') {
          try {
            models = await llm.listModels(id)
          } catch {
            models = []
          }
        }
        providers.push({
          id,
          name: String(entry?.displayName ?? entry?.name ?? id),
          models: (Array.isArray(models) ? models : [])
            .map(model => ({ id: String(model?.id ?? '').trim(), name: String(model?.name ?? model?.id ?? '').trim() }))
            .filter(model => model.id !== ''),
        })
      }
    }
    let globalDefault = null
    try {
      const defaultModel = ctx.get?.('agentDefaultModel')
      const selection = defaultModel !== null && defaultModel !== undefined && typeof defaultModel.currentSelection === 'function' ? defaultModel.currentSelection() : null
      if (selection !== null && selection !== undefined && typeof selection.provider === 'string' && typeof selection.model === 'string') {
        globalDefault = {
          provider: selection.provider,
          model: selection.model,
          ...(typeof selection.reasoningEffort === 'string' && selection.reasoningEffort !== '' ? { reasoningEffort: selection.reasoningEffort } : {}),
        }
      }
    } catch {
      globalDefault = null
    }
    const value = { providers, globalDefault }
    modelCatalogCache = { at: Date.now(), value }
    return value
  }

  /** 脱敏后的生效配置：token/secret 只报「是否配置」，绝不回显。 */
  function publicConfig() {
    const onebot = config.onebot ?? {}
    return {
      transport: config.transport,
      autoConnect: config.autoConnect,
      accountId: config.accountId,
      markdown: config.markdown,
      mentionRequired: config.mentionRequired,
      groupOpen: config.groupOpen,
      freeReplyGroups: Array.isArray(config.freeReplyGroups) ? [...config.freeReplyGroups] : [],
      midTurnDelivery: config.midTurnDelivery,
      maxQueuedMessagesPerChat: config.maxQueuedMessagesPerChat,
      maxFileBytes: config.maxFileBytes,
      media: {
        ...(config.media ?? {}),
        allowedHosts: [...(config.media?.allowedHosts ?? [])],
        tokenHosts: [...(config.media?.tokenHosts ?? [])],
      },
      groupMemory: { ...(config.groupMemory ?? {}) },
      stickers: {
        enabled: config.stickers?.enabled !== false,
        autoCollect: config.stickers?.autoCollect !== false,
        crossGroup: config.stickers?.crossGroup !== false,
        noShareGroups: [...(config.stickers?.noShareGroups ?? [])],
        vision: { ...(config.stickers?.vision ?? {}) },
      },
      participation: { ...(config.participation ?? {}) },
      affection: { ...(config.affection ?? {}) },
      pricing: { ...(config.pricing ?? {}) },
      agentOptions: config.agentOptions === null ? null : { ...config.agentOptions },
      napcat: { ...(config.napcat ?? {}) },
      alerts: { ...(config.alerts ?? {}) },
      transports: (config.transports ?? []).map(spec => ({ kind: spec.kind, accountId: spec.accountId, enabled: spec.enabled })),
      onebot: {
        wsUrl: String(onebot.wsUrl ?? ''),
        sendRateLimitMs: onebot.sendRateLimitMs,
        accessToken: String(onebot.accessToken ?? '') === '' ? '' : '（已配置，不回显）',
      },
    }
  }

  /**
   * OneBot access_token 是否**已配置**（配置 → 凭据 seam → 环境变量，与 onebot.js resolveToken 同序）。
   * 只回答存在性，绝不返回值本身。
   */
  async function hasOnebotToken() {
    if (String(config.onebot?.accessToken ?? '') !== '') return true
    const credentialsHost = ctx.get?.('credentials')
    if (credentialsHost !== null && credentialsHost !== undefined && typeof credentialsHost.resolve === 'function') {
      try {
        const hit = await credentialsHost.resolve(ONEBOT_CREDENTIAL_REFS.accessToken)
        if (typeof hit?.value === 'string' && hit.value.trim() !== '') return true
      } catch {
        /* 凭据服务读取失败：继续看环境变量 */
      }
    }
    return String(process.env.ONEBOT_ACCESS_TOKEN ?? '').trim() !== ''
  }

  /** 页面需要的全部状态（表单值 + 运行状态 + 两路信息 + 身份 + NapCat + 路径）。 */
  async function state() {
    const status = typeof transport?.status === 'function' ? transport.status() : {}
    let qqCredentials = null
    try {
      qqCredentials = await resolveCredentials(ctx)
    } catch {
      qqCredentials = null
    }
    const onebotToken = status.tokenConfigured === true || (await hasOnebotToken())
    const active = config.transport
    const values = {}
    for (const field of EDITABLE_FIELDS) {
      const value = getPath(config, field.path)
      values[field.path] = value === undefined || value === null ? (field.type === 'list' ? [] : '') : value
    }
    let stats = null
    try {
      stats = typeof store?.stats === 'function' ? store.stats() : null
    } catch {
      stats = null
    }
    let pending = []
    try {
      pending = typeof store?.pendingPairing === 'function' ? store.pendingPairing() : []
    } catch {
      pending = []
    }
    // 多线路：每条线路的真实状态都来自注册表的 lines()（单线路时就是那一条）
    const lineStatuses = typeof transport?.lines === 'function' ? transport.lines() : null
    const lineOf = kind => (lineStatuses === null ? null : (lineStatuses.find(line => line.kind === kind) ?? null))
    const enabledKinds = new Set((config.transports ?? []).filter(spec => spec.enabled !== false).map(spec => spec.kind))
    const routes = {
      qqbot: {
        // active = 这条线路已启用并参与运行（多线路时两条都可能是 true）
        active: enabledKinds.has('qqbot'),
        enabled: enabledKinds.has('qqbot'),
        label: '官方 QQBot',
        credentials: { configured: qqCredentials !== null, appId: qqCredentials?.appId ?? '' },
        status: lineOf('qqbot'),
      },
      onebot: {
        active: enabledKinds.has('onebot'),
        enabled: enabledKinds.has('onebot'),
        label: '个人号 OneBot',
        credentials: { configured: onebotToken },
        status: lineOf('onebot'),
        wsUrl: String(config.onebot?.wsUrl ?? ''),
      },
    }
    const identity = {
      homeChannels: {
        qqbot: typeof store?.homeChannel === 'function' ? store.homeChannel('qqbot') : '',
        onebot: typeof store?.homeChannel === 'function' ? store.homeChannel('onebot') : '',
      },
      authorized: {
        qqbot: typeof store?.authorizedList === 'function' ? store.authorizedList('qqbot') : [],
        onebot: typeof store?.authorizedList === 'function' ? store.authorizedList('onebot') : [],
      },
      pending: Array.isArray(pending)
        ? pending.map(entry => ({
            id: String(entry.id ?? ''),
            name: String(entry.name ?? ''),
            transportKind: entry.transportKind === undefined ? null : entry.transportKind,
            firstAt: entry.firstAt ?? 0,
          }))
        : [],
    }
    // 每线最近活动：从 store 的对话指针还原（最近 5 条），给页面「最近活动」用。
    // 只读展示，不额外落盘；chatKey 自带线路命名空间，天然按线分组。
    const connections = { qqbot: [], onebot: [] }
    try {
      const keys = typeof store?.chatKeys === 'function' ? store.chatKeys() : []
      const entries = []
      for (const chatKey of keys) {
        let parsed = null
        try {
          parsed = parseChatKey(chatKey)
        } catch {
          continue
        }
        if (parsed.transportKind !== 'qqbot' && parsed.transportKind !== 'onebot') continue
        const chat = typeof store.chat === 'function' ? store.chat(chatKey) : null
        const target = parsed.target
        entries.push({
          transportKind: parsed.transportKind,
          chatKey,
          targetKind: target.kind,
          targetId: target.kind === 'dm' ? target.userId : target.kind === 'group' ? target.groupId : `${target.guildId}:${target.channelId}`,
          sessionId: chat?.currentSessionId ?? '',
          sessions: Array.isArray(chat?.sessions) ? chat.sessions.length : 0,
          updatedAt: Number(chat?.updatedAt ?? 0),
        })
      }
      entries.sort((a, b) => b.updatedAt - a.updatedAt)
      for (const entry of entries) {
        if (connections[entry.transportKind].length >= 5) continue
        connections[entry.transportKind].push(entry)
      }
    } catch {
      /* 活动列表失败不影响页面其它部分 */
    }

    // 各线路的机器人资料（昵称/头像）：transport 实现了 getProfile 就取一份，失败不影响页面。
    const profiles = {}
    // 多线路注册表用 entries；单 transport（测试/旧装配）直接把 transport 当一条线
    const profileEntries = Array.isArray(transport?.entries) ? transport.entries : [{ kind: config.transport, transport }]
    for (const entry of profileEntries) {
      const impl = entry.transport
      if (impl === null || impl === undefined || typeof impl.getProfile !== 'function') continue
      try {
        const profile = await impl.getProfile()
        if (profile !== null && typeof profile === 'object') profiles[entry.kind] = profile
      } catch {
        /* 资料拿不到就退回页面占位符 */
      }
    }
    // 把机器人资料挂到对应线路上，页面直接 routes[kind].profile 取用
    for (const kind of Object.keys(routes)) routes[kind].profile = profiles[kind] ?? null

    let models = { providers: [], globalDefault: null }
    try {
      models = await modelCatalog()
    } catch {
      models = { providers: [], globalDefault: null }
    }

    let usage = null
    try {
      usage = typeof store?.usageReport === 'function' ? store.usageReport({ days: 30 }) : null
    } catch {
      usage = null
    }
    const participationState = participation !== null && participation !== undefined && typeof participation.snapshot === 'function'
      ? participation.snapshot()
      : null
    const preferenceState = typeof store?.preferences === 'function' ? store.preferences() : { chats: {}, members: {} }
    const scheduleState = typeof store?.schedules === 'function'
      ? store.schedules().slice(0, 100).map(task => ({
        id: task.id,
        chatKey: task.chatKey,
        kind: task.kind,
        time: task.time,
        at: task.at,
        social: task.social,
        prompt: String(task.prompt ?? '').slice(0, 80),
        enabled: task.enabled !== false,
        lastRun: task.lastRun,
        lastError: task.lastError,
      }))
      : []
    const relationState = affection !== null && affection !== undefined && typeof affection.snapshot === 'function'
      ? await affection.snapshot()
      : { enabled: false, groups: [] }
    let stickerState = null
    try {
      if (stickers !== null && stickers !== undefined && typeof stickers.stats === 'function') {
        stickerState = { ...stickers.stats(), items: typeof stickers.listAll === 'function' ? stickers.listAll(120) : [], tagging: stickerTagger?.snapshot?.() ?? null }
      }
    } catch {
      stickerState = null
    }

    const personaBindings = typeof store?.personaBindings === 'function' ? store.personaBindings() : {}
    const personaModeBindings = typeof store?.personaModeBindings === 'function' ? store.personaModeBindings() : {}
    const personaRecent = typeof store?.personaRecentList === 'function' ? store.personaRecentList() : []
    const personaFavorites = typeof store?.personaFavoriteList === 'function' ? store.personaFavoriteList() : []
    // 会话提示词：默认 + 各对话覆盖；chatKeys 供页面列出「已知对话」
    const prompt = {
      default: typeof store?.defaultPrompt === 'function' ? store.defaultPrompt() : '',
      chats: typeof store?.promptChats === 'function' ? store.promptChats() : {},
    }
    const chatKeys = typeof store?.chatKeys === 'function' ? store.chatKeys() : []
    // 已知对话的模式（work/chat）：页面「按对话绑定」行内快速切换
    const modeKeys = new Set([...chatKeys, ...Object.keys(prompt.chats), ...Object.keys(personaBindings), ...Object.keys(personaModeBindings)])
    const modes = {}
    for (const key of modeKeys) {
      modes[key] = typeof store?.modeFor === 'function' ? store.modeFor(key) : 'work'
    }

    let activity = []
    try {
      activity = typeof store?.activity === 'function' ? store.activity(7) : []
    } catch {
      activity = []
    }

    // 群笔记列表（控制台「群记忆」卡片）：只列已有文件，不读正文（点开才读）
    let groups = []
    try {
      groups = typeof groupMemory?.listNotes === 'function' ? await groupMemory.listNotes() : []
    } catch {
      groups = []
    }
    const approvals = typeof store?.approvalsRecent === 'function' ? store.approvalsRecent(20) : []
    // 人设库只透传元数据；正文按需 GET /api/personas?id=，避免 5s 轮询把全部人设重复传一遍。
    const personas = typeof store?.personaList === 'function' ? store.personaList() : []
    const defaultPersonaId = typeof store?.defaultPersonaId === 'function' ? store.defaultPersonaId() : ''

    // 最近的启动/恢复失败：页面「运行信息 → 最近问题」用。
    // store.meta 里只挑这几个诊断字段，不整包透传（meta 还有主人绑定等，已在 identity 里脱敏展示）。
    let issues = { lastStartError: null, lastResumeError: null, lastResumeSessionId: null, lastIssueAt: null }
    try {
      const meta = typeof store?.snapshot === 'function' ? (store.snapshot()?.meta ?? {}) : {}
      const text = value => (typeof value === 'string' && value.trim() !== '' ? value : null)
      issues = {
        lastStartError: text(meta.lastStartError),
        lastResumeError: text(meta.lastResumeError),
        lastResumeSessionId: text(meta.lastResumeSessionId),
        lastIssueAt: typeof meta.lastIssueAt === 'number' && meta.lastIssueAt > 0 ? meta.lastIssueAt : null,
      }
    } catch {
      /* 诊断字段读取失败不影响页面其它部分 */
    }

    let napcatStatus = null
    if (napcat !== null && napcat !== undefined && typeof napcat.status === 'function') {
      try {
        napcatStatus = await napcat.status()
        napcatStatus.qrStale = typeof napcat.qrStale === 'function' ? napcat.qrStale(napcatStatus.qr) : false
      } catch (error) {
        napcatStatus = { error: error instanceof Error ? error.message : String(error) }
      }
    }
    return {
      version: pluginVersion(),
      pagePath: PAGE_PATH,
      url: url(),
      transport: active,
      mode: (config.transports ?? []).filter(spec => spec.enabled !== false).length > 1 ? 'multi' : active,
      lines: lineStatuses,
      routes,
      identity,
      connections,
      activity,
      usage,
      stickers: stickerState,
      participation: participationState,
      relations: relationState,
      preferences: preferenceState,
      behaviors: Object.fromEntries([...new Set([...chatKeys, ...Object.keys(preferenceState.chats ?? {})])]
        .map(key => [key, store.effectiveBehaviorFor?.(key, 'chat') ?? { aliases: [], activity: 'inherit', source: 'global' }])),
      diagnostics: diagnostics?.snapshot?.() ?? { recent: [] },
      schedules: scheduleState,
      groups,
      memory: { available: Boolean(memory), chats: memory ? Object.fromEntries(chatKeys.map(key => [key, memory.summary(key, modes[key] ?? 'work')])) : {} },
      prompt,
      promptLimit: MAX_PROMPT_CHARS,
      chatKeys,
      modes,
      approvals,
      personas,
      defaultPersonaId,
      personaBindings,
      personaModeBindings,
      personaRecent,
      personaFavorites,
      issues,
      alerts: alerts !== null && alerts !== undefined && typeof alerts.snapshot === 'function' ? alerts.snapshot() : null,
      models,
      napcat: napcatStatus,
      fields: EDITABLE_FIELDS,
      values,
      status,
      config: publicConfig(),
      credentials: { qqbot: qqCredentials !== null, onebotToken },
      paths: {
        dataDir: config.dataDir,
        store: store?.file ?? null,
        groupNotes: `${config.dataDir}/groups`,
        profilePatch: '~/.dsh/profiles/<profile>/cordis.patch.yml',
      },
      stats,
    }
  }

  /**
   * 按模型目录校验 agentOptions：provider 必须存在于 DSH 已配置目录，model 必须属于该 provider。
   * 目录不可用（没有 llm 服务）时直接放行，避免把「服务缺失」误判成「配置非法」。
   * @param {object|null} agentOptions
   * @param {{providers: Array<{id: string, models: Array<{id: string}>}>}|null} catalog
   */
  function validateModelSelection(agentOptions, catalog) {
    if (agentOptions === null || agentOptions === undefined) return
    const providers = Array.isArray(catalog?.providers) ? catalog.providers : []
    if (providers.length === 0) return
    const provider = typeof agentOptions.provider === 'string' ? agentOptions.provider.trim() : ''
    const model = typeof agentOptions.model === 'string' ? agentOptions.model.trim() : ''
    if (provider === '') {
      if (model !== '') throw new TypeError(`还没选 provider，不能只设置模型「${model}」`)
      return
    }
    const hit = providers.find(entry => entry.id === provider)
    if (hit === undefined) {
      throw new TypeError(`未知的 provider：${provider}（下拉里只有 DSH 已配置的；若刚在 DSH 里新增，请刷新页面）`)
    }
    if (model !== '' && !hit.models.some(entry => entry.id === model)) {
      throw new TypeError(`provider ${provider} 下没有模型「${model}」`)
    }
  }

  /**
   * 应用一批配置修改。
   * 先按白名单过滤 + 类型转换，再交给 configEditor：它的 change 回调里跑一次完整的
   * `resolveConfig(candidate)`，校验不过就抛错，configEditor 会中止写入、文件保持原样。
   * @param {object} changes - `{ 'path': value }`
   * @returns {Promise<{ok: boolean, error?: string, applied?: object}>}
   */
  async function applyChanges(changes) {
    if (changes === null || typeof changes !== 'object' || Array.isArray(changes)) {
      return { ok: false, error: 'changes 必须是对象' }
    }
    const editor = ctx.get?.('configEditor')
    const entry = ctx.fiber?.entry
    if (editor === null || editor === undefined || typeof editor.edit !== 'function') {
      return { ok: false, error: '当前部署未挂载 configEditor，无法在线修改配置；请直接编辑 profile 的 cordis.patch.yml' }
    }
    if (entry === undefined || entry === null) {
      return { ok: false, error: '拿不到插件在 profile 里的配置条目，无法定位要改的位置' }
    }

    // 白名单 + 类型转换（未知字段直接忽略，而不是整个请求失败）
    const accepted = []
    for (const [path, raw] of Object.entries(changes)) {
      const field = EDITABLE_FIELDS.find(item => item.path === path)
      // transport / transports 不在字段表里，但属于线路配置，单独放行：
      // - transport：单线路兼容（老配置）；
      // - transports：多线路数组，原样交给 resolveConfig 校验（页面/脚本可用它启用或停用某条线）。
      const isTransport = path === 'transport'
      const isTransports = path === 'transports'
      if (field === undefined && !isTransport && !isTransports) continue
      if (isTransports) {
        accepted.push({ field: { path, type: 'raw', label: 'transports' }, value: raw })
        continue
      }
      const descriptor = field ?? { path, type: 'text', label: 'transport' }
      // 「留空 = 恢复继承」必须在类型转换**之前**判断：number 字段若先转换，'' 会变成 0，
      // 于是被 resolveConfig 拒掉（真机踩过：数字字段没法取消设置）。
      const isEmpty = raw === '' || raw === null || raw === undefined
      accepted.push({ field: descriptor, value: isEmpty ? '' : coerceValue(descriptor, raw) })
    }
    if (accepted.length === 0) return { ok: false, error: '没有可修改的字段' }

    const catalog = await modelCatalog()
    let applied = null
    try {
      await editor.edit(entry, current => {
        const next = structuredClone(current ?? {})
        for (const { field, value } of accepted) {
          // transports 是结构化的线路列表：原样写入（resolveConfig 做完整校验）
          if (field.type === 'raw') {
            if (value === '' || value === null || value === undefined) {
              deletePath(next, field.path)
              pruneEmpty(next, field.path)
            } else {
              setPath(next, field.path, value)
            }
            continue
          }
          // 留空 = 恢复继承：删掉 profile patch 里的这一项，让下层默认值生效
          if (value === '') {
            deletePath(next, field.path)
            pruneEmpty(next, field.path)
            continue
          }
          setPath(next, field.path, value)
        }
        // 完整候选校验：抛错 → configEditor 中止，不落盘（页面会拿到可读原因）
        const resolved = resolveConfig(next)
        validateModelSelection(resolved.agentOptions, catalog)
        applied = next
        return next
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.warn(`dsh-qq: Web 配置写入失败：${message}`)
      return { ok: false, error: message }
    }
    log.info('dsh-qq: Web 配置已写入（configEditor 将触发插件重载）')
    return { ok: true, applied }
  }

  /** 写入凭据（只走 credentials seam；永不回显、也不写进 profile YAML）。 */
  async function applyCredentials(body) {
    const route = String(body?.route ?? '')
    const clear = body?.clear === true
    const credentialsHost = ctx.get?.('credentials')
    if (route === 'qqbot') {
      if (clear) {
        const removed = await clearCredentials(ctx)
        return { ok: true, message: removed ? '已清除官方线凭据。' : '官方线本来就没有本地凭据。' }
      }
      const appId = String(body?.appId ?? '').trim()
      const appSecret = String(body?.appSecret ?? '').trim()
      if (appId === '' || appSecret === '') return { ok: false, error: '官方线需要同时填写 AppID 与 AppSecret' }
      await saveCredentials(ctx, { appId, clientSecret: appSecret })
      return { ok: true, message: '凭据已保存到 DSH credentials（不写配置、不进聊天记录）。', reconnect: true }
    }
    if (route === 'onebot') {
      if (clear) {
        if (credentialsHost === null || credentialsHost === undefined || typeof credentialsHost.unset !== 'function') {
          return { ok: false, error: '当前部署不支持删除凭据' }
        }
        await credentialsHost.unset(ONEBOT_CREDENTIAL_REFS.accessToken)
        return { ok: true, message: '已清除 OneBot access_token。', reconnect: true }
      }
      if (credentialsHost === null || credentialsHost === undefined || typeof credentialsHost.set !== 'function') {
        return { ok: false, error: '当前部署没有 credentials 服务，无法安全保存 token；请改用环境变量 ONEBOT_ACCESS_TOKEN' }
      }
      const accessToken = String(body?.accessToken ?? '').trim()
      if (accessToken === '') return { ok: false, error: '请填写 OneBot access_token' }
      await credentialsHost.set(ONEBOT_CREDENTIAL_REFS.accessToken, accessToken)
      return { ok: true, message: 'access_token 已保存到 DSH credentials。', reconnect: true }
    }
    return { ok: false, error: '未知的线路' }
  }

  /** 身份与授权操作（主人绑定 / 批准 / 拒绝 / 移除授权）。 */
  async function applyIdentity(body) {
    const route = String(body?.route ?? '')
    if (route !== 'qqbot' && route !== 'onebot') return { ok: false, error: '未知的线路' }
    const action = String(body?.action ?? '')
    if (action === 'setHome') {
      const userId = String(body?.userId ?? '').trim()
      await store.setHomeChannel(userId, route)
      return { ok: true, message: userId === '' ? '已清空该线路的主人绑定。' : '主人绑定已更新（立即生效，不用重载）。' }
    }
    if (action === 'approve') {
      const userId = String(body?.userId ?? '').trim()
      if (userId === '') return { ok: false, error: '缺少 userId' }
      await store.addAuthorized(userId, { role: 'authorized', transportKind: route })
      return { ok: true, message: `已批准 ${userId}（${route}）。` }
    }
    if (action === 'deny') {
      const userId = String(body?.userId ?? '').trim()
      const removed = await store.removePendingPairing(userId)
      return { ok: true, message: removed ? `已拒绝 ${userId}。` : '该申请已不存在。' }
    }
    if (action === 'removeAuthorized') {
      const userId = String(body?.userId ?? '').trim()
      const removed = await store.removeAuthorized(userId, route)
      return { ok: true, message: removed ? `已移除授权 ${userId}。` : '该用户本来就没有授权。' }
    }
    return { ok: false, error: '未知的身份操作' }
  }

  /** 动作按钮：登录（扫码）/ 退出登录 / 重连。 */
  async function applyAction(body) {
    const action = String(body?.action ?? '')
    if (control === null || control === undefined) return { ok: false, error: 'control 模块不可用' }
    if (action === 'login') {
      if (typeof control.beginQrLogin !== 'function') return { ok: false, error: '当前版本不支持扫码登录' }
      const began = await control.beginQrLogin()
      if (began.error !== undefined) return { ok: false, error: began.error }
      const hasUrl = began.url !== undefined && began.url !== ''
      return {
        ok: true,
        url: began.url ?? '',
        message: hasUrl ? '请在手机 QQ 里打开链接完成绑定（10 分钟内有效）。' : '登录流程已在进行中。',
      }
    }
    if (action === 'logout') {
      const result = await control.executeWeb('/qq-logout')
      return { ok: true, message: String(result?.reply ?? '已退出登录。') }
    }
    if (action === 'reconnect') {
      const result = await control.executeWeb('/qq-reconnect')
      return { ok: true, message: String(result?.reply ?? '正在重连…') }
    }
    return { ok: false, error: '未知动作' }
  }

  /** NapCat 动作（启动/停止/重启）与二维码读取。 */
  async function applyNapcat(body) {
    if (napcat === null || napcat === undefined) return { ok: false, error: 'NapCat 控制不可用' }
    const action = String(body?.action ?? '')
    const result = await napcat.run(action)
    return result.ok === true ? { ok: true, message: String(result.output ?? '已完成') } : { ok: false, error: String(result.error ?? '执行失败'), output: result.output }
  }

  /** 字体文件（自托管，白名单）。 */
  async function fontBytes(name) {
    const mime = FONT_FILES[name]
    if (mime === undefined) return null
    try {
      return { bytes: await readFile(new URL(`./fonts/${name}`, import.meta.url)), mime }
    } catch {
      return null
    }
  }

  /** CSRF/同源防护：写操作必须带页面请求头；Origin 存在时必须同源。 */
  function guardWrite(req, res) {
    const origin = req.headers.origin
    if (typeof origin === 'string' && origin !== '') {
      try {
        const originHost = new URL(origin).host
        const host = String(req.headers.host ?? '')
        // 有 Origin 就必须同源：拿不到 Host 也拒绝（真实 HTTP 一定有 Host，这里是保守策略）
        if (host === '' || originHost !== host) {
          sendJson(res, 403, { ok: false, error: '跨站请求被拒绝' })
          return false
        }
      } catch {
        sendJson(res, 403, { ok: false, error: 'Origin 不合法' })
        return false
      }
    }
    if (String(req.headers[PANEL_HEADER] ?? '') !== '1') {
      sendJson(res, 403, { ok: false, error: '缺少页面请求标记' })
      return false
    }
    return true
  }

  /** HTTP 处理器：页面 + JSON 端点 + 字体。 */
  async function handler(req, res) {
    try {
      const parsed = new URL(String(req.url ?? '/'), 'http://localhost')
      const pathname = parsed.pathname.replace(/\/+$/, '') || '/'
      const method = String(req.method ?? 'GET')

      if (pathname === PAGE_PATH || pathname === `${PAGE_PATH}/index.html`) {
        if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { ok: false, error: '只支持 GET' })
        if (method === 'HEAD') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          res.end()
          return
        }
        return sendHtml(res, pageHtml())
      }

      // 字体：/dsh-qq/fonts/<name>.woff2（白名单，长缓存）
      if (pathname.startsWith(`${PAGE_PATH}/fonts/`)) {
        const name = pathname.slice(`${PAGE_PATH}/fonts/`.length)
        const font = await fontBytes(name)
        if (font === null) return sendJson(res, 404, { ok: false, error: '字体不存在' })
        res.writeHead(200, {
          'content-type': font.mime,
          'cache-control': 'public, max-age=31536000, immutable',
          'content-length': String(font.bytes.byteLength),
        })
        res.end(font.bytes)
        return
      }

      if (pathname === `${PAGE_PATH}/api/state`) {
        if (method !== 'GET') return sendJson(res, 405, { ok: false, error: '只支持 GET' })
        return sendJson(res, 200, { ok: true, state: await state() })
      }

      if (pathname === `${PAGE_PATH}/api/stickers` && method === 'GET') {
        if (!stickers?.listAll || !stickers?.stats) return sendJson(res, 503, { ok: false, error: '图库不可用' })
        const filter = parsed.searchParams.get('filter') || 'all'
        const requestedPage = Number(parsed.searchParams.get('page') ?? 0)
        const pageSize = Number(parsed.searchParams.get('pageSize') ?? 12)
        const missing = parsed.searchParams.get('missingDescription') ?? '0'
        if (!['all', 'candidate', 'library', 'trash'].includes(filter)
          || !Number.isSafeInteger(requestedPage) || requestedPage < 0
          || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 || !['0', '1'].includes(missing)) {
          return sendJson(res, 400, { ok: false, error: '分页参数不合法' })
        }
        const counts = stickers.stats()
        const missingDescription = missing === '1'
        const total = typeof stickers.countAll === 'function' ? stickers.countAll({ state: filter, missingDescription })
          : Number(counts[filter === 'all' ? 'total' : filter === 'candidate' ? 'candidates' : filter]) || 0
        const page = Math.min(requestedPage, Math.max(0, Math.ceil(total / pageSize) - 1))
        return sendJson(res, 200, { ok: true, filter, page, pageSize, total, missingDescription,
          items: stickers.listAll(pageSize, { state: filter, offset: page * pageSize, missingDescription }) })
      }

      // 表情包图片预览：只读本地图库文件
      if (pathname === `${PAGE_PATH}/api/stickers/image` && method === 'GET') {
        if (stickers === null || stickers === undefined || typeof stickers.itemOf !== 'function') return sendJson(res, 503, { ok: false, error: '图库不可用' })
        const id = String(parsed.searchParams.get('id') ?? '')
        const item = stickers.itemOf(id)
        const file = typeof item === 'object' && item !== null ? stickers.pathOf(id) : null
        if (file === null || file === undefined) return sendJson(res, 404, { ok: false, error: '图片不存在' })
        try {
          const bytes = await readFile(file)
          res.writeHead(200, { 'content-type': item.mime || 'application/octet-stream', 'cache-control': 'no-store', 'content-length': String(bytes.byteLength) })
          res.end(bytes)
        } catch {
          sendJson(res, 404, { ok: false, error: '图片读取失败' })
        }
        return
      }

      // Picker loads on demand; include previously selected IDs even outside the newest 500.
      if (pathname === `${PAGE_PATH}/api/persona-stickers` && method === 'GET') {
        const ids = normalizePersonaStickerIds((parsed.searchParams.get('ids') || '').split(',').filter(Boolean), { strict: true })
        const items = (stickers?.listAll?.(500) ?? []).filter(item => item.state !== 'trash')
        for (const id of ids) {
          if (items.some(item => item.id === id)) continue
          const item = stickers?.itemOf?.(id)
          items.push(item && item.state !== 'trash'
            ? { id, desc: item.desc, tags: item.tags, state: item.state }
            : { id, desc: '已移除的表情', tags: [], state: 'missing', missing: true })
        }
        return sendJson(res, 200, { ok: true, items })
      }

      // Persona bodies are fetched only when an editor is opened.
      if (pathname === `${PAGE_PATH}/api/personas` && method === 'GET') {
        if (typeof store?.personaOf !== 'function') return sendJson(res, 503, { ok: false, error: '人设库不可用' })
        const id = String(parsed.searchParams.get('id') ?? '').trim()
        const persona = id === '' ? null : store.personaOf(id)
        if (persona === null) return sendJson(res, 404, { ok: false, error: '人设不存在' })
        return sendJson(res, 200, { ok: true, persona })
      }

      if (pathname === `${PAGE_PATH}/api/memory` && method === 'GET') {
        if (!memory) return sendJson(res, 503, { ok: false, error: '对话记忆不可用' })
        return sendJson(res, 200, await memory.query(Object.fromEntries(parsed.searchParams)))
      }

      if (pathname === `${PAGE_PATH}/api/groups/note` && method === 'GET') {
        if (groupMemory === null || groupMemory === undefined || typeof groupMemory.readNoteFile !== 'function') {
          return sendJson(res, 400, { ok: false, error: '群记忆不可用（未启用或未装配）' })
        }
        const result = await groupMemory.readNoteFile(parsed.searchParams.get('file') ?? '')
        return sendJson(res, result.ok === true ? 200 : 400, result)
      }

      // NapCat 二维码：直接回 PNG（页面当 <img> 用）
      if (pathname === `${PAGE_PATH}/api/napcat/qr.png`) {
        if (method !== 'GET') return sendJson(res, 405, { ok: false, error: '只支持 GET' })
        const bytes = napcat === null || napcat === undefined ? null : await napcat.qrImage()
        if (bytes === null) return sendJson(res, 404, { ok: false, error: '没有可用的二维码' })
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'content-length': String(bytes.byteLength) })
        res.end(bytes)
        return
      }

      const writeRoutes = {
        [`${PAGE_PATH}/api/memory`]: async body => {
          if (!memory) return { ok: false, error: '对话记忆不可用' }
          if (!['create', 'correct', 'forget', 'pin', 'clear', 'relearn', 'export'].includes(body?.action)) return { ok: false, error: '未知记忆操作' }
          return memory.manage(body)
        },
        [`${PAGE_PATH}/api/growth`]: async body => {
          if (!memory) return { ok: false, error: '对话记忆不可用' }
          if (!['settings', 'lock', 'unlock', 'editHabit', 'resetHabits', 'resetMember', 'resetMood'].includes(body?.action)) return { ok: false, error: '未知成长操作' }
          return memory.manage(body)
        },
        [`${PAGE_PATH}/api/mode`]: async body => {
          const chatKey = String(body?.chatKey ?? '').trim()
          const mode = String(body?.mode ?? '').trim()
          if (chatKey === '') return { ok: false, error: 'chatKey 不能为空' }
          try {
            parseChatKey(chatKey)
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) }
          }
          if (mode !== 'work' && mode !== 'chat') return { ok: false, error: 'mode 必须是 work 或 chat' }
          if (typeof store?.setMode !== 'function') return { ok: false, error: '模式存储不可用' }
          try {
            // 必须走 control（内部会同时切 bridge 的会话）；直接 store.setMode 会只改模式、不隔离上下文。
            if (typeof control?.setMode === 'function') await control.setMode(chatKey, mode)
            else await store.setMode(chatKey, mode)
            return { ok: true, mode }
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) }
          }
        },

        [`${PAGE_PATH}/api/relations`]: async body => {
          const chatKey = String(body?.chatKey ?? '').trim()
          if (chatKey === '') return { ok: false, error: 'chatKey 不能为空' }
          try {
            parseChatKey(chatKey)
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) }
          }
          if (affection === null || affection === undefined) return { ok: false, error: '关系统计不可用' }
          const cleared = await affection.clear(chatKey)
          return cleared ? { ok: true } : { ok: false, error: '该对话没有统计' }
        },

        [`${PAGE_PATH}/api/schedules`]: async body => {
          if (String(body?.action ?? '') !== 'remove') return { ok: false, error: '只支持 remove' }
          const id = String(body?.id ?? '').trim()
          if (id === '') return { ok: false, error: 'id 不能为空' }
          const removed = await store.scheduleRemove(id)
          return removed ? { ok: true } : { ok: false, error: '任务不存在' }
        },

        [`${PAGE_PATH}/api/preferences`]: async body => {
          const chatKey = String(body?.chatKey ?? '').trim()
          if (chatKey === '') return { ok: false, error: 'chatKey 不能为空' }
          try {
            parseChatKey(chatKey)
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) }
          }
          try {
            if (body?.action === 'pause') {
              const minutes = Number.parseInt(body?.minutes ?? '', 10)
              if (!Number.isSafeInteger(minutes) || minutes <= 0) return { ok: false, error: 'minutes 必须是正整数' }
              const until = Date.now() + Math.min(minutes, 7 * 24 * 60) * 60 * 1000
              await store.setChatPreference(chatKey, { proactiveUntil: until })
              return { ok: true, proactiveUntil: until }
            }
            if (body?.action === 'resume') {
              await store.setChatPreference(chatKey, { proactiveUntil: 0 })
              return { ok: true, proactiveUntil: 0 }
            }
            if (body?.action === 'stickers') {
              await store.setChatPreference(chatKey, { stickers: body?.enabled === true })
              return { ok: true, stickers: body?.enabled === true }
            }
            if (body?.action === 'activity') {
              const preference = await store.setChatPreference(chatKey, { activity: normalizeActivity(body.activity, { strict: true }) })
              return { ok: true, preference, behavior: store.effectiveBehaviorFor(chatKey, 'chat') }
            }
            if (body?.action === 'learning' || body?.action === 'emotion') {
              if (!memory) return { ok: false, error: '对话记忆不可用' }
              return memory.manage({ ...body, action: 'settings' })
            }
            return { ok: false, error: `未知偏好操作：${body?.action ?? ''}` }
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) }
          }
        },

        [`${PAGE_PATH}/api/stickers`]: async body => {
          if (body?.action === 'tagPending') {
            if (stickerTagger?.enabled === false || typeof stickerTagger?.tagPending !== 'function') {
              return { ok: false, error: '视觉打标不可用' }
            }
            void stickerTagger.tagPending({ limit: Number(body?.limit) || 20 }).catch(() => {})
            return { ok: true, queued: true }
          }
          if (stickers === null || stickers === undefined) return { ok: false, error: '图库不可用' }
          const action = String(body?.action ?? '')
          const id = String(body?.id ?? '').trim()
          if (id === '') return { ok: false, error: 'id 不能为空' }
          try {
            if (action === 'keep') return { ok: await stickers.promote(id) }
            if (action === 'trash') return { ok: await stickers.trash(id) }
            if (action === 'restore') return { ok: await stickers.restore(id) }
            if (action === 'delete') return { ok: await stickers.remove(id) }
            if (action === 'tag') {
              if (body.desc !== undefined && (typeof body.desc !== 'string' || body.desc.length > 300)) throw new Error('画面描述最多 300 字')
              if (body.tags !== undefined && (!Array.isArray(body.tags) || body.tags.length > 12 || body.tags.some(tag => typeof tag !== 'string' || tag.length > 20))) throw new Error('最多 12 个标签，每个最多 20 字')
              return { ok: await stickers.setMeta(id, { tags: body?.tags, desc: body?.desc }) }
            }
            if (action === 'retag') {
              if (!stickerTagger?.enabled || typeof stickerTagger.tag !== 'function') throw new Error('请先启用视觉自动打标')
              const item = stickers.itemOf(id)
              if (!item || item.state === 'trash') throw new Error('图片不存在或已移入回收站')
              void stickerTagger.tag(id).catch(() => {})
              return { ok: true, queued: true }
            }
            return { ok: false, error: `未知图库操作：${action}` }
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) }
          }
        },

        [`${PAGE_PATH}/api/persona-preview`]: async body => {
          const controller = new AbortController()
          const cancel = () => controller.abort()
          req.once?.('aborted', cancel)
          res.once?.('close', cancel)
          try { return await personaPreview.run(body, { signal: controller.signal }) }
          finally {
            req.removeListener?.('aborted', cancel)
            res.removeListener?.('close', cancel)
          }
        },

        [`${PAGE_PATH}/api/personas`]: body => personaWrite(async () => {
          const action = String(body?.action ?? '').trim()
          if (typeof store?.setPersona !== 'function') return { ok: false, error: '人设库不可用（store 未装配）' }
          try {
            if (action === 'save') {
              const patch = { name: body?.name, text: body?.text }
              if (body.aliases !== undefined) patch.aliases = body.aliases
              if (body.activity !== undefined) patch.activity = body.activity
              if (body?.stickerIds !== undefined) {
                patch.stickerIds = normalizePersonaStickerIds(body.stickerIds, { strict: true })
                const previous = new Set(store.personaOf(body?.id)?.stickerIds ?? [])
                for (const id of patch.stickerIds) {
                  if (previous.has(id)) continue
                  const item = stickers?.itemOf?.(id)
                  if (!item || item.state === 'trash') throw new Error('所选表情不存在或已移入回收站，请刷新图库后重试')
                }
              }
              const persona = await store.setPersona(body?.id, patch)
              return { ok: true, persona }
            }
            if (action === 'delete') {
              if (store.personaOf(body?.id) && memory) await memory.removePersona(body.id)
              const removed = await store.removePersona(body?.id)
              return removed ? { ok: true } : { ok: false, error: '人设不存在' }
            }
            if (action === 'setDefault') {
              const id = await store.setDefaultPersona(body?.id)
              return { ok: true, defaultPersonaId: id }
            }
            if (action === 'favorite') {
              const id = String(body?.id ?? '').trim()
              if (id === '') return { ok: false, error: 'id 不能为空' }
              const favorite = await store.togglePersonaFavorite(id)
              return { ok: true, favorite }
            }
            if (action === 'bind') {
              const chatKey = String(body?.chatKey ?? '').trim()
              const mode = String(body?.mode ?? '').trim()
              if (chatKey === '') return { ok: false, error: 'chatKey 不能为空' }
              if (mode !== '' && mode !== 'work' && mode !== 'chat') return { ok: false, error: 'mode 必须是 work 或 chat' }
              parseChatKey(chatKey)
              const personaId = await store.bindPersona(chatKey, body?.personaId, mode)
              return { ok: true, personaId, mode: mode || 'current' }
            }
            if (action === 'unbind') {
              const chatKey = String(body?.chatKey ?? '').trim()
              const mode = String(body?.mode ?? '').trim()
              if (chatKey === '') return { ok: false, error: 'chatKey 不能为空' }
              if (mode !== '' && mode !== 'work' && mode !== 'chat') return { ok: false, error: 'mode 必须是 work 或 chat' }
              parseChatKey(chatKey)
              const cleared = await store.clearPersonaBinding(chatKey, mode)
              return { ok: true, cleared }
            }
            return { ok: false, error: `未知的人设操作：${action || '（空）'}` }
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) }
          }
        }),

        [`${PAGE_PATH}/api/prompts`]: async body => {
          const chatKey = String(body?.chatKey ?? '').trim()
          const text = String(body?.text ?? '')
          if (chatKey !== '') {
            try {
              parseChatKey(chatKey)
            } catch {
              return { ok: false, error: '对话标识格式不对（应形如 qqbot:AppID:dm:openid 或 onebot:QQ号:group:群号）' }
            }
          }
          try {
            if (chatKey === '') {
              await store.setDefaultPrompt(text)
              return { ok: true, scope: 'default', chars: text.length }
            }
            await store.setChatPrompt(chatKey, text)
            return { ok: true, scope: 'chat', chatKey, chars: text.length }
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) }
          }
        },
        [`${PAGE_PATH}/api/groups/note`]: async body => {
          if (groupMemory === null || groupMemory === undefined || typeof groupMemory.writeNoteFile !== 'function') {
            return { ok: false, error: '群记忆不可用（未启用或未装配）' }
          }
          if (memory && String(body?.file ?? '').endsWith('.chat.md')) return { ok: false, error: '聊天模式群笔记已升级。请在上方对话记忆中选择条目编辑，旧文件保留用于迁移与回退。' }
          return groupMemory.writeNoteFile(body?.file, body?.text)
        },
        [`${PAGE_PATH}/api/test-message`]: async body => {
          const kind = String(body?.kind ?? '').trim()
          const targetKind = String(body?.targetKind ?? 'dm').trim()
          const targetId = String(body?.targetId ?? '').trim()
          const text = String(body?.text ?? '')
          if (text.trim() === '') return { ok: false, error: '消息内容不能为空' }
          if (text.length > 2000) return { ok: false, error: '消息太长（最多 2000 字）' }
          // registry.forKind() 返回的是线路条目 { kind, transport, config }；单 transport 时没有 forKind。
          const entry = typeof transport?.forKind === 'function' ? transport.forKind(kind) : transport
          if (entry === null || entry === undefined) return { ok: false, error: `线路 ${kind || '（空）'} 不存在` }
          const impl = entry.transport !== undefined && entry.transport !== null ? entry.transport : entry
          if (impl === null || impl === undefined || typeof impl.sendText !== 'function') {
            return { ok: false, error: '该线路不支持发送文本' }
          }
          let target = null
          try {
            if (targetKind === 'group') target = { kind: 'group', groupId: targetId }
            else if (targetKind === 'dm') target = { kind: 'dm', userId: targetId }
            else if (targetKind === 'channel') {
              const [guildId, channelId] = targetId.split('/')
              target = { kind: 'channel', guildId: String(guildId ?? ''), channelId: String(channelId ?? '') }
            } else return { ok: false, error: `不支持的目标类型：${targetKind}` }
            target = assertTarget(target)
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) }
          }
          try {
            const sent = await impl.sendText(target, text)
            if (sent !== null && typeof sent === 'object' && sent.ok === false) return { ok: false, error: String(sent.error ?? '发送失败') }
            return { ok: true, messageId: sent?.messageId ?? null }
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) }
          }
        },
        [`${PAGE_PATH}/api/config`]: body => applyChanges(body?.changes),
        [`${PAGE_PATH}/api/credentials`]: body => applyCredentials(body),
        [`${PAGE_PATH}/api/identity`]: body => applyIdentity(body),
        [`${PAGE_PATH}/api/action`]: body => applyAction(body),
        [`${PAGE_PATH}/api/napcat/action`]: body => applyNapcat(body),
        [`${PAGE_PATH}/api/napcat/webui-url`]: async () => {
          if (napcat === null || napcat === undefined || typeof napcat.webuiLinksWithToken !== 'function') {
            return { ok: false, error: 'NapCat 控制不可用' }
          }
          const links = await napcat.webuiLinksWithToken()
          if (links === null || links.preferred === null) return { ok: false, error: '没有可用的 WebUI 地址' }
          return { ok: true, preferred: links.preferred, alternates: links.alternates }
        },
      }
      const write = writeRoutes[pathname]
      if (write !== undefined) {
        if (method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST' })
        if (!guardWrite(req, res)) return undefined
        let body
        try {
          body = await readJsonBody(req, pathname === `${PAGE_PATH}/api/persona-preview` ? 3 * 1024 * 1024 + MAX_BODY_BYTES : MAX_BODY_BYTES)
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
        const result = await write(body)
        // 凭据写入后需要重连才生效（transport 在 start 时解析 token）：这里顺手做掉
        if (result.ok === true && result.reconnect === true && control !== null && typeof control?.executeWeb === 'function') {
          try {
            await control.executeWeb('/qq-reconnect')
          } catch {
            /* 重连失败不影响凭据已保存的事实 */
          }
        }
        const { reconnect, ...payload } = result
        return sendJson(res, result.ok ? 200 : 400, payload)
      }

      return sendJson(res, 404, { ok: false, error: `未知路径：${pathname}` })
    } catch (error) {
      log.warn(`dsh-qq: 控制台请求失败：${error instanceof Error ? error.message : String(error)}`)
      try {
        const status = [400, 403, 404, 409, 500, 503].includes(error?.statusCode) ? error.statusCode : 400
        sendJson(res, status, { ok: false, error: error instanceof Error ? error.message : String(error), code: error?.code })
      } catch {
        /* 响应可能已发出 */
      }
    }
  }

  /** 注册到 webServer（服务缺失时静默降级：控制台不可用但插件照常工作）。 */
  function register() {
    ctx.inject(['webServer'], inner => {
      const server = inner?.webServer
      if (server === undefined || server === null || typeof server.register !== 'function') {
        log.warn('dsh-qq: webServer 服务不可用，Web 控制台未注册（配置仍可改 profile 或 QQ 命令）')
        return () => {}
      }
      webServer = server
      disposeRoute = server.register({ kind: 'prefix', path: PAGE_PATH, handler })
      log.info(`dsh-qq: Web 控制台已注册（${url() ?? PAGE_PATH}）`)
      return () => {
        personaPreview.dispose()
        disposeRoute?.()
        disposeRoute = null
        webServer = null
      }
    })
  }

  return { register, url, state, applyChanges, applyCredentials, applyIdentity, applyAction, applyNapcat, _handler: handler, _pageHtml: pageHtml }
}

// ── 页面 ─────────────────────────────────────────────────────────────
// 自包含 HTML（内联 CSS/JS，字体自托管）：打开即用，不需要构建，也不受 DSH 客户端模块系统影响。

/**
 * 页面 HTML。
 *
 * 从 `lib/page.html` 读取（而不是内联在模块里），这样：
 * - 改页面版式/文案不需要重启 DSH（每次请求重新读文件，模块本身不用重新导入）；
 * - HTML/CSS/JS 可以单独跑 lint/格式化，也不会把几百行模板塞进 JS 字符串里。
 * 文件缺失时退回一句可读的说明而不是抛错（页面挂了不如给个提示）。
 * @returns {string}
 */
function pageHtml() {
  try {
    return readFileSync(new URL('./page.html', import.meta.url), 'utf8')
  } catch (error) {
    return '<!doctype html><meta charset="utf-8"><title>dsh-qq</title><body style="font:14px system-ui;padding:24px">'
      + '控制台页面文件缺失（lib/page.html）：' + String(error?.message ?? error) + '</body>'
  }
}
