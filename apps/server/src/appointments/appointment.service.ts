// C-07 세션(예약) 저장 서비스 — 뼈대. 웹·음성(승인된 변경안)·전화의 모든 예약 쓰기가 이 서비스를 지난다(절대 규칙 4, R-12).
// 규칙은 packages/scheduling(C-05 decideSave, C-04 transition)에 있고, 여기서는 순서를 지킨다:
//   매장 범위 트랜잭션(withShop) → 매장 잠금 → 같은 매장의 확정·완료 예약을 읽어 저장 직전 재검사(R-5) → 자리 재배정·저장·이력 → 커밋.
// DB 배타 제약(006)이 최종 방어선이다. 커밋 시 23P01이면 409 APPOINTMENT_CONFLICT로 돌려준다.
import type { Actor, Source } from '@bv/scheduling/status';
import { effectiveStatus, initialStatus, transition } from '@bv/scheduling/status';
import {
  type BookedAppointment, type Interval, type RejectReason, type ShopSchedule,
  DEFAULT_PREP_MINUTES, decideSave, occupied,
} from '@bv/scheduling';
import type { PoolClient } from 'pg';
import { ApiError } from '../common/api-error';
import { type IdempotentResponse, type IdempotentResult, runIdempotent } from '../common/idempotency';
import type { DatabaseService } from '../database.service';

export interface SessionInput {
  start: Date;
  end: Date;
  prepMinutes?: number;
  /** 원장이 겹침을 알고 "그대로 저장"을 골랐는지(R-4). */
  force?: boolean;
}

export interface WriteContext {
  actor: Actor;
  source: Source;
  now?: Date;
}

export interface AppointmentView {
  id: string;
  start: string;
  end: string;
  prepMinutes: number;
  status: string;
  isForced: boolean;
  version: number;
}

export type CheckResult =
  | { ok: true; isForced: boolean }
  | { ok: false; reason: RejectReason; conflictingIds: string[] };

/** 운영 시간·휴무·관리 불가 시간을 읽는다. C-01(설정)·C-06(관리 불가 시간) 저장소가 생기면 실제 구현으로 바꾼다. */
export interface ShopScheduleReader {
  read(client: PoolClient, shopId: string, around: Interval): Promise<ShopSchedule>;
}

type Idempotency = { key: string; fingerprint: string } | null;
const MAX_PREP_MINUTES = 1440;

export class AppointmentService {
  // schedules는 필수다 — 기본값을 두면 API 연결 때 운영 시간·휴무·관리 불가 시간(R-2)이 조용히 무시된다(#33 리뷰).
  // 실제 구현은 C-01(설정)·C-06(관리 불가 시간)에서 넣는다.
  constructor(
    private readonly database: Pick<DatabaseService, 'withShop'>,
    private readonly schedules: ShopScheduleReader,
  ) {}

  /** 저장하지 않고 판정만 한다(`:check`). */
  async check(shopId: string, input: SessionInput): Promise<CheckResult> {
    return this.write(shopId, async (client) => {
      const decision = await this.decide(client, shopId, input, null);
      return decision.ok ? { ok: true, isForced: decision.isForced } : decision;
    });
  }

  async create(shopId: string, input: SessionInput, ctx: WriteContext, idem: Idempotency = null) {
    return this.idempotent(shopId, idem, async (client) => {
      const now = ctx.now ?? new Date();
      const initial = initialStatus({ actor: ctx.actor, source: ctx.source, now });
      if (!initial.ok) throw new ApiError(403, initial.error, 'This actor cannot create appointments');
      const prep = input.prepMinutes ?? DEFAULT_PREP_MINUTES;
      // 자리를 차지하지 않는 요청 상태도 시간 형식은 검사한다(DB CHECK가 500으로 터지지 않게).
      assertValidPeriod({ ...input, prepMinutes: prep });
      let lane = 1;
      let isForced = false;
      if (initial.needsConflictCheck) {
        const decision = await this.decideOrThrow(client, shopId, input, null);
        await this.reassign(client, shopId, decision.reassign);
        ({ lane, isForced } = decision);
      }
      await this.eventContext(client, ctx);
      const { rows: [row] } = await client.query<Row>(
        `INSERT INTO crm.appointment (shop_id, period, prep_minutes, occupied, lane, is_forced, status)
         VALUES ($1, tstzrange($2, $3), $4, tstzrange($2, $5), $6, $7, $8) RETURNING ${COLUMNS}`,
        [shopId, input.start, input.end, prep, occupied({ ...input, prepMinutes: prep }).end, lane, isForced, initial.to],
      );
      return { status: 201, body: view(row!, now) };
    });
  }

  /** 시간·준비 시간을 바꾼다. ASSUMPTION: 2A에서는 끝나지 않은 확정 예약만 옮길 수 있다. */
  async move(shopId: string, id: string, input: SessionInput, ctx: WriteContext, idem: Idempotency = null) {
    return this.idempotent(shopId, idem, async (client) => {
      const now = ctx.now ?? new Date();
      const current = await this.lockRow(client, shopId, id);
      if (effectiveStatus(state(current), now) !== 'confirmed') {
        throw new ApiError(409, 'INVALID_TRANSITION', 'Only upcoming confirmed appointments can be moved');
      }
      const prep = input.prepMinutes ?? current.prep_minutes;
      const decision = await this.decideOrThrow(client, shopId, { ...input, prepMinutes: prep }, id);
      await this.reassign(client, shopId, decision.reassign);
      await this.eventContext(client, ctx);
      const { rows: [row] } = await client.query<Row>(
        `UPDATE crm.appointment SET period = tstzrange($3, $4), prep_minutes = $5, occupied = tstzrange($3, $6),
           lane = $7, is_forced = $8, version = version + 1, updated_at = now()
         WHERE shop_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
        [shopId, id, input.start, input.end, prep, occupied({ ...input, prepMinutes: prep }).end, decision.lane, decision.isForced],
      );
      return { status: 200, body: view(row!, now) };
    });
  }

  async cancel(shopId: string, id: string, ctx: WriteContext, idem: Idempotency = null) {
    return this.idempotent(shopId, idem, async (client) => {
      const now = ctx.now ?? new Date();
      const current = await this.lockRow(client, shopId, id);
      const result = transition(state(current), 'cancel', { actor: ctx.actor, source: ctx.source, now });
      if (!result.ok) {
        throw new ApiError(result.error === 'ACTOR_NOT_ALLOWED' ? 403 : 409, result.error, 'This appointment cannot be canceled');
      }
      await this.eventContext(client, ctx);
      const { rows: [row] } = await client.query<Row>(
        `UPDATE crm.appointment SET status = $3, version = version + 1, updated_at = now()
         WHERE shop_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
        [shopId, id, result.to],
      );
      return { status: 200, body: view(row!, now) };
    });
  }

  // ── 내부 ──────────────────────────────────────────────

  private async idempotent<T>(
    shopId: string, idem: Idempotency, handler: (client: PoolClient) => Promise<IdempotentResponse<T>>,
  ): Promise<IdempotentResult<T>> {
    return this.write(shopId, async (client) =>
      idem ? runIdempotent(client, idem, () => handler(client)) : { ...(await handler(client)), replayed: false });
  }

  /** 매장 범위 트랜잭션 + 매장 잠금. 커밋 시 배타 제약 위반(23P01)은 409로 바꾼다. */
  private async write<T>(shopId: string, run: (client: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.database.withShop(shopId, async (client) => {
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('crm.appointment:' || $1, 0))`, [shopId]);
        return run(client);
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23P01') {
        throw new ApiError(409, 'APPOINTMENT_CONFLICT', 'The time slot is already taken', { conflictingIds: [] });
      }
      throw error;
    }
  }

  private async decide(client: PoolClient, shopId: string, input: SessionInput, excludeId: string | null) {
    const prepMinutes = input.prepMinutes ?? DEFAULT_PREP_MINUTES;
    const request = { start: input.start, end: input.end, prepMinutes, force: input.force ?? false };
    if (!isValidPeriod(request)) {
      return { ok: false as const, reason: 'INVALID_PERIOD' as const, conflictingIds: [] };
    }
    const active = await this.loadConnected(client, shopId, occupied(request), excludeId);
    const schedule = await this.schedules.read(client, shopId, occupied(request));
    return decideSave(request, schedule, active);
  }

  /**
   * 요청 점유 구간과 이어서 겹치는 예약 묶음 전체를 읽는다(자리 재배정은 묶음 전체로 해야 한다 — #33 리뷰).
   * 읽은 예약의 점유 구간 바깥 끝까지 창을 넓히며 더 붙는 예약이 없을 때까지 반복한다.
   * 매장 잠금 안이라 반복하는 동안 목록이 바뀌지 않는다. 창 안의 묶음 밖 예약도 섞일 수 있지만 decideSave가 직접·연결 겹침만 쓴다.
   */
  private async loadConnected(client: PoolClient, shopId: string, from: Interval, excludeId: string | null) {
    let window = from;
    for (;;) {
      const { rows } = await client.query<{ id: string; s: Date; e: Date; oe: Date; prep_minutes: number; lane: number }>(
        `SELECT id, lower(period) AS s, upper(period) AS e, upper(occupied) AS oe, prep_minutes, lane FROM crm.appointment
         WHERE shop_id = $1 AND status IN ('confirmed', 'completed') AND occupied && tstzrange($2, $3)
           AND id IS DISTINCT FROM $4::uuid`,
        [shopId, window.start, window.end, excludeId],
      );
      const start = Math.min(window.start.getTime(), ...rows.map((r) => r.s.getTime()));
      const end = Math.max(window.end.getTime(), ...rows.map((r) => r.oe.getTime()));
      if (start === window.start.getTime() && end === window.end.getTime()) {
        return rows.map((r): BookedAppointment => ({ id: r.id, start: r.s, end: r.e, prepMinutes: r.prep_minutes, lane: r.lane }));
      }
      window = { start: new Date(start), end: new Date(end) };
    }
  }

  private async decideOrThrow(client: PoolClient, shopId: string, input: SessionInput, excludeId: string | null) {
    const decision = await this.decide(client, shopId, input, excludeId);
    if (!decision.ok) {
      const status = decision.reason === 'INVALID_PERIOD' ? 400 : 409;
      throw new ApiError(status, decision.reason, 'The appointment cannot be saved at this time',
        { conflictingIds: decision.conflictingIds });
    }
    return decision;
  }

  // 자리(lane)는 사용자에게 보이지 않는 내부 값이라, 재배정된 다른 예약의 version·이력은 올리지 않는다.
  // (변경안의 버전 비교는 사용자가 본 값 — 시간·준비 시간·상태 — 이 바뀌었을 때만 의미가 있다.)
  private async reassign(client: PoolClient, shopId: string, lanes: Map<string, number>) {
    for (const [id, lane] of lanes) {
      await client.query(
        'UPDATE crm.appointment SET lane = $3, updated_at = now() WHERE shop_id = $1 AND id = $2',
        [shopId, id, lane],
      );
    }
  }

  private async lockRow(client: PoolClient, shopId: string, id: string): Promise<Row> {
    const { rows: [row] } = await client.query<Row>(
      `SELECT ${COLUMNS} FROM crm.appointment WHERE shop_id = $1 AND id = $2::uuid FOR UPDATE`, [shopId, id],
    );
    if (!row) throw new ApiError(404, 'APPOINTMENT_NOT_FOUND', 'Appointment not found');
    return row;
  }

  private async eventContext(client: PoolClient, ctx: WriteContext) {
    await client.query(
      "SELECT set_config('app.event_actor', $1, true), set_config('app.event_source', $2, true)",
      [ctx.actor, ctx.source],
    );
  }
}

interface Row {
  id: string;
  s: Date;
  e: Date;
  prep_minutes: number;
  status: 'requested' | 'confirmed' | 'canceled' | 'no_show' | 'completed';
  is_forced: boolean;
  version: number;
}

const COLUMNS = 'id, lower(period) AS s, upper(period) AS e, prep_minutes, status, is_forced, version';

const state = (r: Row) => ({ status: r.status, start: r.s, end: r.e });

function isValidPeriod(s: { start: Date; end: Date; prepMinutes: number }): boolean {
  return !Number.isNaN(s.start.getTime()) && !Number.isNaN(s.end.getTime()) && s.start.getTime() < s.end.getTime()
    && Number.isInteger(s.prepMinutes) && s.prepMinutes >= 0 && s.prepMinutes <= MAX_PREP_MINUTES;
}

function assertValidPeriod(s: { start: Date; end: Date; prepMinutes: number }): void {
  if (!isValidPeriod(s)) {
    throw new ApiError(400, 'INVALID_PERIOD', 'The appointment cannot be saved at this time', { conflictingIds: [] });
  }
}

const snapshot = (r: Row) => ({ start: r.s.toISOString(), end: r.e.toISOString(), prepMinutes: r.prep_minutes, isForced: r.is_forced });

function view(r: Row, now: Date): AppointmentView {
  return { id: r.id, ...snapshot(r), status: effectiveStatus(state(r), now), version: r.version };
}
