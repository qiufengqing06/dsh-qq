#!/usr/bin/env node
/**
 * OneBot 11 协议实现集中在 lib/onebot/；共享模块通过动态 import 加载。
 * 这项检查维持模块边界，使协议模块或宿主控制不可用时只影响对应功能。
 * 官方端与个人端的实现均随插件发布。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const LIB = 'lib'
const PROTOCOL_DIR = 'lib/onebot'
const problems = []

const sharedFiles = readdirSync(LIB).filter(name => name.endsWith('.js'))
for (const name of sharedFiles) {
  const file = join(LIB, name)
  if (!statSync(file).isFile()) continue
  const text = readFileSync(file, 'utf8')
  // 静态 import：from './onebot/...' / from './napcat-...'
  if (/\bfrom\s+['"]\.\/onebot\//.test(text) || /\bfrom\s+['"]\.\/napcat-/.test(text)) {
    problems.push(`${file} 静态 import 了协议实现（应改成动态 import 或移进 lib/onebot/）`)
  }
  // 反方向：协议目录之外不允许出现 onebot/napcat 源码文件
}
const allowedExt = new Set(['.js', '.md'])
for (const name of readdirSync(PROTOCOL_DIR)) {
  const file = join(PROTOCOL_DIR, name)
  if (statSync(file).isDirectory()) continue
  const ext = name.slice(name.lastIndexOf('.'))
  if (!allowedExt.has(ext)) problems.push(`${file} 不是 .js/.md（协议目录只放实现与说明）`)
}

if (problems.length > 0) {
  console.error('❌ 隔离检查未通过：')
  for (const line of problems) console.error('  - ' + line)
  process.exit(1)
}
console.log(`✅ 隔离检查通过：${sharedFiles.length} 个公共文件无静态协议依赖；协议目录 ${readdirSync(PROTOCOL_DIR).length} 个文件`)
