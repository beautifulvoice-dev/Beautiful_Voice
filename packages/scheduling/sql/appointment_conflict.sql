-- 예약 충돌의 최종 방어선 (분해표 C-05, CLAUDE.md 절대 규칙 4).
-- 02-architecture §3 "충돌 보장"의 DB 부분만 담는다. 테이블의 나머지 컬럼·`crm` 스키마·shop FK·`(shop_id, id)`·강제 RLS는
-- C-07에서 F-03 마이그레이션 방식(apps/server/db/migrations)에 맞춰 옮긴다.
--
-- 규칙(Linear「[P2] 2. 상세 기능 명세서」11/18): 같은 시간에 겹치는 세션은 매장당 최대 2건(R-1),
-- 세션 뒤 준비 시간(기본 10분, 세션마다 변경 — CAL-6)에는 예약을 받지 않고 겹침 판정에 포함(R-3).
-- 보장: 매장마다 자리(lane) 1·2 각각에서 확정·완료 예약의 점유 구간(세션 + 준비 시간)이 겹치지 않는다
--       → 어느 순간에도 같은 매장의 확정·완료 예약 점유는 최대 2건.
-- 운영 시간·휴무·관리 불가 시간, 일반/그대로 저장 구분은 도메인 서비스(src/conflict.ts)가 저장 직전에 검사한다.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE appointment (
  id uuid PRIMARY KEY,
  shop_id uuid NOT NULL,
  -- 세션(관리 제공) 시간. 반열림 [start, end).
  period tstzrange NOT NULL,
  -- 점유 구간 = 세션 시작 ~ 세션 끝 + 준비 시간. 앱(conflict.ts occupied())이 계산해 넣는다.
  -- 생성 컬럼(GENERATED)으로 만들지 않는 이유: timestamptz + interval은 IMMUTABLE이 아니라 생성 컬럼·제약식에 쓸 수 없다.
  -- 대신 아래 CHECK로 세션과 시작이 같고 끝이 세션 끝 이후인지 강제한다.
  occupied tstzrange NOT NULL,
  -- 동시 최대 2건을 DB가 보장하기 위한 내부 번호. 사용자에게 보이지 않는다.
  lane smallint NOT NULL,
  -- 원장이 겹침을 알고 "그대로 저장"했는지. 이력은 appointment_event에 따로 남긴다.
  is_forced boolean NOT NULL DEFAULT false,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT appointment_lane_check CHECK (lane IN (1, 2)),
  -- 양 끝이 없거나(NULL — 비교식이 NULL이 되어 CHECK를 통과해 버림, 리뷰 #20) 'infinity'면
  -- 끝없는 확정 예약이 그 자리의 이후 예약을 모두 막는다. 양 끝이 유한한 값인지 명시적으로 검사한다.
  CONSTRAINT appointment_period_check CHECK (
    NOT isempty(period) AND NOT lower_inf(period) AND NOT upper_inf(period)
    AND isfinite(lower(period)) AND isfinite(upper(period))
    AND lower_inc(period) AND NOT upper_inc(period)
  ),
  CONSTRAINT appointment_occupied_check CHECK (
    NOT isempty(occupied) AND NOT lower_inf(occupied) AND NOT upper_inf(occupied)
    AND isfinite(lower(occupied)) AND isfinite(upper(occupied))
    AND lower_inc(occupied) AND NOT upper_inc(occupied)
    AND lower(occupied) = lower(period) AND upper(occupied) >= upper(period)
  ),
  -- 요청·확정·취소·노쇼·완료(R-6)
  CONSTRAINT appointment_status_check CHECK (
    status IN ('requested', 'confirmed', 'canceled', 'no_show', 'completed')
  ),
  -- 그대로 저장 재배정 중에는 잠시 겹칠 수 있으므로 커밋 시점에 검사한다.
  CONSTRAINT appointment_no_overlap_per_lane
    EXCLUDE USING gist (shop_id WITH =, lane WITH =, occupied WITH &&)
    WHERE (status IN ('confirmed', 'completed'))
    DEFERRABLE INITIALLY DEFERRED
);
