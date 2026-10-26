/**
 * 假 NapCat / OneBot 11 服务（测试专用，零依赖）。
 *
 * 为什么自己实现 WS 服务端：`ws` 是我们的**可选**依赖，CI 与本地测试都不安装任何依赖，
 * 所以测试里不能用它。这里用 node:http + node:crypto 手写最小 WebSocket：
 *   - 握手（Sec-WebSocket-Accept）
 *   - 解析客户端帧（必带掩码：文本/关闭/ping/pong，支持分片缓冲）
 *   - 发送服务端帧（不带掩码：文本/ping/关闭）
 * 只覆盖测试需要的语义，够真实（协议交互全部走真 socket）。
 *
 * 覆盖能力对齐一期 `fake-qq-server.js`：
 *   token 鉴权、lifecycle + 心跳、常用 action 应答（echo 回填）、事件注入、
 *   条件故障注入（setResponder）、主动断线、媒体 HTTP 端点。
 */

import { createServer } from 'node:http'
import { createHash } from 'node:crypto'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const OPCODES = { text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa }

/** 编码一个服务端文本帧（无掩码）。 */
function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')
  const length = data.byteLength
  let header
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length])
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  return Buffer.concat([header, data])
}

/** 从缓冲区里尽可能多地解析客户端帧（返回 {frames, rest}）。 */
function decodeFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset]
    const second = buffer[offset + 1]
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
    let cursor = offset + 2
    if (length === 126) {
      if (cursor + 2 > buffer.length) break
      length = buffer.readUInt16BE(cursor)
      cursor += 2
    } else if (length === 127) {
      if (cursor + 8 > buffer.length) break
      length = Number(buffer.readBigUInt64BE(cursor))
      cursor += 8
    }
    let maskKey = null
    if (masked) {
      if (cursor + 4 > buffer.length) break
      maskKey = buffer.subarray(cursor, cursor + 4)
      cursor += 4
    }
    if (cursor + length > buffer.length) break
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length))
    if (maskKey !== null) {
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= maskKey[index % 4]
    }
    frames.push({ opcode, payload })
    offset = cursor + length
  }
  return { frames, rest: buffer.subarray(offset) }
}

/**
 * 启动假 NapCat 服务。
 *
 * @param {object} [options]
 * @param {string} [options.token] - 非空时校验 access_token / Authorization
 * @param {number} [options.selfId] - get_login_info 返回的 QQ 号
 * @param {number} [options.heartbeatIntervalMs] - heartbeat 周期（0 = 不发心跳，用于测超时重连）
 * @param {boolean} [options.sendLifecycle] - 连接后是否推 lifecycle
 * @param {number} [options.messageIdStart] - message_id 起始值
 * @returns {Promise<object>} 服务句柄
 */
export async function startFakeNapCatServer({
  token = '',
  selfId = 10001,
  heartbeatIntervalMs = 1000,
  sendLifecycle = true,
  messageIdStart = 1000,
  versionInfo = { app_name: 'fake-napcat', app_version: '0.0.0-test' },
} = {}) {
  const state = {
    sockets: new Set(),
    /** 收到的 API 调用：{action, params, echo} */
    actions: [],
    /** 发出去的消息：{action, params, echo, messageId} */
    sent: [],
    /** 媒体下载请求 */
    mediaRequests: [],
    /** 注入的事件（便于断言） */
    pushed: [],
    clients: 0,
    handshakeRejections: 0,
    /** get_version_info 的应答（默认伪装成 NapCat；可改成未知实现测降级）。 */
    versionInfo,
    responder: null,
    dropResponses: new Set(),
    responseDelays: new Map(),
    wrongEchoFor: new Set(),
    heartbeatTimer: null,
    nextMessageId: messageIdStart,
    lastSeenUrl: '',
  }

  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  /** 一个已建立的 WS 连接。 */
  const makeConnection = socket => {
    const connection = {
      socket,
      alive: true,
      buffer: Buffer.alloc(0),
      send(payload) {
        if (!connection.alive) return false
        try {
          socket.write(encodeFrame(OPCODES.text, payload))
          return true
        } catch {
          return false
        }
      },
      push(event) {
        state.pushed.push(event)
        return connection.send(JSON.stringify(event))
      },
      close(code = 1000, reason = 'fake close') {
        if (!connection.alive) return
        connection.alive = false
        const reasonBuffer = Buffer.from(reason, 'utf8')
        const payload = Buffer.alloc(2 + reasonBuffer.length)
        payload.writeUInt16BE(code, 0)
        reasonBuffer.copy(payload, 2)
        try {
          socket.write(encodeFrame(OPCODES.close, payload))
          socket.end()
        } catch {
          /* ignore */
        }
        state.sockets.delete(connection)
      },
    }
    state.sockets.add(connection)
    return connection
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${server.address().port}`)

    // 媒体下载端点：/media/<name>?size=&type=   （需要 token 时才校验 Authorization）
    if (req.method === 'GET' && url.pathname.startsWith('/media/')) {
      const auth = String(req.headers.authorization ?? '')
      state.mediaRequests.push({ path: url.pathname, auth, size: url.searchParams.get('size'), type: url.searchParams.get('type') })
      if (token !== '' && !auth.includes(token)) return json(res, 401, { message: 'unauthorized' })
      const size = Number(url.searchParams.get('size') ?? 16)
      const type = url.searchParams.get('type') ?? 'image/png'
      const payload = Buffer.alloc(Math.max(0, Math.min(size, 5_000_000)), 0x42)
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': payload.length })
      res.end(payload)
      return
    }

    json(res, 404, { message: `no route for ${req.method} ${url.pathname}` })
  })

  // ── WebSocket 升级 ────────────────────────────────────────────────
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, `http://127.0.0.1:${server.address().port}`)
    state.lastSeenUrl = req.url
    const key = req.headers['sec-websocket-key']
    const provided = url.searchParams.get('access_token') ?? ''
    const header = String(req.headers.authorization ?? '')
    const authorized =
      token === ''
      || provided === token
      || header === `Bearer ${token}`
      || header === token

    // 真机 NapCat 的行为：握手**不**拦 token，鉴权在请求层做（返回 retcode=1403）。
    // 这里如实复刻，否则测不出「错误 token 时握手成功但所有调用失败」这条真实路径。
    if (!authorized) state.handshakeRejections += 1
    if (typeof key !== 'string' || key === '') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )

    const connection = makeConnection(socket)
    connection.authorized = authorized
    state.clients += 1
    socket.on('data', chunk => {
      connection.buffer = Buffer.concat([connection.buffer, chunk])
      const { frames, rest } = decodeFrames(connection.buffer)
      connection.buffer = rest
      for (const frame of frames) {
        if (frame.opcode === OPCODES.close) {
          connection.alive = false
          state.sockets.delete(connection)
          socket.end()
          return
        }
        if (frame.opcode === OPCODES.ping) {
          socket.write(encodeFrame(OPCODES.pong, frame.payload))
          continue
        }
        if (frame.opcode === OPCODES.pong) continue
        if (frame.opcode !== OPCODES.text) continue
        void handleFrame(connection, frame.payload.toString('utf8'))
      }
    })
    socket.on('error', () => {
      connection.alive = false
      state.sockets.delete(connection)
    })
    socket.on('close', () => {
      connection.alive = false
      state.sockets.delete(connection)
    })

    if (sendLifecycle) connection.push({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect', time: Math.floor(Date.now() / 1000), self_id: selfId })
  })

  /** 处理一次 API 调用（{action, params, echo}）。 */
  async function handleFrame(connection, text) {
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      return
    }
    const action = String(payload?.action ?? '')
    const params = payload?.params !== null && typeof payload.params === 'object' ? payload.params : {}
    const echo = payload?.echo
    state.actions.push({ action, params, echo })
    if (connection.authorized === false) {
      connection.send(JSON.stringify({ status: 'failed', retcode: 1403, data: null, message: 'token验证失败', wording: 'token验证失败', echo }))
      return
    }

    // 故障注入：不回响应（写操作已生效但客户端只看到超时）
    if (state.dropResponses.has(action) || state.dropResponses.has('*')) return
    const custom =
      typeof state.responder === 'function' ? state.responder({ action, params, echo, connection }) : null
    if (custom !== null && custom !== undefined) {
      connection.send(JSON.stringify({ status: custom.status ?? 'failed', retcode: custom.retcode ?? 100, data: custom.data ?? null, message: custom.message ?? '', echo }))
      return
    }

    const reply = (data, { status = 'ok', retcode = 0, message = '' } = {}) => {
      const payloadEcho = state.wrongEchoFor.has(action) ? `${String(echo)}-stale` : echo
      const send = () => connection.send(JSON.stringify({ status, retcode, data, message, wording: message, echo: payloadEcho }))
      const delay = state.responseDelays.get(action) ?? 0
      if (delay > 0) {
        setTimeout(send, delay)
        return
      }
      send()
    }

    switch (action) {
      case 'get_login_info':
        return reply({ user_id: selfId, nickname: 'dsh-qq-fake' })
      case 'get_status':
        return reply({ online: true, good: true })
      case 'get_version_info':
        return reply(state.versionInfo)
      case 'can_send_image':
      case 'can_send_record':
        return reply({ yes: true })
      case 'send_private_msg':
      case 'send_group_msg': {
        const messageId = state.nextMessageId++
        state.sent.push({ action, params, echo, messageId })
        return reply({ message_id: messageId })
      }
      case 'upload_group_file':
      case 'upload_private_file':
        state.sent.push({ action, params, echo, messageId: null })
        return reply({})
      case 'set_input_status':
        state.sent.push({ action, params, echo, messageId: null })
        return reply({})
      case 'set_friend_add_request':
      case 'set_group_add_request':
        state.sent.push({ action, params, echo, messageId: null })
        return reply({})
      case 'get_msg': {
        const fixture = state.messageFixtures?.get(String(params.message_id))
        if (fixture === undefined) return reply(null, { status: 'failed', retcode: 1404, message: '消息不存在' })
        return reply(fixture)
      }
      case 'get_file':
      case 'get_image':
      case 'get_record': {
        const ref = String(params.file ?? '')
        if (ref === '' ) return reply(null, { status: 'failed', retcode: 100, message: 'file 参数缺失' })
        return reply({ file: ref, url: `${server.baseUrl}/media/${encodeURIComponent(ref.replace(/[^\w.-]/g, '_'))}` })
      }
      case 'delete_msg':
        return reply({})
      case 'get_group_member_info':
        return reply({ group_id: Number(params.group_id ?? 0), user_id: Number(params.user_id ?? 0), nickname: `群友${String(params.user_id ?? '')}` })
      default:
        return reply(null, { status: 'failed', retcode: 1404, message: `不支持的 action: ${action}` })
    }
  }

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  // 保存原生 close：下面会用同名方法做「先断开所有假 socket 再关服务」的包装（否则自己调自己）
  const nativeClose = server.close.bind(server)
  const port = server.address().port
  server.baseUrl = `http://127.0.0.1:${port}`
  server.wsUrl = `ws://127.0.0.1:${port}`
  server.state = state
  server.token = token

  if (heartbeatIntervalMs > 0) {
    state.heartbeatTimer = setInterval(() => {
      for (const connection of [...state.sockets]) {
        connection.push({
          post_type: 'meta_event',
          meta_event_type: 'heartbeat',
          status: { online: true, good: true },
          interval: heartbeatIntervalMs,
          time: Math.floor(Date.now() / 1000),
          self_id: selfId,
        })
      }
    }, Math.max(20, Math.floor(heartbeatIntervalMs / 2)))
    if (typeof state.heartbeatTimer.unref === 'function') state.heartbeatTimer.unref()
  }

  /** 当前连接（取最新一个）。 */
  server.currentConnection = () => [...state.sockets].at(-1) ?? null
  /** 推一条任意事件。 */
  server.pushEvent = event => {
    const connection = server.currentConnection()
    if (connection === null) return false
    return connection.push(event)
  }
  /** 推一条消息事件（私聊/群聊）。 */
  server.pushMessage = ({
    messageType = 'private',
    userId = 20002,
    groupId = 30003,
    text = 'ping',
    segments = null,
    messageId = null,
    nickname = '测试用户',
    card = '',
    subType = 'normal',
  } = {}) => {
    const id = messageId ?? state.nextMessageId++
    const message = segments ?? (text === '' ? [] : [{ type: 'text', data: { text } }])
    const event = {
      post_type: 'message',
      message_type: messageType,
      sub_type: subType,
      message_id: id,
      user_id: userId,
      time: Math.floor(Date.now() / 1000),
      self_id: selfId,
      raw_message: message.filter(s => s.type === 'text').map(s => s.data.text).join(''),
      message,
      sender: { user_id: userId, nickname, card },
      ...(messageType === 'group' ? { group_id: groupId } : {}),
    }
    return server.pushEvent(event)
  }
  /** 推一条请求事件（加好友 / 加群）。 */
  server.pushRequest = ({ requestType = 'friend', subType = 'add', userId = 20002, groupId = null, flag = 'flag-1', comment = '你好' } = {}) =>
    server.pushEvent({
      post_type: 'request',
      request_type: requestType,
      sub_type: subType, // OneBot 11：friend=add；group=add（加群）/ invite（被邀请）
      user_id: userId,
      ...(groupId === null ? {} : { group_id: groupId }),
      flag,
      comment,
      time: Math.floor(Date.now() / 1000),
      self_id: selfId,
    })
  /** 条件故障注入（返回 null 走默认应答）。 */
  server.setResponder = fn => {
    state.responder = typeof fn === 'function' ? fn : null
  }
  /**
   * 收到某 action 就记录成功但**不回响应**（unknown-outcome 场景：
   * 服务端已生效、客户端只看到超时）。传 '*' 对所有 action 生效。
   */
  server.dropResponse = action => {
    state.dropResponses.add(String(action))
  }
  server.resumeResponses = () => {
    state.dropResponses.clear()
  }
  /** 某 action 的响应延迟 N 毫秒（测超时/迟到响应）。 */
  server.delayResponse = (action, ms) => {
    state.responseDelays.set(String(action), Number(ms) || 0)
  }
  /** 回一个 echo 不匹配的响应（测旧响应/错配响应不被误用）。 */
  server.wrongEcho = action => {
    state.wrongEchoFor.add(String(action))
  }
  /** 重复推送同一事件（测去重）。 */
  server.duplicateEvent = event => {
    const connection = server.currentConnection()
    if (connection === null) return false
    connection.push(event)
    connection.push(event)
    return true
  }
  /** 注册消息夹具（get_msg 用，测引用文本回填）。 */
  server.setMessageFixture = (messageId, fixture) => {
    if (state.messageFixtures === undefined) state.messageFixtures = new Map()
    state.messageFixtures.set(String(messageId), fixture)
  }
  /** 断开当前连接（测重连）。 */
  server.dropConnection = (code = 1006, reason = 'fake drop') => {
    const connection = server.currentConnection()
    if (connection === null) return false
    connection.close(code, reason)
    return true
  }
  /** 找到某 action 的最近一次调用。 */
  server.lastAction = action => [...state.actions].reverse().find(entry => entry.action === action) ?? null
  server.close = async () => {
    if (state.heartbeatTimer !== null) clearInterval(state.heartbeatTimer)
    for (const connection of [...state.sockets]) connection.close(1000, 'server shutdown')
    await new Promise(resolve => nativeClose(() => resolve()))
  }
  return server
}

export default startFakeNapCatServer
