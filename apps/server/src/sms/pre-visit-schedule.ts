import type { PoolClient } from 'pg';

export interface PreVisitTime {
  startAt: Date;
  now: Date;
  timezone: string;
}

interface PlannedTime {
  scheduledAt: Date;
  quietHourAdjusted: boolean;
}

export async function planPreVisit(
  client: PoolClient,
  { startAt, now, timezone, leadHours = 24, aiAppliedAt = null }: PreVisitTime & {
    leadHours?: number;
    aiAppliedAt?: Date | null;
  },
): Promise<PlannedTime & { status: 'scheduled' | 'skipped_last_minute' }> {
  if (!Number.isInteger(leadHours) || leadHours < 1 || leadHours > 168) {
    throw new RangeError('pre-visit leadHours must be an integer from 1 to 168');
  }
  const { rows: [plan] } = await client.query<PlannedTime>(
    `WITH base AS (
       SELECT $1::timestamptz - make_interval(hours => $4) AS target
     ), local_target AS (
       SELECT target, target AT TIME ZONE $3::text AS wall_time FROM base
     )
     SELECT CASE
       WHEN wall_time::time < time '08:00' THEN (wall_time::date - 1 + time '20:00') AT TIME ZONE $3::text
       WHEN wall_time::time >= time '21:00' THEN (wall_time::date + time '20:00') AT TIME ZONE $3::text
       WHEN $5::timestamptz IS NOT NULL
        AND target BETWEEN $2::timestamptz AND $2::timestamptz + interval '10 minutes'
        AND $2::timestamptz + interval '10 minutes' < $1::timestamptz
        AND $5::timestamptz + interval '10 minutes' < $1::timestamptz
         THEN greatest(target, $5::timestamptz + interval '10 minutes')
       ELSE target
     END AS "scheduledAt",
     (wall_time::time < time '08:00' OR wall_time::time >= time '21:00') AS "quietHourAdjusted"
     FROM local_target`,
    [startAt, now, timezone, leadHours, aiAppliedAt],
  );
  return { ...plan!, status: plan!.scheduledAt > now ? 'scheduled' : 'skipped_last_minute' };
}

/** Call after reading and locking the due row, before reserving quota or contacting the provider. */
export async function preVisitDispatchTiming(
  client: PoolClient,
  { startAt, now, timezone }: PreVisitTime,
): Promise<{ status: 'ready' | 'skipped_last_minute' } | { status: 'deferred'; scheduledAt: Date }> {
  if (startAt <= now) return { status: 'skipped_last_minute' };
  const { rows: [row] } = await client.query<{ nextMorning: Date | null; canDefer: boolean | null }>(
    `WITH local_clock AS (
       SELECT $1::timestamptz AT TIME ZONE $2::text AS wall_time
     ), deferred AS (
       SELECT CASE
         WHEN wall_time::time < time '08:00' THEN (wall_time::date + time '08:00') AT TIME ZONE $2::text
         WHEN wall_time::time >= time '21:00' THEN (wall_time::date + 1 + time '08:00') AT TIME ZONE $2::text
       END AS next_morning FROM local_clock
     )
     SELECT next_morning AS "nextMorning",
       next_morning <= $3::timestamptz - interval '30 minutes' AS "canDefer" FROM deferred`,
    [now, timezone, startAt],
  );
  if (!row!.nextMorning) return { status: 'ready' };
  if (!row!.canDefer) return { status: 'skipped_last_minute' };
  return { status: 'deferred', scheduledAt: row!.nextMorning };
}
