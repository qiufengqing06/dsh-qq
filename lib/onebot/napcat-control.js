/**
 * NapCat（个人 QQ 线宿主）控制：状态探测、登录二维码、启动/停止。
 *
 * 为什么需要：个人线的「登录」发生在 NapCat 这个宿主进程里（扫码），插件本身摸不到 QQ 的登录界面。
 * 之前只能让用户去终端跑 `~/napcat-ctl.sh qr`；现在把这些操作收进 Web 控制台：
 * - 状态：6099（WebUI，说明进程在跑）、3001（OneBot WS，说明已登录）都能用 TCP 探测；
 * - 二维码：NapCat 未登录时会把登录码写到 `cache/qrcode.png`，插件读出来直接给页面当图片；
 * - 启停：调用户配置的 `napcat.ctlScript`（约定支持 start/stop/restart/qr 子命令）。
 *
 * 安全边界：
 * - 只允许固定动作白名单（start/stop/restart），脚本路径来自配置、**不接受页面传参**；
 * - 不拼接 shell 字符串（execFile + 参数数组），超时后杀掉；
 * - 二维码只读配置里指定的那一个文件。
 */

import { execFile as execFileCallback } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { connect } from 'node:net'
import { homedir, networkInterfaces as interfaces } from 'node:os'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)

/** 允许通过控制台执行的 NapCat 动作。 */
export const NAPCAT_ACTIONS = Object.freeze(['start', 'stop', 'restart'])

/** 二维码有效期（NapCat 约 2 分钟刷新一次）。 */
const QR_TTL_MS = 3 * 60 * 1000

/** 把 `~/xxx` 展开成绝对路径（配置里常这么写）。 */
function expandHome(value) {
  const text = String(value ?? '').trim()
  if (text === '') return ''
  if (text === '~') return homedir()
  if (text.startsWith('~/')) return `${homedir()}/${text.slice(2)}`
  return text
}

/** TCP 探测：能连上就算在监听。 */
function probePort(port, timeoutMs = 400) {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port })
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs - 20)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/** 回环主机名：这些地址在浏览器里指向「打开页面的那台机器」，跨 WSL/Windows 时不可靠。 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** 非回环 IPv4 地址（WSL 里通常是 eth0，Windows 浏览器用它可以访问 WSL 服务）。 */
function localAddresses() {
  const out = []
  try {
    for (const addrs of Object.values(interfaces() ?? {})) {
      for (const entry of addrs ?? []) {
        if (entry.family === 'IPv4' && entry.internal !== true && typeof entry.address === 'string') out.push(entry.address)
      }
    }
  } catch {
    /* 忽略：探测不到就用空列表，链接退化为 localhost */
  }
  return out
}

/**
 * 把配置里的 WebUI 地址整理成「浏览器点开就能用」的链接。
 *
 * 真机（2026-10-22）：WSL 里 NapCat 监听 `::6099`，Windows 的 wslrelay 只转发 **IPv6 回环**，
 * 于是浏览器点 `http://127.0.0.1:6099` 直接 ERR_CONNECTION_REFUSED；而 `localhost`（先解析到 ::1）
 * 与 WSL IP（172.x）都能通。另外 NapCat WebUI 需要 token，而配置里通常只写了 `http://127.0.0.1:6099`。
 *
 * 规则：
 * - 配置里是回环地址 → 首选 `localhost`（Windows/WSL 都能用），并列给出 WSL IP 与 127.0.0.1；
 * - 配置里是非回环地址（局域网主机名等）→ 原样作为首选，回环地址作为备选；
 * - 路径补成 `/webui`，没有 token 时从 webui.json 读到的 token 追加进去（已有则不重复）。
 * @param {object} input
 * @param {string} [input.configuredUrl] - 配置里的 `napcat.webuiUrl`（可能为空、可能已带 token）
 * @param {string} [input.token] - webui.json 里的 token（读不到时为空串）
 * @param {number} [input.port] - webui.json 里的端口（配置没写地址时使用）
 * @param {string[]} [input.addresses] - 非回环 IPv4 列表
 * @returns {{preferred: string|null, alternates: Array<{label: string, url: string}>}}
 */
export function buildWebuiLinks({ configuredUrl = '', token = '', port = 6099, addresses = [] } = {}) {
  const raw = String(configuredUrl ?? '').trim()
  let base = null
  if (raw !== '') {
    try {
      base = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`)
    } catch {
      base = null
    }
  }
  if (base === null) {
    base = new URL(`http://127.0.0.1:${Number.isFinite(port) && port > 0 ? port : 6099}`)
  }
  const scheme = base.protocol === 'https:' ? 'https' : 'http'
  const resolvedPort = base.port !== '' ? base.port : '6099'
  const pathname = base.pathname === '' || base.pathname === '/' ? '/webui' : base.pathname
  const loopback = LOOPBACK_HOSTS.has(base.hostname.toLowerCase())

  /** 在指定 hostname 上生成同一份链接（token 已存在则保留）。 */
  const makeUrl = hostname => {
    const url = new URL(`${scheme}://${hostname}:${resolvedPort}${pathname}`)
    const existing = base.searchParams.get('token')
    const effectiveToken = existing !== null && existing !== '' ? existing : String(token ?? '').trim()
    if (effectiveToken !== '') url.searchParams.set('token', effectiveToken)
    for (const [key, value] of base.searchParams) if (key !== 'token') url.searchParams.set(key, value)
    return url.toString()
  }

  const candidates = []
  if (loopback) {
    candidates.push({ label: '本机', url: makeUrl('localhost') })
    for (const address of addresses) candidates.push({ label: `WSL IP（${address}）`, url: makeUrl(address) })
    candidates.push({ label: '127.0.0.1', url: makeUrl('127.0.0.1') })
  } else {
    candidates.push({ label: '配置地址', url: makeUrl(base.hostname) })
    candidates.push({ label: '本机', url: makeUrl('localhost') })
    for (const address of addresses) candidates.push({ label: `本机 IP（${address}）`, url: makeUrl(address) })
  }
  // 去重（保留第一个标签）
  const seen = new Set()
  const uniq = []
  for (const entry of candidates) {
    if (seen.has(entry.url)) continue
    seen.add(entry.url)
    uniq.push(entry)
  }
  return { preferred: uniq[0]?.url ?? null, alternates: uniq.slice(1) }
}

/** 从 webui.json 读取 token / 端口（读不到就返回空，不影响页面其它部分）。 */
async function readWebuiSettings(readFileImpl, qrFilePath) {
  const empty = { token: '', port: 6099 }
  if (qrFilePath === '') return empty
  const dir = qrFilePath.slice(0, qrFilePath.lastIndexOf('/'))
  if (dir === '') return empty
  const configPath = `${dir}/../config/webui.json`
  try {
    const text = await readFileImpl(configPath, 'utf8')
    const parsed = JSON.parse(text)
    const token = typeof parsed?.token === 'string' ? parsed.token.trim() : ''
    const port = Number(parsed?.port)
    return { token, port: Number.isFinite(port) && port > 0 ? port : 6099 }
  } catch {
    return empty
  }
}

/**
 * 创建 NapCat 控制器。
 * @param {object} deps
 * @param {object} deps.config - resolveConfig 结果（用其中的 `napcat` 段）。
 * @param {object} [deps.logger]
 * @param {object} [deps.override] - 测试钩子：{ readFile, stat, probePort, execFile, now }
 * @returns {object} 控制器
 */
export function createNapcatControl({ config, logger = null, override = {} }) {
  const settings = config.napcat ?? {}
  /** OneBot WS 端点（用于推断端口：用户可能把 wsUrl 改到 3002 或另一台机器）。 */
  const onebotEndpoint = (() => {
    try {
      const url = new URL(String(config.onebot?.wsUrl ?? ''))
      return { host: url.hostname, port: Number(url.port) || (url.protocol === 'wss:' ? 443 : 80) }
    } catch {
      return null
    }
  })()
  const onebotPort = onebotEndpoint?.port ?? 3001
  const ctlScript = expandHome(settings.ctlScript)
  const qrFile = expandHome(settings.qrFile)
  const webuiUrl = String(settings.webuiUrl ?? '').trim()
  /** 配置里的 WebUI 端口（用户可能把 NapCat WebUI 改到 7000 等）；空配置回落 webui.json。 */
  const configuredWebuiPort = (() => {
    if (webuiUrl === '') return null
    try {
      const url = new URL(webuiUrl)
      return Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
    } catch {
      return null
    }
  })()
  const enabled = settings.enabled !== false

  /** 最近一次从 webui.json 读到的 token（不在 GET state 里回显）。 */
  let webuiToken = ''

  /** 状态缓存：页面 5s 轮询一次，没必要每次都读盘 + 两次 TCP 探测。 */
  let statusCache = null
  let statusCacheAt = 0
  const STATUS_TTL_MS = 4000
  /** 端口探测退避：连不上时 20 秒内不重复探测（NapCat 没起时不空转）。 */
  const probeCache = new Map()

  /** 带缓存的 TCP 探测（open 缓存 4s、closed 缓存 20s）。 */
  async function probeCached(port, probeImpl) {
    const at = Date.now()
    const hit = probeCache.get(port)
    if (hit !== undefined && at - hit.at < (hit.open ? 4000 : 20_000)) return hit.open
    const open = await probeImpl(port)
    probeCache.set(port, { at, open })
    return open
  }

  const readFileImpl = override.readFile ?? readFile
  const statImpl = override.stat ?? stat
  const probePortImpl = override.probePort ?? probePort
  const execFileImpl = override.execFile ?? execFile
  const now = override.now ?? (() => Date.now())

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

  /** 二维码文件信息（存在性 + 生成时间）。 */
  async function qrInfo() {
    if (qrFile === '') return { configured: false, available: false, updatedAt: 0, ageMs: null }
    try {
      const info = await statImpl(qrFile)
      const ageMs = Math.max(0, now() - Number(info.mtimeMs ?? 0))
      return { configured: true, available: true, updatedAt: Number(info.mtimeMs ?? 0), ageMs }
    } catch {
      return { configured: true, available: false, updatedAt: 0, ageMs: null }
    }
  }

  /** 当前状态（页面每几秒轮询一次）。 */
  async function status() {
    const readFileImpl = override.readFile ?? readFile
    const webuiSettings = await readWebuiSettings(readFileImpl, qrFile)
    webuiToken = webuiSettings.token
    // GET /api/state 的链接不带 token（M2）；带 token 的版本只走 POST /api/napcat/webui-url
    const links = buildWebuiLinks({
      configuredUrl: webuiUrl,
      token: '',
      port: webuiSettings.port,
      addresses: localAddresses(),
    })
    if (!enabled) {
      return {
        enabled: false,
        running: false,
        loggedIn: false,
        onebotListening: false,
        webuiReachable: false,
        qr: { configured: false, available: false, updatedAt: 0, ageMs: null },
        ctlConfigured: false,
        webuiUrl: links.preferred,
        webui: links,
      }
    }
    const now = Date.now()
    if (statusCache !== null && now - statusCacheAt < STATUS_TTL_MS) return statusCache
    // 端口按实际配置推断：写死 6099 会在自定义 WebUI 端口时误报「未运行」
    const webuiPort = configuredWebuiPort ?? webuiSettings.port
    const [onebotListening, webuiReachable, qr] = await Promise.all([
      probeCached(onebotPort, probePortImpl),
      probeCached(webuiPort, probePortImpl),
      qrInfo(),
    ])
    const result = {
      enabled: true,
      // WebUI 在监听 = NapCat 进程活着；OneBot 端口在监听 = 已登录（两者都可能是“正在登录中”）
      running: onebotListening || webuiReachable,
      loggedIn: onebotListening,
      onebotListening,
      webuiReachable,
      qr,
      ctlConfigured: ctlScript !== '',
      // 不在 GET /api/state 里回显带 token 的 WebUI 链接（M2）：需要 token 时走 POST 专门端点
      webuiUrl: links.preferred,
      webui: links,
      webuiTokenConfigured: webuiToken !== '',
    }
    statusCache = result
    statusCacheAt = now
    return result
  }

  /**
   * 带 token 的 WebUI 链接（只给 POST /api/napcat/webui-url 用，不放进 GET state）。
   * @returns {Promise<{preferred: string|null, alternates: Array<object>}|null>}
   */
  async function webuiLinksWithToken() {
    if (!enabled) return null
    const readFileImpl = override.readFile ?? readFile
    const webuiSettings = await readWebuiSettings(readFileImpl, qrFile)
    const token = webuiSettings.token !== '' ? webuiSettings.token : webuiToken
    return buildWebuiLinks({
      configuredUrl: webuiUrl,
      token,
      port: webuiSettings.port,
      addresses: localAddresses(),
    })
  }

  /** 读二维码 PNG 字节（未配置/文件不存在时返回 null）。 */
  async function qrImage() {
    if (qrFile === '') return null
    try {
      return await readFileImpl(qrFile)
    } catch {
      return null
    }
  }

  /**
   * 执行一个 NapCat 动作（start/stop/restart）。
   * @param {string} action
   * @returns {Promise<{ok: boolean, output?: string, error?: string}>}
   */
  async function run(action) {
    const verb = String(action ?? '')
    if (!enabled) return { ok: false, error: 'NapCat 面板已在配置里关闭（napcat.enabled: false）' }
    if (!NAPCAT_ACTIONS.includes(verb)) return { ok: false, error: `不支持的动作：${verb || '（空）'}` }
    if (ctlScript === '') return { ok: false, error: '未配置 napcat.ctlScript，无法从这里启停 NapCat' }
    try {
      const { stdout = '', stderr = '' } = await execFileImpl('bash', [ctlScript, verb], { timeout: 90_000 })
      const output = `${String(stdout)}${String(stderr)}`.trim().slice(-2000)
      log.info(`dsh-qq: NapCat ${verb} 完成：${output.slice(0, 200)}`)
      return { ok: true, output }
    } catch (error) {
      const output = `${String(error?.stdout ?? '')}${String(error?.stderr ?? '')}`.trim().slice(-2000)
      log.warn(`dsh-qq: NapCat ${verb} 失败：${error instanceof Error ? error.message : String(error)}`)
      return { ok: false, error: error instanceof Error ? error.message : String(error), output }
    }
  }

  return {
    status,
    qrImage,
    run,
    webuiLinksWithToken,
    /** 二维码是否超过通常有效期（页面提示“可能已过期，刷新一下”）。 */
    qrStale: info => info?.available === true && info.ageMs !== null && info.ageMs > QR_TTL_MS,
    /** 配置里声明的路径（只读展示用）。 */
    paths: { ctlScript, qrFile, webuiUrl },
  }
}
