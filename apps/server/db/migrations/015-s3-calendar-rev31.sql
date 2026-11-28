-- S3 캘린더 rev.3.1(명세 §3.2·§4.2) — 웹 수동 예약은 겹쳐도 경고와 함께 저장, 정리 시간은 시술 뒤, 담당자 미지정, 메뉴 가격.
-- 008은 고치지 않는다. migrate.cjs가 한 트랜잭션으로 돌리므로 어느 단계에서 실패해도 전부 되돌아간다.
-- 강제 RLS는 테이블 소유자에게도 걸린다 — 전 매장 행을 세고 다시 계산하는 동안만 끄고 끝에서 다시 켠다(009와 같은 방식).
ALTER TABLE crm.menu NO FORCE ROW LEVEL SECURITY;
ALTER TABLE crm.appointment_m1 NO FORCE ROW LEVEL SECURITY;

-- 1. 새 범위(시술 5~600분, 정리 0~180분) 밖의 메뉴·예약이 하나라도 있으면 바꾸기 전에 멈춘다. 조용히 자르지 않는다.
--    메뉴 기본 시간이 NULL인 칸은 검사하지 않는다. 데이터를 손으로 정정한 뒤 다시 실행한다.
DO $$
DECLARE
  bad_menus bigint;
  bad_appointments bigint;
BEGIN
  SELECT count(*) INTO bad_menus FROM crm.menu
   WHERE default_duration_min NOT BETWEEN 5 AND 600 OR default_prep_min NOT BETWEEN 0 AND 180;
  SELECT count(*) INTO bad_appointments FROM crm.appointment_m1
   WHERE duration_min NOT BETWEEN 5 AND 600 OR prep_min NOT BETWEEN 0 AND 180;
  IF bad_menus > 0 OR bad_appointments > 0 THEN
    RAISE EXCEPTION 'rev.3.1 time range violation: % menu rows, % appointment rows (fix them and rerun)',
      bad_menus, bad_appointments USING ERRCODE = '23514';
  END IF;
END
$$;

-- 2. 겹침 배타 제약을 없앤다. 겹침은 서버가 매장 쓰기 잠금(lockShopWrites) 안에서 판정해 경고로 돌려준다.
ALTER TABLE crm.appointment_m1 DROP CONSTRAINT appointment_m1_staff_overlap;

-- 3. 준비 → 정리(분 값 그대로 이전), 시간 범위, 담당자 미지정, 메뉴 이름 스냅샷·가격, 담당자 필수 설정.
--    담당자 NULL은 복합 FK(shop_id, staff_id)가 검사하지 않고(MATCH SIMPLE), 값이 있으면 같은 매장 담당자만 참조한다.
ALTER TABLE crm.appointment_m1 RENAME COLUMN prep_min TO cleanup_min;
ALTER TABLE crm.appointment_m1
  DROP CONSTRAINT appointment_m1_duration_min_check,
  DROP CONSTRAINT appointment_m1_prep_min_check,
  ADD CONSTRAINT appointment_m1_duration_range CHECK (duration_min BETWEEN 5 AND 600),
  ADD CONSTRAINT appointment_m1_cleanup_range CHECK (cleanup_min BETWEEN 0 AND 180),
  ALTER COLUMN staff_id DROP NOT NULL,
  ADD COLUMN menu_name_snapshot text;

ALTER TABLE crm.menu RENAME COLUMN default_prep_min TO default_cleanup_min;
ALTER TABLE crm.menu
  DROP CONSTRAINT menu_default_duration_min_check,
  DROP CONSTRAINT menu_default_prep_min_check,
  ADD CONSTRAINT menu_default_duration_range CHECK (default_duration_min BETWEEN 5 AND 600),
  ADD CONSTRAINT menu_default_cleanup_range CHECK (default_cleanup_min BETWEEN 0 AND 180),
  -- 원 단위 정수. 기존 메뉴는 0으로 채워진다.
  ADD COLUMN default_price integer NOT NULL DEFAULT 0 CONSTRAINT menu_default_price_nonnegative CHECK (default_price >= 0);

ALTER TABLE crm.shop_settings ADD COLUMN require_staff_selection boolean NOT NULL DEFAULT false;

-- 앱 계정은 칸 단위 권한이다(007·008). 이름만 바꾼 칸은 권한이 따라가고, 새 칸은 여기서 준다. AI 실행기는 테이블 단위 읽기만(012).
GRANT INSERT (menu_name_snapshot), UPDATE (menu_name_snapshot) ON crm.appointment_m1 TO bv_app;
GRANT INSERT (default_price), UPDATE (default_price) ON crm.menu TO bv_app;
GRANT UPDATE (require_staff_selection) ON crm.shop_settings TO bv_app;

-- 4. 점유 = [시작, 시작 + 시술 + 정리). CREATE OR REPLACE는 기존 권한(REVOKE FROM PUBLIC)을 그대로 둔다.
CREATE OR REPLACE FUNCTION crm.set_appointment_m1_derived_fields() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  NEW.occupied := tstzrange(
    NEW.start_at,
    NEW.start_at + make_interval(mins => NEW.duration_min + NEW.cleanup_min),
    '[)'
  );
  IF TG_OP = 'UPDATE' THEN
    NEW.version := OLD.version + 1;
    NEW.updated_at := clock_timestamp();
  END IF;
  RETURN NEW;
END
$$;

-- 기존 예약의 점유를 새 식으로 다시 채우고 메뉴 이름 스냅샷을 넣는다. 일반 UPDATE면 점유 트리거가 version·updated_at을 올리고
-- 이력 트리거(013)가 가짜 "수정됨" 행을 남기므로, 이 UPDATE 동안만 두 트리거를 끈다. 시작·시술·version·updated_at은 그대로다.
ALTER TABLE crm.appointment_m1 DISABLE TRIGGER appointment_m1_derive;
ALTER TABLE crm.appointment_m1 DISABLE TRIGGER appointment_m1_record_event;
UPDATE crm.appointment_m1 a
   SET occupied = tstzrange(a.start_at, a.start_at + make_interval(mins => a.duration_min + a.cleanup_min), '[)'),
       menu_name_snapshot = (SELECT m.name FROM crm.menu m WHERE m.shop_id = a.shop_id AND m.id = a.menu_id);
ALTER TABLE crm.appointment_m1 ENABLE TRIGGER appointment_m1_record_event;
ALTER TABLE crm.appointment_m1 ENABLE TRIGGER appointment_m1_derive;

ALTER TABLE crm.appointment_m1 FORCE ROW LEVEL SECURITY;
ALTER TABLE crm.menu FORCE ROW LEVEL SECURITY;
