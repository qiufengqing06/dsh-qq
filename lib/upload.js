/**
 * QQ 官方大文件分片上传（执行文档 P6；行为参照 Hermes chunked_upload.py）。
 *
 * 流程：
 *   ① 计算 md5 / sha1 / md5_10m（前 10MB 的 md5，小文件即全量 md5）
 *   ② POST /v2/{users|groups}/{id}/upload_prepare
 *        {file_type, file_name, file_size, md5, sha1, md5_10m}
 *      → {upload_id, block_size, parts:[{part_index, presigned_url, block_size}], concurrency, retry_timeout}
 *   ③ 逐片 PUT presigned_url（Content-Length 头 + 原始字节）
 *      然后 POST .../upload_part_finish {upload_id, part_index, block_size, md5}
 *   ④ POST /v2/{users|groups}/{id}/files {upload_id} → {file_info}
 *
 * 说明：本模块只依赖注入的 apiRequest（带鉴权的 QQ API 调用）与 fetchImpl（PUT 预签名
 * URL，无需鉴权头），因此在假 QQ 服务上可完整测试；真实平台的并发/重试语义按上面的
 * 协议实现，待真机联调确认（见执行文档 §10 P6 记录）。
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

export const MD5_10M_SIZE = 10 * 1024 * 1024
export const DEFAULT_CONCURRENCY = 4
export const MAX_CONCURRENCY = 8
export const PART_UPLOAD_MAX_RETRIES = 3
export const COMPLETE_MAX_RETRIES = 2
export const COMPLETE_BASE_DELAY_MS = 800

const ok = (extra = {}) => ({ ok: true, ...extra })
const fail = (error, extra = {}) => ({ ok: false, error: String(error), ...extra })

/**
 * 计算分片上传所需的三个摘要。
 * @param {Uint8Array} data
 * @returns {{md5: string, sha1: string, md5_10m: string}}
 */
export function computeFileHashes(data) {
  const buffer = Buffer.from(data)
  const md5 = createHash('md5').update(buffer).digest('hex')
  const sha1 = createHash('sha1').update(buffer).digest('hex')
  const md5_10m = buffer.byteLength > MD5_10M_SIZE
    ? createHash('md5').update(buffer.subarray(0, MD5_10M_SIZE)).digest('hex')
    : md5
  return { md5, sha1, md5_10m }
}

/**
 * 解析 upload_prepare 响应（兼容裸响应与 data 包裹两种形态）。
 * @param {object} raw
 * @returns {{uploadId: string, blockSize: number, parts: Array<object>, concurrency: number, retryTimeoutMs: number}}
 */
export function parsePrepare(raw) {
  const src = raw !== null && typeof raw === 'object' && typeof raw.data === 'object' && raw.data !== null ? raw.data : raw ?? {}
  const uploadId = String(src.upload_id ?? '')
  if (uploadId === '') throw new TypeError(`upload_prepare 缺少 upload_id：${JSON.stringify(raw).slice(0, 200)}`)
  const rawParts = Array.isArray(src.parts) ? src.parts : Array.isArray(src.part_list) ? src.part_list : []
  if (rawParts.length === 0) throw new TypeError(`upload_prepare 缺少 parts：${JSON.stringify(raw).slice(0, 200)}`)
  const parts = rawParts
    .filter(part => part !== null && typeof part === 'object')
    .map(part => ({
      index: Number(part.part_index ?? part.index ?? 0),
      url: String(part.presigned_url ?? part.url ?? ''),
      blockSize: Number(part.block_size ?? 0),
    }))
    .filter(part => part.index > 0 && part.url !== '')
  if (parts.length === 0) throw new TypeError('upload_prepare 的 parts 无法解析') 
  const concurrency = Number(src.concurrency ?? DEFAULT_CONCURRENCY) || DEFAULT_CONCURRENCY
  const retryTimeoutMs = Number(src.retry_timeout ?? 0) > 0 ? Number(src.retry_timeout) * 1000 : 0
  return {
    uploadId,
    blockSize: Number(src.block_size ?? 0),
    parts,
    concurrency: Math.min(Math.max(concurrency, 1), MAX_CONCURRENCY),
    retryTimeoutMs,
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 有界并发执行。 */
async function runWithConcurrency(tasks, concurrency) {
  const limit = Math.max(1, Math.min(concurrency, MAX_CONCURRENCY))
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= tasks.length) return
      await tasks[index]()
    }
  })
  await Promise.all(workers)
}

/**
 * 执行完整的分片上传。
 * @param {object} spec
 * @param {Uint8Array|Buffer} spec.data - 完整文件字节（调用方已按上限校验）。
 * @param {string} spec.fileName
 * @param {number} spec.fileType - QQ file_type（1=图 2=视频 3=语音 4=文件）。
 * @param {'dm'|'group'} spec.targetKind
 * @param {string} spec.targetId
 * @param {(method: string, path: string, body: object) => Promise<object>} spec.apiRequest - 返回 transport 的 {ok, raw} 结构。
 * @param {Function} [spec.fetchImpl]
 * @param {object} [spec.logger]
 * @param {AbortSignal} [spec.signal]
 * @returns {Promise<{ok: boolean, fileInfo?: string, error?: string}>}
 */
export async function chunkedUpload({
  data,
  fileName,
  fileType,
  targetKind,
  targetId,
  apiRequest,
  fetchImpl = globalThis.fetch,
  logger = null,
  signal = undefined,
}) {
  const bytes = Buffer.from(data)
  if (bytes.byteLength === 0) return fail('分片上传需要非空文件')
  const base = targetKind === 'dm' ? '/v2/users' : '/v2/groups'
  const log = {
    info: message => {
      try {
        logger?.info?.(`[upload] ${message}`)
      } catch {
        /* ignore */
      }
    },
    warn: message => {
      try {
        logger?.warn?.(`[upload] ${message}`)
      } catch {
        /* ignore */
      }
    },
  }

  // ① 摘要
  const hashes = computeFileHashes(bytes)

  // ② upload_prepare
  const prepared = await apiRequest('POST', `${base}/${targetId}/upload_prepare`, {
    file_type: fileType,
    file_name: fileName,
    file_size: bytes.byteLength,
    md5: hashes.md5,
    sha1: hashes.sha1,
    md5_10m: hashes.md5_10m,
  })
  if (prepared.ok !== true) return fail(`upload_prepare 失败：${prepared.error}`)
  let plan
  try {
    plan = parsePrepare(prepared.raw)
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
  log.info(`prepare 完成：upload_id=${plan.uploadId} 分片=${plan.parts.length} 并发=${plan.concurrency}`)

  // ③ 逐片 PUT + part_finish
  const failures = []
  const tasks = plan.parts.map(part => async () => {
    if (signal?.aborted === true) return
    const offset = (part.index - 1) * (plan.blockSize > 0 ? plan.blockSize : part.blockSize)
    const declaredSize = part.blockSize > 0 ? part.blockSize : plan.blockSize
    const length = Math.min(declaredSize, bytes.byteLength - offset)
    if (offset < 0 || length <= 0) {
      failures.push(`分片 ${part.index} 越界（offset=${offset} length=${length}）`)
      return
    }
    const chunk = bytes.subarray(offset, offset + length)
    const md5 = createHash('md5').update(chunk).digest('hex')

    let putOk = false
    let lastError = ''
    for (let attempt = 0; attempt <= PART_UPLOAD_MAX_RETRIES; attempt += 1) {
      try {
        const response = await fetchImpl(part.url, {
          method: 'PUT',
          headers: { 'Content-Length': String(chunk.byteLength) },
          body: chunk,
          ...(signal === undefined ? {} : { signal }),
        })
        if (response.ok === true || (response.status >= 200 && response.status < 300)) {
          putOk = true
          break
        }
        lastError = `PUT ${response.status}`
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
      if (attempt < PART_UPLOAD_MAX_RETRIES) await sleep(300 * (attempt + 1))
    }
    if (!putOk) {
      failures.push(`分片 ${part.index} 上传失败：${lastError}`)
      return
    }

    const finished = await apiRequest('POST', `${base}/${targetId}/upload_part_finish`, {
      upload_id: plan.uploadId,
      part_index: part.index,
      block_size: chunk.byteLength,
      md5,
    })
    if (finished.ok !== true) failures.push(`分片 ${part.index} 确认失败：${finished.error}`)
  })

  await runWithConcurrency(tasks, plan.concurrency)
  if (failures.length > 0) return fail(failures.join('；'))
  log.info(`全部分片完成，提交 upload_id=${plan.uploadId}`)

  // ④ complete（/files 带 upload_id），瞬时错误重试
  let lastError = ''
  for (let attempt = 0; attempt <= COMPLETE_MAX_RETRIES; attempt += 1) {
    const completed = await apiRequest('POST', `${base}/${targetId}/files`, { upload_id: plan.uploadId })
    if (completed.ok === true) {
      const fileInfo = completed.raw?.file_info ?? completed.raw?.data?.file_info
      if (fileInfo === undefined || fileInfo === null || fileInfo === '') {
        return fail(`完成上传但未返回 file_info：${JSON.stringify(completed.raw ?? {}).slice(0, 200)}`)
      }
      return ok({ fileInfo })
    }
    lastError = completed.error
    if (attempt < COMPLETE_MAX_RETRIES) await sleep(COMPLETE_BASE_DELAY_MS * 2 ** attempt)
  }
  return fail(`complete_upload 失败：${lastError}`)
}

/**
 * 从本地路径读取文件并做分片上传（大文件主路径）。
 * @param {object} spec
 * @param {string} spec.path
 * @returns {Promise<{ok: boolean, fileInfo?: string, error?: string}>}
 */
export async function chunkedUploadPath({ path, ...rest }) {
  let data
  try {
    data = await readFile(path)
  } catch (error) {
    return fail(`读取本地文件失败：${error instanceof Error ? error.message : String(error)}`)
  }
  return chunkedUpload({ data, ...rest })
}

export default chunkedUpload
