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

echo "토큰으로 Claude 호출 확인 중…"
if out="$(CLAUDE_CODE_OAUTH_TOKEN="$token" claude -p "ok라고만 답해" 2>&1)"; then
  printf '%s' "$token" | gh secret set "$name" -R "$REPO"
  echo "✅ $name 등록 완료"
else
  echo "❌ 토큰으로 Claude 호출 실패 — 등록하지 않음. 원인(마지막 5줄):" >&2
  printf '%s\n' "${out//"$token"/[REDACTED]}" | tail -n 5 >&2
  unset token out
  exit 1
fi
unset token out
