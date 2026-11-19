-- C-07 세션(예약) 저장 — 뼈대. 충돌 보장은 packages/scheduling/sql/appointment_conflict.sql(C-05, #20)을 crm 스키마로 옮긴 것이다.
-- 003은 비워 둔다(#29 리뷰: 이미 적용된 004·005 뒤에 003이 실행되는 순서 차이를 피함).
-- 고객·메뉴 스냅샷·메모·담당자 칸은 11/19 명세·스키마 개편을 확인한 뒤 다음 마이그레이션에서 더한다.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE crm.appointment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES crm.shop (id),
  -- 세션 시간. 반열림 [start, end). UTC로 저장한다.
  period tstzrange NOT NULL,
  -- 세션 뒤 준비 시간(분). 기본 10분, 세션마다 바꿀 수 있다(CAL-6).
  prep_minutes integer NOT NULL DEFAULT 10 CHECK (prep_minutes BETWEEN 0 AND 1440),
  -- 점유 구간 = 세션 + 준비 시간(R-3). timestamptz + interval이 IMMUTABLE이 아니라 앱이 계산해 넣고 CHECK로 맞춘다.
  occupied tstzrange NOT NULL,
  -- 동시 최대 2건(R-1)을 DB가 보장하기 위한 내부 자리 번호. 사용자에게 보이지 않는다.
  lane smallint NOT NULL CHECK (lane IN (1, 2)),
  -- 원장이 겹침을 알고 "그대로 저장"했는지(R-4).
  is_forced boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('requested', 'confirmed', 'canceled', 'no_show', 'completed')),
  -- 바뀔 때마다 1씩 올린다. 이후 변경안(ActionProposal)이 제안 시점 버전과 비교한다(ADR-0002).
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  -- 양 끝이 유한해야 한다(NULL·infinity면 자리를 영원히 막는다 — #20 리뷰).
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
  -- 같은 매장·같은 자리에서 확정·완료 예약의 점유 구간은 겹치지 않는다 → 어느 순간에도 최대 2건.
  -- "그대로 저장" 재배정 중 잠깐 겹칠 수 있어 커밋 시점에 검사한다.
  CONSTRAINT appointment_no_overlap_per_lane
    EXCLUDE USING gist (shop_id WITH =, lane WITH =, occupied WITH &&)
    WHERE (status IN ('confirmed', 'completed'))
    DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX appointment_shop_occupied ON crm.appointment USING gist (shop_id, occupied);

-- 예약 변경 이력(R-11, K-2). 지우거나 고치지 않는다.
CREATE TABLE crm.appointment_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  appointment_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('created', 'moved', 'cancel')),
  from_status text,
  to_status text NOT NULL,
  actor text NOT NULL CHECK (actor IN ('owner', 'system', 'external')),
  source text NOT NULL CHECK (source IN ('web', 'voice', 'chat', 'phone', 'import', 'system')),
  -- 바꾸기 전·후 값(시간·준비 시간·강제 저장 여부 등). 개인정보를 넣지 않는다.
  before jsonb,
  after jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shop_id, appointment_id) REFERENCES crm.appointment (shop_id, id)
);
CREATE INDEX appointment_event_appointment ON crm.appointment_event (shop_id, appointment_id, created_at);

ALTER TABLE crm.appointment ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.appointment FORCE ROW LEVEL SECURITY;
CREATE POLICY appointment_scope ON crm.appointment
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);

ALTER TABLE crm.appointment_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.appointment_event FORCE ROW LEVEL SECURITY;
CREATE POLICY appointment_event_scope ON crm.appointment_event
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);

GRANT SELECT, INSERT ON crm.appointment, crm.appointment_event TO bv_app;
GRANT UPDATE (period, prep_minutes, occupied, lane, is_forced, status, version, updated_at) ON crm.appointment TO bv_app;
