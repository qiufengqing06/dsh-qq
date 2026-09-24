import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'

import { MD5_10M_SIZE, chunkedUpload, computeFileHashes, parsePrepare } from '../lib/upload.js'

const md5 = buffer => createHash('md5').update(buffer).digest('hex')

test('computeFileHashes：md5 / sha1 / md5_10m（小文件 10m 即全量）', () => {
  const small = Buffer.from('hello')
  const hashes = computeFileHashes(small)
  assert.equal(hashes.md5, md5(small))
  assert.equal(hashes.md5_10m, hashes.md5)
  assert.equal(hashes.sha1, createHash('sha1').update(small).digest('hex'))

  const big = Buffer.concat([Buffer.alloc(MD5_10M_SIZE, 0x41), Buffer.alloc(1024, 0x42)])
  const bigHashes = computeFileHashes(big)
  assert.equal(bigHashes.md5, md5(big), 'md5 是全量')
  assert.equal(bigHashes.md5_10m, md5(big.subarray(0, MD5_10M_SIZE)), 'md5_10m 只算前 10MB')
  assert.notEqual(bigHashes.md5_10m, bigHashes.md5)
})

test('parsePrepare：裸响应与 data 包裹都能解析；缺字段抛错', () => {
  const parts = [{ part_index: 1, presigned_url: 'https://cos/1', block_size: 8 }]
  const bare = parsePrepare({ upload_id: 'u1', block_size: 8, parts, concurrency: 99, retry_timeout: 3 })
  assert.equal(bare.uploadId, 'u1')
  assert.equal(bare.parts[0].url, 'https://cos/1')
  assert.equal(bare.concurrency, 8, '并发上限 8')
  assert.equal(bare.retryTimeoutMs, 3000)

  const wrapped = parsePrepare({ data: { upload_id: 'u2', part_list: [{ index: 2, url: 'https://cos/2', block_size: 4 }] } })
  assert.equal(wrapped.uploadId, 'u2')
  assert.equal(wrapped.parts[0].index, 2)
  assert.equal(wrapped.concurrency, 4, '未声明并发用默认值')

  assert.throws(() => parsePrepare({ parts }), /缺少 upload_id/)
  assert.throws(() => parsePrepare({ upload_id: 'u' }), /缺少 parts/)
})

/** 构造一个记录调用的假 apiRequest。 */
function createApiRequest({ prepare, failPrepare = false, failFinishIndex = null, failCompleteTimes = 0 } = {}) {
  const calls = { prepare: 0, finish: [], complete: 0 }
  let completions = 0
  return {
    calls,
    async apiRequest(method, path, body) {
      if (path.endsWith('/upload_prepare')) {
        calls.prepare += 1
        if (failPrepare) return { ok: false, error: 'prepare boom' }
        return { ok: true, raw: prepare }
      }
      if (path.endsWith('/upload_part_finish')) {
        calls.finish.push(body)
        if (failFinishIndex !== null && body.part_index === failFinishIndex) return { ok: false, error: 'finish boom' }
        return { ok: true, raw: {} }
      }
      if (path.endsWith('/files')) {
        calls.complete += 1
        completions += 1
        if (completions <= failCompleteTimes) return { ok: false, error: 'complete transient' }
        return { ok: true, raw: { file_info: `fi-${body.upload_id}` } }
      }
      return { ok: false, error: `unexpected path ${path}` }
    },
  }
}

const prepareFor = (size, blockSize = 4) => ({
  upload_id: 'up-1',
  block_size: blockSize,
  parts: Array.from({ length: Math.ceil(size / blockSize) }, (_, index) => ({
    part_index: index + 1,
    presigned_url: `https://cos/part/${index + 1}`,
    block_size: Math.min(blockSize, size - index * blockSize),
  })),
  concurrency: 2,
  retry_timeout: 1,
})

test('chunkedUpload：prepare → 分片 PUT → part_finish → files{upload_id}', async () => {
  const data = Buffer.from('0123456789AB') // 12 字节 → 3 片（4/4/4）
  const api = createApiRequest({ prepare: prepareFor(data.byteLength, 4) })
  const puts = []
  const result = await chunkedUpload({
    data,
    fileName: 'a.bin',
    fileType: 4,
    targetKind: 'dm',
    targetId: 'u1',
    apiRequest: api.apiRequest,
    fetchImpl: async (url, init) => {
      puts.push({ url, bytes: Buffer.from(init.body).toString(), length: init.headers['Content-Length'] })
      return { ok: true, status: 200 }
    },
    sleep: () => Promise.resolve(),
  })
  assert.deepEqual(result, { ok: true, fileInfo: 'fi-up-1' })
  assert.equal(api.calls.prepare, 1)
  assert.equal(puts.length, 3)
  assert.deepEqual(puts.map(put => put.bytes), ['0123', '4567', '89AB'])
  assert.deepEqual(puts.map(put => put.length), ['4', '4', '4'])
  assert.equal(api.calls.finish.length, 3)
  assert.deepEqual(api.calls.finish[0], { upload_id: 'up-1', part_index: 1, block_size: 4, md5: md5(Buffer.from('0123')) })
  assert.equal(api.calls.complete, 1)
})

test('chunkedUpload：最后一篇短分片长度正确（不越界）', async () => {
  const data = Buffer.from('0123456789') // 10 字节，block 4 → 4/4/2
  const api = createApiRequest({ prepare: prepareFor(data.byteLength, 4) })
  const puts = []
  const result = await chunkedUpload({
    data,
    fileName: 'b.bin',
    fileType: 4,
    targetKind: 'group',
    targetId: 'g1',
    apiRequest: api.apiRequest,
    fetchImpl: async (url, init) => {
      puts.push({ url, bytes: Buffer.from(init.body).toString() })
      return { ok: true, status: 200 }
    },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(puts.map(put => put.bytes), ['0123', '4567', '89'])
  assert.equal(api.calls.finish.length, 3)
})

test('chunkedUpload：prepare 失败 / 分片 PUT 失败 / part_finish 失败 / complete 重试后失败，都如实返回', async () => {
  const data = Buffer.from('01234567')
  const base = { data, fileName: 'c.bin', fileType: 4, targetKind: 'dm', targetId: 'u1' }

  const prepareFail = createApiRequest({ prepare: {}, failPrepare: true })
  const r1 = await chunkedUpload({ ...base, apiRequest: prepareFail.apiRequest, fetchImpl: async () => ({ ok: true }) })
  assert.equal(r1.ok, false)
  assert.match(r1.error, /upload_prepare 失败/)

  const putFail = createApiRequest({ prepare: prepareFor(data.byteLength, 4) })
  const r2 = await chunkedUpload({
    ...base,
    apiRequest: putFail.apiRequest,
    fetchImpl: async () => ({ ok: false, status: 500 }),
  })
  assert.equal(r2.ok, false)
  assert.match(r2.error, /分片 1 上传失败/)

  const finishFail = createApiRequest({ prepare: prepareFor(data.byteLength, 4), failFinishIndex: 2 })
  const r3 = await chunkedUpload({
    ...base,
    apiRequest: finishFail.apiRequest,
    fetchImpl: async () => ({ ok: true, status: 200 }),
  })
  assert.equal(r3.ok, false)
  assert.match(r3.error, /分片 2 确认失败/)

  const completeFail = createApiRequest({ prepare: prepareFor(data.byteLength, 4), failCompleteTimes: 99 })
  const r4 = await chunkedUpload({
    ...base,
    apiRequest: completeFail.apiRequest,
    fetchImpl: async () => ({ ok: true, status: 200 }),
  })
  assert.equal(r4.ok, false)
  assert.match(r4.error, /complete_upload 失败/)
  assert.equal(completeFail.calls.complete, 3, 'complete 应重试 2 次（共 3 次尝试）')

  const empty = await chunkedUpload({ ...base, data: Buffer.alloc(0), apiRequest: prepareFail.apiRequest, fetchImpl: async () => ({ ok: true }) })
  assert.match(empty.error, /非空文件/)
})

test('chunkedUpload：prepare 响应缺 file_info 时如实报错', async () => {
  const api = {
    async apiRequest(method, path, body) {
      if (path.endsWith('/upload_prepare')) return { ok: true, raw: prepareFor(4, 4) }
      if (path.endsWith('/upload_part_finish')) return { ok: true, raw: {} }
      return { ok: true, raw: {} }
    },
  }
  const result = await chunkedUpload({
    data: Buffer.from('abcd'),
    fileName: 'd.bin',
    fileType: 4,
    targetKind: 'dm',
    targetId: 'u1',
    apiRequest: api.apiRequest,
    fetchImpl: async () => ({ ok: true, status: 200 }),
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /未返回 file_info/)
})
