#!/bin/bash
# 发布前审计（公共仓库专用）
#
# 为什么有这个脚本：曾经有一次把不该发布的内容误传上公共仓库（本机运行产生的数据库文件），
# 只能事后补救。规则改成**推送前机械拦一道**：宁可拦住十次，也不要事后补救一次。
#
# 审计项：
#   1. 禁止字样（第三方 QQ 接入相关名称）——清单放在**本地**规则文件里，不写进仓库
#   2. 禁止入库的文件类型：数据库 / 日志 / 密钥 / 凭据 / 依赖目录
#   3. 顶层路径白名单：出现计划外路径就停下来人工确认
#   4. 疑似密钥 / 令牌 / 私钥
#   5. 本机绝对路径（泄漏开发机结构与用户名）
#   6. 全量测试必须全绿
#
# 用法：
#   bash scripts/prepublish-audit.sh [git-ref]        # 缺省 HEAD
#   SKIP_TESTS=1 bash scripts/prepublish-audit.sh      # 跳过测试（仅紧急时用）
# 本地规则文件（不入库）：
#   ~/.dsh-qq-publish-rules   每行一个禁止字样（大小写不敏感；# 开头为注释）
#   可用 DSH_QQ_PUBLISH_RULES 指定其它路径；文件缺失时审计**不通过**（fail closed）
set -u

REF="${1:-HEAD}"
RULES="${DSH_QQ_PUBLISH_RULES:-$HOME/.dsh-qq-publish-rules}"
fail=0
pass() { printf '  ✅ %s\n' "$1"; }
bad() { printf '  ❌ %s\n' "$1"; fail=1; }

echo "── 发布前审计（ref=$REF）──"

# 0) 禁止字样清单（本地文件，不写进仓库；缺失即视为审计未完成）
if [ ! -f "$RULES" ]; then
  bad "缺少禁止字样清单：$RULES（每行一个关键词；没有这份清单审计不算完成）"
else
  WORDS=()
  while IFS= read -r line; do
    case "$line" in ''|'#'*) continue ;; esac
    WORDS+=("$line")
  done < "$RULES"
  if [ "${#WORDS[@]}" -eq 0 ]; then
    bad "禁止字样清单为空：$RULES"
  else
    pattern=$(printf '%s\n' "${WORDS[@]}" | paste -sd'|' -)
    hits=$(git grep -inE "$pattern" "$REF" -- . 2>/dev/null | head -20 || true)
    if [ -n "$hits" ]; then
      bad "命中禁止字样（清单见 $RULES）："
      printf '%s\n' "$hits" | sed 's/^/      /'
    else
      pass "禁止字样：0 处"
    fi
  fi
fi

files=$(git ls-tree -r --name-only "$REF")

# 1) 禁止入库的文件类型 / 路径
bad_files=$(printf '%s\n' "$files" | grep -E '\.(db|db-wal|db-shm|log|zst|jsonl|pem|key|p12|pfx)$|(^|/)node_modules/|(^|/)\.env|credentials|store\.v[0-9]+\.json' || true)
if [ -n "$bad_files" ]; then
  bad "命中禁止入库的文件："
  printf '%s\n' "$bad_files" | sed 's/^/      /'
else
  pass "禁止文件类型：0 个"
fi

# 2) 顶层路径白名单
allowed_top='^(lib|test|scripts|\.github|\.gitignore|LICENSE|NOTICE\.md|README\.md|package\.json|cordis\.patch\.yml)'
unexpected=$(printf '%s\n' "$files" | grep -vE "$allowed_top" || true)
if [ -n "$unexpected" ]; then
  bad "出现白名单外的顶层路径："
  printf '%s\n' "$unexpected" | sed 's/^/      /'
else
  pass "顶层路径白名单：通过"
fi

# 3) 疑似密钥 / 令牌 / 私钥
secrets=$(git grep -inE 'ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|access_token=[A-Za-z0-9._-]{8,}' "$REF" -- . 2>/dev/null | head -10 || true)
if [ -n "$secrets" ]; then
  bad "疑似密钥/令牌："
  printf '%s\n' "$secrets" | sed 's/^/      /'
else
  pass "敏感内容扫描：通过"
fi

# 4) 本机绝对路径
paths=$(git grep -inE '/home/[a-z0-9_-]+/|C:\\\\Users\\\\' "$REF" -- . 2>/dev/null | head -10 || true)
if [ -n "$paths" ]; then
  bad "命中本机绝对路径："
  printf '%s\n' "$paths" | sed 's/^/      /'
else
  pass "本机绝对路径：0 处"
fi

# 5) 测试全绿
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
