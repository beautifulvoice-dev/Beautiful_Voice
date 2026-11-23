-- BEA-179 캘린더 차단(관리 불가 시간). 설계 09 D1·D3·D6. 예약 쪽 검사는 서버의 공통 매장 잠금 + checkBooking(D4, 주드 확인 대기).
CREATE TABLE crm.calendar_block (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES crm.shop (id),
  start_at timestamptz NOT NULL CHECK (isfinite(start_at)),
  end_at timestamptz NOT NULL CHECK (isfinite(end_at)),
  -- 매장 전체면 연결 행 0개(이후 추가되는 담당자 포함), 지정이면 1개 이상 — 아래 지연 제약 트리거가 커밋 직전에 확인한다.
  all_staff boolean NOT NULL,
  memo text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  created_source text NOT NULL DEFAULT 'manual' CHECK (created_source IN ('manual', 'voice_task')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  CONSTRAINT calendar_block_period CHECK (start_at < end_at)
);

-- 활성 차단의 매장·기간 조회(btree_gist는 006에서 켰다).
CREATE INDEX calendar_block_active_period ON crm.calendar_block
  USING gist (shop_id, tstzrange(start_at, end_at, '[)')) WHERE status = 'active';

CREATE TABLE crm.calendar_block_staff (
  shop_id uuid NOT NULL,
  block_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  PRIMARY KEY (shop_id, block_id, staff_id),
  CONSTRAINT calendar_block_staff_block_fk FOREIGN KEY (shop_id, block_id) REFERENCES crm.calendar_block (shop_id, id),
  CONSTRAINT calendar_block_staff_staff_fk FOREIGN KEY (shop_id, staff_id) REFERENCES crm.staff (shop_id, id)
);

-- 수정마다 version·수정 시각을 올리고, 제거된 차단은 다시 바꾸지 못한다(제거는 active → removed 한 번, 설계 09 Q5).
CREATE FUNCTION crm.calendar_block_next_version() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.status = 'removed' THEN
    RAISE EXCEPTION 'removed calendar block cannot change' USING ERRCODE = '23514', CONSTRAINT = 'calendar_block_removed_final';
  END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION crm.calendar_block_next_version() FROM PUBLIC;
CREATE TRIGGER calendar_block_next_version BEFORE UPDATE ON crm.calendar_block
  FOR EACH ROW EXECUTE FUNCTION crm.calendar_block_next_version();

-- 대상 정합성: 전체 = 연결 0, 지정 = 연결 1 이상. 부모·연결 어느 쪽이 바뀌어도 커밋 직전 최종 상태로 본다.
CREATE FUNCTION crm.check_calendar_block_targets() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  target_shop uuid;
  target_block uuid;
  everyone boolean;
  linked integer;
BEGIN
  IF TG_TABLE_NAME = 'calendar_block' THEN
    target_shop := NEW.shop_id;
    target_block := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    target_shop := OLD.shop_id;
    target_block := OLD.block_id;
  ELSE
    target_shop := NEW.shop_id;
    target_block := NEW.block_id;
  END IF;
  SELECT all_staff INTO everyone FROM crm.calendar_block WHERE shop_id = target_shop AND id = target_block;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT count(*) INTO linked FROM crm.calendar_block_staff WHERE shop_id = target_shop AND block_id = target_block;
  IF (everyone AND linked > 0) OR (NOT everyone AND linked = 0) THEN
    RAISE EXCEPTION 'calendar block targets do not match all_staff' USING ERRCODE = '23514', CONSTRAINT = 'calendar_block_targets';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION crm.check_calendar_block_targets() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER calendar_block_targets AFTER INSERT OR UPDATE ON crm.calendar_block
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION crm.check_calendar_block_targets();
CREATE CONSTRAINT TRIGGER calendar_block_staff_targets AFTER INSERT OR DELETE ON crm.calendar_block_staff
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION crm.check_calendar_block_targets();

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['calendar_block', 'calendar_block_staff'] LOOP
    EXECUTE format('ALTER TABLE crm.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE crm.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY shop_scope ON crm.%I
         USING (shop_id = nullif(current_setting(''app.shop_id'', true), '''')::uuid)
         WITH CHECK (shop_id = nullif(current_setting(''app.shop_id'', true), '''')::uuid)',
      table_name
    );
  END LOOP;
END
$$;

-- 앱 역할: 부모 차단의 물리 삭제는 주지 않는다(제거는 status). created_source·version·시각은 서버·DB가 채운다.
GRANT SELECT ON crm.calendar_block, crm.calendar_block_staff TO bv_app;
GRANT INSERT (shop_id, start_at, end_at, all_staff, memo) ON crm.calendar_block TO bv_app;
GRANT UPDATE (start_at, end_at, all_staff, memo, status) ON crm.calendar_block TO bv_app;
GRANT INSERT, DELETE ON crm.calendar_block_staff TO bv_app;
