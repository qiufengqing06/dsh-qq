#!/bin/bash
# 发布前审计（公共仓库专用）
#
# 背景：本项目只发布**官方 QQBot 路线**；三方接入版本仅本地保留（见本地分支 onebot-local）。
# 一次真实的失误促成了这个脚本：曾把 NapCat 写进工作目录的运行库（guild1.db 系列）误传上公共仓库。
# 规则：任何推送前都必须过一遍本脚本，宁可拦住，也不要事后补救。
#
# 用法：
#   bash scripts/prepublish-audit.sh [git-ref]      # 缺省 HEAD
#   SKIP_TESTS=1 bash scripts/prepublish-audit.sh   # 跳过测试（仅紧急时用）
set -u

REF="${1:-HEAD}"
fail=0
pass() { printf '  ✅ %s\n' "$1"; }
bad() { printf '  ❌ %s\n' "$1"; fail=1; }

echo "── 发布前审计（ref=$REF）──"

# 1) 禁止字样：三方 QQ 接入相关的名称一律不得出现
words='napcat|onebot'
hits=$(git grep -inE "$words" "$REF" -- . 2>/dev/null | head -20 || true)
if [ -n "$hits" ]; then
  bad "命中禁止字样（napcat/onebot）："
  printf '%s\n' "$hits" | sed 's/^/      /'
else
  pass "禁止字样：0 处"
fi

# 2) 禁止文件类型/路径：数据库、日志、密钥、凭据、依赖目录一律不得入库
files=$(git ls-tree -r --name-only "$REF")
bad_files=$(printf '%s\n' "$files" | grep -E '\.(db|db-wal|db-shm|log|zst|jsonl|pem|key|p12|pfx)$|(^|/)node_modules/|(^|/)\.env|credentials|store\.v[0-9]+\.json' || true)
if [ -n "$bad_files" ]; then
  bad "命中禁止入库的文件："
  printf '%s\n' "$bad_files" | sed 's/^/      /'
else
  pass "禁止文件类型：0 个"
fi

# 3) 顶层白名单：出现计划外的顶层路径就停下来人工确认
allowed_top='^(lib|test|scripts|\.github|\.gitignore|LICENSE|NOTICE\.md|README\.md|package\.json|cordis\.patch\.yml)'
unexpected=$(printf '%s\n' "$files" | grep -vE "$allowed_top" || true)
if [ -n "$unexpected" ]; then
  bad "出现白名单外的顶层路径："
  printf '%s\n' "$unexpected" | sed 's/^/      /'
else
  pass "顶层路径白名单：通过"
fi

# 4) 敏感内容：密钥/令牌/私钥
secrets=$(git grep -inE 'ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|access_token=[A-Za-z0-9._-]{8,}' "$REF" -- . 2>/dev/null | head -10 || true)
if [ -n "$secrets" ]; then
  bad "疑似密钥/令牌："
  printf '%s\n' "$secrets" | sed 's/^/      /'
else
  pass "敏感内容扫描：通过"
fi

# 5) 本机绝对路径（会泄漏开发机结构与用户名）
paths=$(git grep -inE '/home/[a-z0-9_-]+/|C:\\\\Users\\\\' "$REF" -- . 2>/dev/null | head -10 || true)
if [ -n "$paths" ]; then
  bad "命中本机绝对路径："
  printf '%s\n' "$paths" | sed 's/^/      /'
else
  pass "本机绝对路径：0 处"
fi

# 6) 测试必须全绿
if [ "${SKIP_TESTS:-0}" = "1" ]; then
  printf '  ⚠️  测试：已跳过（SKIP_TESTS=1）\n'
else
  if node --test test/*.test.js >/tmp/prepublish-audit-test.log 2>&1; then
    pass "测试：$(grep -c '^ok ' /tmp/prepublish-audit-test.log) 例全绿"
  else
    bad "测试未通过，详见 /tmp/prepublish-audit-test.log"
  fi
fi

if [ "$fail" = "0" ]; then
  echo "✅ 发布前审计通过：可以推送"
else
  echo "🚫 发布前审计未通过：已阻止本次推送（修好后重来）"
fi
exit "$fail"
