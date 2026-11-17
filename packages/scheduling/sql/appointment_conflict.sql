-- 예약 충돌의 최종 방어선 (P2-04, 분해표 C-05, CLAUDE.md 절대 규칙 4).
-- 02-architecture §3 "충돌 보장"의 DB 부분만 담는다. 테이블의 나머지 컬럼·복합 FK·강제 RLS는
-- 공통 DB 기반(F-03, ADR-0003)의 마이그레이션에서 합친다. 마이그레이션 도구는 S4에서 확정(ADR-0006).
--
-- 보장: 매장마다 자리(lane) 1·2 각각에서 확정·완료 예약 구간이 겹치지 않는다
--       → 어느 순간에도 같은 매장의 확정·완료 예약은 최대 2건(PD-11).
-- 영업시간·휴무·임시 차단, 일반/강제 저장 구분은 도메인 서비스(src/conflict.ts)가 저장 직전에 검사한다.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE appointment (
  id uuid PRIMARY KEY,
  shop_id uuid NOT NULL,
  -- 시술 시간만. 준비·정리 시간은 넣지 않는다(PD-13). 반열림 [start, end).
  period tstzrange NOT NULL,
  -- 동시 최대 2건을 DB가 보장하기 위한 내부 번호. 사용자에게 보이지 않는다.
  lane smallint NOT NULL,
  -- 원장이 겹침을 알고 강제 저장했는지. 이력은 appointment_event에 따로 남긴다.
  is_forced boolean NOT NULL DEFAULT false,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT appointment_lane_check CHECK (lane IN (1, 2)),
  CONSTRAINT appointment_period_check CHECK (
    NOT isempty(period) AND lower_inc(period) AND NOT upper_inc(period)
    AND lower(period) IS NOT NULL AND upper(period) IS NOT NULL
  ),
  -- 요청·확정·취소·노쇼·완료(PD-17)
  CONSTRAINT appointment_status_check CHECK (
    status IN ('requested', 'confirmed', 'canceled', 'no_show', 'completed')
  ),
  -- 강제 저장 재배정 중에는 잠시 겹칠 수 있으므로 커밋 시점에 검사한다.
  CONSTRAINT appointment_no_overlap_per_lane
    EXCLUDE USING gist (shop_id WITH =, lane WITH =, period WITH &&)
    WHERE (status IN ('confirmed', 'completed'))
    DEFERRABLE INITIALLY DEFERRED
);
