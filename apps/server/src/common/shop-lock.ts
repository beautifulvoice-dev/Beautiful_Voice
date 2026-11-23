import type { PoolClient } from 'pg';

/**
 * 매장 단위 쓰기 잠금(설계 04 Q3·09 §예약 저장 시 차단 검사 1).
 * 예약 등록·변경·상태와 차단 등록·삭제·수정이 **멱등 키 선점 뒤, 업무 조회·행 잠금 전에** 같은 키로 잡는다.
 * 트랜잭션이 끝나면 풀린다. READ COMMITTED라 잠금을 얻은 뒤의 조회는 먼저 커밋된 쓰기를 본다.
 * 다른 매장은 키가 달라 서로 기다리지 않는다.
 */
export async function lockShopWrites(client: PoolClient, shopId: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('crm.shop-write:' || $1::uuid::text, 0))`, [shopId]);
}
