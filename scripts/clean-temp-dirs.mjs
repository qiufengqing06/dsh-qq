#!/usr/bin/env node
/**
 * 清理测试遗留的临时目录（`/tmp/dsh-qq-*`）。
 *
 * 测试里大量 `mkdtemp` 不会自动删除（Node 测试运行器不负责清理），本机累计过 1.4 万个目录。
 * 默认 dry-run；加 `--apply` 才真正删除。只匹配 `dsh-qq-` 前缀，避免误删其它进程的临时目录。
 */

import { readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const apply = process.argv.includes('--apply')
const entries = await readdir(tmpdir())
const dirs = []
for (const name of entries) {
  if (!name.startsWith('dsh-qq-')) continue
  const path = join(tmpdir(), name)
  try {
    if ((await stat(path)).isDirectory()) dirs.push(path)
  } catch {
    /* 刚被删掉：跳过 */
  }
}

console.log(`发现 ${dirs.length} 个测试临时目录（${tmpdir()}/dsh-qq-*）`)
if (!apply) {
  console.log('dry-run：加 --apply 才会删除')
  process.exit(0)
}

let removed = 0
for (const dir of dirs) {
  try {
    await rm(dir, { recursive: true, force: true })
    removed += 1
  } catch {
    /* 已被其它进程删除 */
  }
}
console.log(`已删除 ${removed} 个`)
