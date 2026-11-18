// DB 배타 제약 통합 테스트 — 실제 PostgreSQL에서 sql/appointment_conflict.sql을 검증한다.
// TEST_DATABASE_URL이 없으면 건너뛴다. 테스트마다 새 스키마를 만들고 지운다. psql CLI가 필요하다.
// 예: TEST_DATABASE_URL=postgres://localhost:5433/postgres node --test test/db.test.ts
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";

const DB_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = `c05_test_${process.pid}`;
const DDL = readFileSync(new URL("../sql/appointment_conflict.sql", import.meta.url), "utf8");
const SHOP_A = "00000000-0000-4000-8000-00000000000a";
const SHOP_B = "00000000-0000-4000-8000-00000000000b";
const run = promisify(execFile);

function psql(sql: string): string {
  return execFileSync("psql", [DB_URL!, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", `SET search_path TO ${SCHEMA}, public; ${sql}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** 실패하면 SQLSTATE가 담긴 오류 메시지를 돌려준다. 성공하면 null. */
function psqlError(sql: string): string | null {
  try {
    psql(sql);
    return null;
  } catch (e) {
    return String((e as { stderr?: string }).stderr ?? e);
  }
}

// prep = 세션 뒤 준비 시간(분). occupied = 세션 시작 ~ 끝 + 준비 시간(R-3).
const insert = (shop: string, from: string, to: string, lane: number, status = "confirmed", prep = 0) =>
  `INSERT INTO appointment (id, shop_id, period, occupied, lane, status)
   SELECT gen_random_uuid(), '${shop}', p, tstzrange(lower(p), upper(p) + interval '${prep} minutes'), ${lane}, '${status}'
   FROM (SELECT tstzrange('2026-11-24 ${from}+09', '2026-11-24 ${to}+09') AS p) AS s;`;

const count = (shop = SHOP_A) =>
  Number(psql(`SELECT count(*) FROM appointment WHERE shop_id = '${shop}' AND status IN ('confirmed','completed');`));

describe("appointment 배타 제약 (PostgreSQL)", { skip: !DB_URL && "TEST_DATABASE_URL 없음" }, () => {
  before(() => {
    execFileSync("psql", [DB_URL!, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", `CREATE SCHEMA ${SCHEMA};`]);
    execFileSync("psql", [DB_URL!, "-X", "-q", "-v", "ON_ERROR_STOP=1"], { input: `SET search_path TO ${SCHEMA}, public;\n${DDL}` });
  });
  after(() => {
    execFileSync("psql", [DB_URL!, "-X", "-q", "-c", `DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;`]);
  });

  const reset = () => psql("TRUNCATE appointment;");

  it("같은 자리에서 겹치는 확정 예약은 거절 (23P01)", () => {
    reset();
    psql(insert(SHOP_A, "10:00", "11:00", 1));
    const err = psqlError(insert(SHOP_A, "10:30", "11:30", 1));
    assert.match(err ?? "", /appointment_no_overlap_per_lane/);
  });

  it("두 자리면 2건까지, 3건째는 어느 자리로도 거절", () => {
    reset();
    psql(insert(SHOP_A, "10:00", "11:00", 1));
    psql(insert(SHOP_A, "10:00", "11:00", 2));
    assert.match(psqlError(insert(SHOP_A, "10:30", "11:30", 1)) ?? "", /appointment_no_overlap_per_lane/);
    assert.match(psqlError(insert(SHOP_A, "10:30", "11:30", 2)) ?? "", /appointment_no_overlap_per_lane/);
    assert.equal(count(), 2);
  });

  it("자리 3 이상은 CHECK로 거절", () => {
    reset();
    assert.match(psqlError(insert(SHOP_A, "10:00", "11:00", 3)) ?? "", /appointment_lane_check/);
  });

  it("맞닿은 구간은 같은 자리에 들어간다 [start, end)", () => {
    reset();
    psql(insert(SHOP_A, "10:00", "11:00", 1));
    psql(insert(SHOP_A, "11:00", "12:00", 1));
    assert.equal(count(), 2);
  });

  it("준비 시간(R-3): 세션 뒤 10분 안에 같은 자리 예약은 거절, 준비 시간이 끝나면 허용", () => {
    reset();
    psql(insert(SHOP_A, "10:00", "11:00", 1, "confirmed", 10));
    assert.match(psqlError(insert(SHOP_A, "11:05", "12:00", 1)) ?? "", /appointment_no_overlap_per_lane/);
    psql(insert(SHOP_A, "11:10", "12:00", 1));
    assert.equal(count(), 2);
  });

  it("점유 구간은 세션과 시작이 같고 세션보다 짧을 수 없다 (CHECK)", () => {
    reset();
    const bad = (occ: string) =>
      psqlError(`INSERT INTO appointment (id, shop_id, period, occupied, lane, status)
        VALUES (gen_random_uuid(), '${SHOP_A}', tstzrange('2026-11-24 10:00+09','2026-11-24 11:00+09'), ${occ}, 1, 'confirmed');`);
    assert.match(bad("tstzrange('2026-11-24 09:50+09','2026-11-24 11:00+09')") ?? "", /appointment_occupied_check/);
    assert.match(bad("tstzrange('2026-11-24 10:00+09','2026-11-24 10:30+09')") ?? "", /appointment_occupied_check/);
  });

  it("취소·요청·노쇼는 자리를 차지하지 않는다", () => {
    reset();
    psql(insert(SHOP_A, "10:00", "11:00", 1, "canceled"));
    psql(insert(SHOP_A, "10:00", "11:00", 1, "requested"));
    psql(insert(SHOP_A, "10:00", "11:00", 1, "no_show"));
    psql(insert(SHOP_A, "10:00", "11:00", 1));
    assert.equal(count(), 1);
  });

  it("다른 매장의 예약과는 무관하다", () => {
    reset();
    psql(insert(SHOP_A, "10:00", "11:00", 1));
    psql(insert(SHOP_B, "10:00", "11:00", 1));
    assert.equal(count(SHOP_B), 1);
  });

  it("강제 저장 재배정: 한 트랜잭션 안의 일시적 겹침은 커밋 시 검사(DEFERRABLE)", () => {
    reset();
    // 반례 ③: A(09-11, 자리1), B(12-14, 자리2)에 C(10-13) → B를 자리1로, C를 자리2로
    psql(`INSERT INTO appointment (id, shop_id, period, occupied, lane, status) VALUES
      ('00000000-0000-4000-8000-0000000000a1', '${SHOP_A}', tstzrange('2026-11-24 09:00+09','2026-11-24 11:00+09'), tstzrange('2026-11-24 09:00+09','2026-11-24 11:00+09'), 1, 'confirmed'),
      ('00000000-0000-4000-8000-0000000000b1', '${SHOP_A}', tstzrange('2026-11-24 12:00+09','2026-11-24 14:00+09'), tstzrange('2026-11-24 12:00+09','2026-11-24 14:00+09'), 2, 'confirmed');`);
    psql(`BEGIN;
      ${insert(SHOP_A, "10:00", "13:00", 2)}
      UPDATE appointment SET lane = 1 WHERE id = '00000000-0000-4000-8000-0000000000b1';
      COMMIT;`);
    assert.equal(count(), 3);
  });

  it("병렬 저장 100회: 같은 시간 확정 예약은 끝까지 2건", async () => {
    reset();
    const attempts = Array.from({ length: 100 }, (_, i) =>
      run("psql", [DB_URL!, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", `SET search_path TO ${SCHEMA}, public; ${insert(SHOP_A, "10:00", "11:00", (i % 2) + 1)}`])
        .then(() => "ok")
        .catch((e: { stderr?: string }) => String(e.stderr ?? e)),
    );
    const results = await Promise.all(attempts);
    const rejected = results.filter((r) => r !== "ok");
    assert.equal(results.length - rejected.length, 2);
    // 연결 수 초과 같은 인프라 오류가 거절로 섞이지 않았는지: 거절 98건 모두 배타 제약 위반이어야 한다.
    for (const err of rejected) assert.match(err, /appointment_no_overlap_per_lane/);
    assert.equal(count(), 2);
  });
});
