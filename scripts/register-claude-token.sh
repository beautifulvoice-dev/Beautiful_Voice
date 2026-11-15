#!/usr/bin/env bash
# 팀원 본인의 Claude 구독 토큰을 AI 리뷰용 GitHub Secret(CLAUDE_TOKEN_<아이디>)으로 등록한다.
# 토큰으로 Claude를 실제 호출해 성공(종료 코드 0)할 때만 등록한다. 토큰은 화면에 출력하지 않는다.
#
# 사용: 대화형 터미널에서 (zsh·bash 모두)
#   bash scripts/register-claude-token.sh <GitHub 아이디>
# 실행 후 프롬프트가 뜨면 `claude setup-token`이 출력한 sk-ant-oat01-… 토큰 한 줄을 붙여넣고 Enter.
# 저장소 Secrets 쓰기 권한(관리자)이 있는 gh 계정으로 실행해야 한다.
set -euo pipefail

REPO="parkganghyun123-sketch/Beautiful_Voice"
login="${1:?사용법: bash scripts/register-claude-token.sh <GitHub 아이디>}"

# 워크플로(.github/workflows/*.yml)의 Secret 이름 규칙과 동일해야 한다.
name="CLAUDE_TOKEN_$(printf '%s' "$login" | tr '[:lower:]' '[:upper:]' | tr -c 'A-Z0-9' '_')"

if [ ! -t 0 ]; then
  echo "❌ 대화형 터미널에서 실행하세요 (앱 대화창의 ! 입력·파이프 입력은 지원하지 않음)." >&2
  exit 1
fi

read -rsp "토큰 붙여넣고 Enter: " token
echo
token="$(printf '%s' "$token" | tr -d '[:space:]')"
echo "길이: ${#token}"

case "$token" in
  sk-ant-oat01-*) ;;
  *) echo "❌ 토큰 형식(sk-ant-oat01-…)이 아닙니다 — 등록하지 않음" >&2; exit 1 ;;
esac
# 잘린 토큰 차단(실제 토큰은 100자 안팎). 검증 호출이 우회되는 환경에서도 마지막 방어선.
if [ "${#token}" -lt 80 ]; then
  echo "❌ 토큰이 너무 짧습니다(${#token}자) — 복사 중 잘린 것으로 보여 등록하지 않음" >&2
  exit 1
fi

echo "토큰으로 Claude 호출 확인 중…"
# 다른 자격증명(API 키 등)이 대신 쓰여 가짜로 통과하지 않도록 해당 환경변수를 제거하고 호출한다.
# (저장된 로그인보다 CLAUDE_CODE_OAUTH_TOKEN이 우선함을 확인: 로그인된 환경에서 잘못된 토큰 → 종료 코드 1)
if out="$(env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN="$token" claude -p "ok라고만 답해" 2>&1)"; then
  printf '%s' "$token" | gh secret set "$name" -R "$REPO"
  echo "✅ $name 등록 완료"
else
  echo "❌ 토큰으로 Claude 호출 실패 — 등록하지 않음. 원인(마지막 5줄):" >&2
  printf '%s\n' "${out//"$token"/[REDACTED]}" | sed -E 's/sk-ant-[A-Za-z0-9_-]+/[REDACTED]/g' | tail -n 5 >&2
  unset token out
  exit 1
fi
unset token out
