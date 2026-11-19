-- F-05 Idempotency-Key 저장(02-architecture §4 공통 규약, CLAUDE.md 절대 규칙 6).
-- 같은 매장·같은 키는 한 번만 실행되고, 이후 재전송에는 저장된 응답을 돌려준다.
-- 키 선점과 업무 쓰기는 같은 트랜잭션이라, 업무 쓰기가 롤백되면 키도 남지 않는다.
CREATE TABLE crm.idempotency_key (
  shop_id uuid NOT NULL REFERENCES crm.shop (id),
  key text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 255),
  -- 메서드·경로·본문 지문(sha256). 같은 키를 다른 요청에 쓰면 422.
  request_hash text NOT NULL,
  -- 키 선점 직후에는 비어 있고, 같은 트랜잭션 안에서 응답을 채운다.
  response_status smallint,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, key),
  CHECK ((response_status IS NULL) = (response_body IS NULL))
);
-- ASSUMPTION: 보관 기간·정리 작업은 정하지 않았다. 키는 UUID를 권장하므로 당분간 쌓아 둔다.

ALTER TABLE crm.idempotency_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.idempotency_key FORCE ROW LEVEL SECURITY;
CREATE POLICY idempotency_key_scope ON crm.idempotency_key
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);

GRANT SELECT, INSERT ON crm.idempotency_key TO bv_app;
GRANT UPDATE (response_status, response_body) ON crm.idempotency_key TO bv_app;
