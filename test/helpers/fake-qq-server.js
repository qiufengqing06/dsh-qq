/**
 * 极简假 QQ 服务（执行文档 §8：Fake QQ Server）——让 QQBot transport 的协议行为
 * 可以离线、确定性地测试：token / gateway / watchdog 帧 / REST 发送 / 断线重连。
 *
 * 覆盖的真实协议子集：
 *   POST /app/getAppAccessToken     → { access_token, expires_in }
 *   GET  /gateway                   → { url: ws://…/gateway }
 *   POST /v2/users/:id/messages     → { id }
 *   POST /v2/groups/:id/messages    → { id }
 *   POST /channels/:id/messages     → { id }
 *   WebSocket 帧：op10 hello / op2 identify→READY / op6 resume→RESUMED / op1→op11
 */

import { createServer } from 'node:http'

const json = (res, status, body) => {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) })
  res.end(text)
}

const readBody = req =>
  new Promise(resolve => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      let json = null
      try {
        json = raw.byteLength === 0 ? null : JSON.parse(raw.toString('utf8'))
      } catch {
        json = null
      }
      resolve({ json, raw })
    })
    req.on('error', () => resolve({ json: null, raw: Buffer.alloc(0) }))
  })

/** 一个假 WebSocket：与浏览器 API 同形（addEventListener/send/close/readyState）。 */
class FakeSocket {
  constructor(server) {
    this.server = server
    this.readyState = 1
    this.listeners = new Map()
    this.closed = false
    server.sockets.add(this)
  }

  addEventListener(event, listener) {
    let set = this.listeners.get(event)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener)
  }

  removeEventListener(event, listener) {
    this.listeners.get(event)?.delete(listener)
  }

  emit(event, payload) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      try {
        listener(payload)
      } catch {
        /* ignore */
      }
    }
  }

  /** transport → 服务端的帧。 */
  send(text) {
    if (this.closed) throw new Error('socket closed')
    let frame
    try {
      frame = JSON.parse(String(text))
    } catch {
      frame = { raw: String(text) }
    }
    this.server.frames.push({ socket: this, frame })
    this.server.onFrame(this, frame)
  }

  close(code = 1000, reason = '') {
    if (this.closed) return
    this.closed = true
    this.readyState = 3
    this.server.sockets.delete(this)
    this.emit('close', { code, reason })
  }

  /** 服务端 → transport 的帧。 */
  push(payload) {
    if (this.closed) return
    this.emit('message', { data: JSON.stringify(payload) })
  }

  /** 服务端强制断开（模拟 close code）。 */
  serverClose(code, reason = 'server close') {
    this.close(code, reason)
  }
}

/**
 * 启动假 QQ 服务。
 * @param {object} [options]
 * @param {number} [options.heartbeatIntervalMs] - hello 里给的心跳间隔。
 * @param {boolean} [options.failToken]
 * @param {number} [options.tokenTtlSeconds]
 * @returns {Promise<object>} server 句柄
 */
export async function startFakeQQServer({ heartbeatIntervalMs = 100, failToken = false, tokenTtlSeconds = 7200 } = {}) {
  const state = {
    tokenRequests: 0,
    gatewayRequests: 0,
    rest: [],
    frames: [],
    sockets: new Set(),
    mediaRequests: [],
    uploadPrepare: [],
    parts: [],
    partFinishes: [],
    /** path 前缀 → {status, body} 覆盖 REST 响应 */
    restResponses: new Map(),
    responder: null,
    helloDelayMs: 0,
    socketDelayMs: 5,
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const { json: body, raw: rawBody } = await readBody(req)

    /** 记录请求；若该路径前缀配了响应覆盖（429/500），返回覆盖响应。 */
    const finish = (record, defaultBody) => {
      if (record) state.rest.push({ path: url.pathname, body, headers: req.headers })
      // 测试钩子：按请求体动态决定响应（返回 null 走默认行为）。用于「带 msg_id 才失败」这类条件分支。
      const custom = typeof state.responder === 'function' ? state.responder({ method: req.method, path: url.pathname, body }) : null
      if (custom !== null && custom !== undefined) return json(res, custom.status ?? 200, custom.body ?? {})
      const override = [...state.restResponses.entries()].find(([prefix]) => url.pathname.startsWith(prefix))
      if (override !== undefined) return json(res, override[1].status, override[1].body)
      return json(res, 200, defaultBody)
    }

    if (req.method === 'GET' && url.pathname.startsWith('/media/')) {
      // 媒体下载：必须带 QQBot 鉴权头；?size=?type= 控制字节数与 content-type
      const size = Number(url.searchParams.get('size') ?? 16)
      const type = url.searchParams.get('type') ?? 'image/png'
      state.mediaRequests.push({ path: url.pathname, headers: req.headers, size, type })
      const override = [...state.restResponses.entries()].find(([prefix]) => url.pathname.startsWith(prefix))
      if (override !== undefined) return json(res, override[1].status, override[1].body)
      if (req.headers.authorization === undefined) return json(res, 401, { message: 'missing auth' })
      const payload = Buffer.alloc(Math.max(0, Math.min(size, 5_000_000)), 0x41)
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': payload.length })
      res.end(payload)
      return
    }
    if (url.pathname === '/app/getAppAccessToken') {
      state.tokenRequests += 1
      if (failToken) return json(res, 401, { code: 100007, message: 'invalid appid or secret' })
      const tokenOverride = [...state.restResponses.entries()].find(([prefix]) => url.pathname.startsWith(prefix))
      if (tokenOverride !== undefined) return json(res, tokenOverride[1].status, tokenOverride[1].body)
      return json(res, 200, { access_token: `token-${state.tokenRequests}`, expires_in: tokenTtlSeconds })
    }
    if (url.pathname === '/gateway') {
      state.gatewayRequests += 1
      const override = [...state.restResponses.entries()].find(([prefix]) => url.pathname.startsWith(prefix))
      if (override !== undefined) return json(res, override[1].status, override[1].body)
      return json(res, 200, { url: `${server.wsUrl}` })
    }
    if (req.method === 'POST' && /^\/v2\/(users|groups)\/[^/]+\/upload_prepare$/.test(url.pathname)) {
      const size = Number(body?.file_size ?? 0)
      state.uploadPrepare.push({ path: url.pathname, body })
      const blockSize = Math.max(1, Math.ceil((size || 1) / 3))
      const parts = []
      for (let index = 1; (index - 1) * blockSize < size; index += 1) {
        parts.push({
          part_index: index,
          presigned_url: `${server.baseUrl}/cos/part/${index}`,
          block_size: Math.min(blockSize, size - (index - 1) * blockSize),
        })
      }
      return finish(false, { upload_id: 'up-1', block_size: blockSize, parts, concurrency: 2, retry_timeout: 5 })
    }
    if (req.method === 'PUT' && url.pathname.startsWith('/cos/part/')) {
      const overridePart = [...state.restResponses.entries()].find(([prefix]) => url.pathname.startsWith(prefix))
      state.parts.push({ path: url.pathname, bytes: rawBody.byteLength })
      if (overridePart !== undefined) return json(res, overridePart[1].status, overridePart[1].body)
      res.writeHead(200)
      res.end('')
      return
    }
    if (req.method === 'POST' && /^\/v2\/(users|groups)\/[^/]+\/upload_part_finish$/.test(url.pathname)) {
      state.partFinishes.push(body)
      return finish(false, {})
    }
    if (req.method === 'POST' && /^\/v2\/(users|groups)\/[^/]+\/files$/.test(url.pathname)) {
      // 媒体上传：返回 file_info（真实平台由 QQ 代抓 url 或解析 file_data）
      return finish(true, {
        file_info: body?.upload_id === undefined ? `fi-${state.rest.length + 1}` : `fi-${body.upload_id}`,
        file_uuid: `uuid-${state.rest.length + 1}`,
        ttl: 3600,
      })
    }
    if (req.method === 'POST' && /^\/v2\/(users|groups)\/[^/]+\/messages$/.test(url.pathname)) {
      return finish(true, { id: `msg-${state.rest.length + 1}`, timestamp: Date.now() })
    }
    if (req.method === 'POST' && /^\/channels\/[^/]+\/messages$/.test(url.pathname)) {
      return finish(true, { id: `ch-${state.rest.length + 1}`, timestamp: Date.now() })
    }
    if (req.method === 'PUT' && /^\/interactions\/[^/]+$/.test(url.pathname)) {
      return finish(true, {})
    }
    return json(res, 404, { message: `no route for ${req.method} ${url.pathname}` })
  })

  // 服务端对客户端帧的默认响应（与真实 QQ 网关一致的最小语义）
  const onFrame = (socket, frame) => {
    const { op } = frame
    if (op === 2) {
      socket.push({ op: 0, t: 'READY', s: 1, d: { session_id: 'sess-fake-1', user: { id: 'bot-1' } } })
      return
    }
    if (op === 6) {
      socket.push({ op: 0, t: 'RESUMED', s: 2, d: {} })
      return
    }
    if (op === 1) {
      socket.push({ op: 11, d: null })
    }
  }

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  // 保存原生 close：下面会用同名方法做「断开所有假 socket 再关服务」的包装
  const nativeClose = server.close.bind(server)
  server.baseUrl = `http://127.0.0.1:${port}`
  server.wsUrl = `ws://127.0.0.1:${port}/gateway`
  server.tokenUrl = `${server.baseUrl}/app/getAppAccessToken`
  server.apiBase = server.baseUrl
  server.state = state
  server.sockets = state.sockets
  server.frames = state.frames
  server.onFrame = onFrame

  /** 注入 transport 的 socket 工厂：连接后按 helloDelayMs 推送 op10 hello。 */
  server.socketFactory = async () => {
    const socket = new FakeSocket(server)
    setTimeout(() => {
      socket.emit('open', {})
      setTimeout(() => socket.push({ op: 10, d: { heartbeat_interval: heartbeatIntervalMs } }), state.helloDelayMs)
    }, state.socketDelayMs)
    return socket
  }

  /** 当前活跃 socket（取最新一个）。 */
  server.currentSocket = () => [...state.sockets].at(-1) ?? null

  /** 推送一条 dispatch 事件。 */
  server.pushDispatch = (t, d) => {
    const socket = server.currentSocket()
    if (socket === null) return false
    socket.push({ op: 0, t, s: (state.frames.length % 1000) + 10, d })
    return true
  }

  /** 模拟服务端断开（可指定 close code）。 */
  server.dropSocket = (code = 1006, reason = 'fake drop') => {
    const socket = server.currentSocket()
    if (socket === null) return false
    socket.serverClose(code, reason)
    return true
  }

  /** 测试用：按请求体动态决定响应（返回 null 表示走默认行为）。 */
  server.setResponder = fn => {
    state.responder = typeof fn === 'function' ? fn : null
  }

  /** 覆盖某个 REST 前缀的响应（如 429/500）。 */
  server.setRestResponse = (prefix, { status, body }) => state.restResponses.set(prefix, { status, body })

  /** 最近一次发送到某 path 的请求体。 */
  server.lastRest = pathPrefix =>
    [...state.rest].reverse().find(entry => entry.path.startsWith(pathPrefix)) ?? null

  server.close = async () => {
    for (const socket of [...state.sockets]) socket.serverClose(1000, 'server shutdown')
    await new Promise(resolve => nativeClose(() => resolve()))
  }

  return server
}

export default startFakeQQServer
