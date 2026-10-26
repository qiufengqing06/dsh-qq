#!/usr/bin/env bash
# 发布完整插件（官方端与个人端）；运行数据、内部文档及凭据不属于发布内容。
# 用法：bash scripts/prepublish-audit.sh [git-ref]，默认 HEAD；始终运行全量测试。
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
REF="${1:-HEAD}"
if ! COMMIT=$(git rev-parse --verify --end-of-options "${REF}^{commit}" 2>/dev/null); then
  printf '❌ 无效的提交引用：%s\n' "$REF" >&2
  exit 1
fi
fail=0
pass() { printf '  ✅ %s\n' "$1"; }
bad() { printf '  ❌ %s\n' "$1" >&2; fail=1; }
aligned() {
  git diff --quiet "$COMMIT" -- && [ -z "$(git ls-files --others --exclude-standard)" ]
}

printf '── 发布前审计（commit=%s）──\n' "$COMMIT"
if ! aligned; then
  bad '被测工作树与候选提交不一致，或存在未追踪文件；请先准备精确候选提交'
  exit 1
fi
pass '被测工作树与候选提交一致'

tests=()
while IFS= read -r -d '' path; do
  # 目录必须完整匹配，文件必须精确匹配，不能放行 lib-backup 或 README.md.bak。
  if [[ "$path" =~ [[:cntrl:]] ]] || ! [[ "$path" =~ ^((lib|test|scripts|\.github)/.+|\.gitignore|LICENSE|NOTICE\.md|README\.md|CHANGELOG\.md|package\.json|cordis\.patch\.yml)$ ]]; then
    bad "白名单外的文件：$path"
  fi
  if [[ "$path" =~ \.(db|db-wal|db-shm|sqlite|sqlite3|log|zst|jsonl|pem|key|p12|pfx)$|(^|/)node_modules/|(^|/)\.env($|\.)|credentials|store\.v[0-9]+\.json$ ]]; then
    bad "不应发布的运行数据或凭据文件：$path"
  fi
  case "$path" in test/*.test.js) tests+=("$path") ;; esac
 done < <(git ls-tree -rz --name-only "$COMMIT")
while IFS= read -r -d '' entry; do
  case "$entry" in
    100644\ *|100755\ *) ;;
    *) bad "不支持发布符号链接或子模块：${entry#*$'\t'}" ;;
  esac
 done < <(git ls-tree -rz "$COMMIT")

scan() {
  local label="$1" pattern="$2" hits status
  if hits=$(git grep -IlE -- "$pattern" "$COMMIT" -- .); then
    bad "$label（仅列文件，避免在日志中复述敏感值）："
    printf '%s\n' "$hits" >&2
  else
    status=$?
    if [ "$status" -eq 1 ]; then pass "$label：0 处"; else bad "$label：扫描失败（$status）"; fi
  fi
}
scan '疑似密钥/令牌/私钥' 'ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|access_token=[A-Za-z0-9._-]{8,}'
scan '开发机绝对路径' '/home/[A-Za-z0-9_.-]+/|/Users/[A-Za-z0-9_.-]+/|[A-Za-z]:\\+Users\\+|/mnt/[a-z]/[Uu]sers/'
if [ "${#tests[@]}" -eq 0 ]; then bad '候选提交中没有测试'; fi
if [ "$fail" -ne 0 ]; then
  printf '🚫 发布内容检查未通过\n' >&2
  exit 1
fi
pass '文件类型与顶层路径检查通过'

test_log=$(mktemp "${TMPDIR:-/tmp}/dsh-qq-publish-test.XXXXXX.log")
if node --test "${tests[@]}" >"$test_log" 2>&1; then
  pass "完整测试通过：$(grep -E '^# (tests|pass|fail|skipped) ' "$test_log" | paste -sd ';' -)"
  rm -f "$test_log"
else
  bad "完整测试失败，详见 $test_log"
fi
if ! aligned; then bad '测试后工作树已改变，不能确认候选提交'; fi
if [ "$fail" -eq 0 ]; then
  printf '✅ 发布前审计通过\n'
else
  printf '🚫 发布前审计未通过\n' >&2
fi
exit "$fail"
