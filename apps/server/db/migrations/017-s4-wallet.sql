-- ── S4 지갑(선불금·횟수권) — 설계 13 §2·§2-3 ──────────────────────────────────────────────
-- 015(S3)·016(S2 고객)에 의존하지 않는다: 고객·메뉴·예약은 007·008의 (shop_id, id) 고유 키만 참조한다.
-- 같은 017에 다른 기능(문자 등)이 붙어도 이 블록은 그대로 옮길 수 있게 한 덩어리로 둔다.
-- 잔액은 따로 저장하지 않는다 — 삭제 표시가 없는 원장 행의 signed_delta 합계가 잔액이다(음수 허용).

-- 고객 횟수권. 거래의 소유권 검증을 위해 (shop_id, customer_id, id)를 고유 키로 둔다.
CREATE TABLE crm.customer_pass (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES crm.shop (id),
  customer_id uuid NOT NULL,
  name text NOT NULL CHECK (btrim(name) <> ''),
  -- 메뉴 연결은 선택(CSV에 메뉴가 없을 수 있음, 설계 13 §10). 연결하면 발급 당시 메뉴 이름을 서버가 남긴다.
  menu_id uuid,
  menu_name_snapshot text,
  is_primary boolean NOT NULL DEFAULT false,
  -- false = 숨김(삭제 아님). S6 후보에서 빠진다.
  is_active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  CONSTRAINT customer_pass_owner_key UNIQUE (shop_id, customer_id, id),
  CONSTRAINT customer_pass_customer_fk FOREIGN KEY (shop_id, customer_id) REFERENCES crm.customer (shop_id, id),
  CONSTRAINT customer_pass_menu_fk FOREIGN KEY (shop_id, menu_id) REFERENCES crm.menu (shop_id, id),
  CONSTRAINT customer_pass_menu_snapshot CHECK (menu_id IS NULL OR menu_name_snapshot IS NOT NULL)
);

-- 고객당 보이는 대표 횟수권은 최대 하나. 새 대표를 고르면 서버가 같은 트랜잭션에서 기존 대표를 먼저 내린다.
CREATE UNIQUE INDEX customer_pass_one_primary ON crm.customer_pass (shop_id, customer_id)
  WHERE is_primary AND is_active;

-- 지갑 원장. amount = 원 단위 선불금(pass_id 없음), sessions = 횟수(pass_id 필수).
CREATE TABLE crm.wallet_entry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES crm.shop (id),
  customer_id uuid NOT NULL,
  unit_type text NOT NULL CHECK (unit_type IN ('amount', 'sessions')),
  pass_id uuid,
  label text NOT NULL
    CHECK (label IN ('payment', 'deduct', 'opening_balance', 'refund', 'deduct_cancel', 'payment_cancel')),
  signed_delta integer NOT NULL,
  -- S6 완료 차감만 두 값을 함께 쓴다. 수동·CSV 거래는 둘 다 NULL.
  appointment_id uuid,
  cycle_seq integer CHECK (cycle_seq >= 1),
  memo text,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- 직접 수정·소프트 삭제(Sprint 2)용 칸. 지금은 항상 NULL이고, 읽기·합계는 이미 deleted_at IS NULL만 본다.
  deleted_at timestamptz,
  deleted_by uuid,
  before_delete_snapshot_json jsonb,
  UNIQUE (shop_id, id),
  CONSTRAINT wallet_entry_customer_fk FOREIGN KEY (shop_id, customer_id) REFERENCES crm.customer (shop_id, id),
  -- 같은 매장·같은 고객의 횟수권만(MATCH SIMPLE — pass_id가 NULL인 선불금 행은 검사하지 않는다).
  CONSTRAINT wallet_entry_pass_fk FOREIGN KEY (shop_id, customer_id, pass_id)
    REFERENCES crm.customer_pass (shop_id, customer_id, id),
  CONSTRAINT wallet_entry_appointment_fk FOREIGN KEY (shop_id, appointment_id) REFERENCES crm.appointment_m1 (shop_id, id),
  CONSTRAINT wallet_entry_unit_pass CHECK (
    (unit_type = 'amount' AND pass_id IS NULL) OR (unit_type = 'sessions' AND pass_id IS NOT NULL)
  ),
  CONSTRAINT wallet_entry_label_sign CHECK (
    (label IN ('payment', 'refund', 'deduct_cancel') AND signed_delta > 0)
    OR (label IN ('deduct', 'payment_cancel') AND signed_delta < 0)
    OR (label = 'opening_balance' AND signed_delta <> 0)
  ),
  CONSTRAINT wallet_entry_appointment_cycle CHECK ((appointment_id IS NULL) = (cycle_seq IS NULL)),
  CONSTRAINT wallet_entry_delete_fields CHECK (
    deleted_at IS NOT NULL OR (deleted_by IS NULL AND before_delete_snapshot_json IS NULL)
  )
);

-- 잔액 합계(고객·단위·횟수권)와 S6 중복 차감 방지. 회차가 오르면 같은 예약에 새 차감을 남길 수 있다.
CREATE INDEX wallet_entry_balance ON crm.wallet_entry (shop_id, customer_id, pass_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX wallet_entry_one_deduct_per_cycle ON crm.wallet_entry (shop_id, appointment_id, cycle_seq)
  WHERE label = 'deduct' AND deleted_at IS NULL;

-- 010과 같은 함수: UPDATE마다 version + 1, updated_at = 지금.
CREATE TRIGGER customer_pass_next_version BEFORE UPDATE ON crm.customer_pass
  FOR EACH ROW EXECUTE FUNCTION crm.bump_m1_reference_version();
CREATE TRIGGER wallet_entry_next_version BEFORE UPDATE ON crm.wallet_entry
  FOR EACH ROW EXECUTE FUNCTION crm.bump_m1_reference_version();

DO $$
DECLARE
  relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['customer_pass', 'wallet_entry'] LOOP
    EXECUTE format('ALTER TABLE crm.%I ENABLE ROW LEVEL SECURITY', relation);
    EXECUTE format('ALTER TABLE crm.%I FORCE ROW LEVEL SECURITY', relation);
    EXECUTE format(
      'CREATE POLICY shop_scope ON crm.%I
         USING (shop_id = nullif(current_setting(''app.shop_id'', true), '''')::uuid)
         WITH CHECK (shop_id = nullif(current_setting(''app.shop_id'', true), '''')::uuid)',
      relation
    );
    -- 012·014와 같은 방식: AI 실행기는 배정 매장 읽기만, 운영 감독은 모든 매장 읽기만.
    EXECUTE format(
      'CREATE POLICY ai_shop_read ON crm.%I FOR SELECT TO bv_ai_executor
       USING (shop_id = nullif(current_setting(''app.shop_id'', true), '''')::uuid)', relation);
    EXECUTE format('CREATE POLICY supervisor_read ON crm.%I FOR SELECT TO bv_ops USING (true)', relation);
  END LOOP;
END
$$;

-- 앱 역할: 이번 기능에 필요한 칸만. version·시각은 DB가, 삭제 표시 칸은 Sprint 2에서 연다. 물리 삭제 없음.
GRANT SELECT ON crm.customer_pass, crm.wallet_entry TO bv_app, bv_ai_executor, bv_ops;
GRANT INSERT (shop_id, customer_id, name, menu_id, menu_name_snapshot, is_primary) ON crm.customer_pass TO bv_app;
GRANT UPDATE (is_primary) ON crm.customer_pass TO bv_app;
GRANT INSERT (shop_id, customer_id, unit_type, pass_id, label, signed_delta, appointment_id, cycle_seq, memo)
  ON crm.wallet_entry TO bv_app;
