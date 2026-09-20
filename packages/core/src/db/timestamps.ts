/**
 * Shared timestamp hydration for rows read from SQLite.
 *
 * SQLite stores every timestamp as TEXT written by `datetime('now')` — UTC,
 * "YYYY-MM-DD HH:MM:SS", no zone marker — which JavaScript parses as LOCAL
 * time, so re-anchor it to UTC before converting. Postgres rows arrive as real
 * Date objects and strings are the only other shape these normalizers see; the
 * regex trusts an already-zoned string and leaves its offset intact.
 *
 * This is the inverse of how those columns are written for cutoff comparisons:
 * `toDbDateParam` in workflow-events.ts, and the inline
 * `createdBefore.toISOString().replace('T', ' ').slice(0, 19)` in
 * findLatestByCodebaseAndWorkingPath (isolation-environments.ts). Hydrating on
 * read keeps comparisons like `environment.created_at <= run.started_at`
 * (#2747 adoption) UTC-correct on both dialects instead of drifting by the
 * host's UTC offset.
 */
export function toHydratedTimestamp(value: string): Date {
  const zoned = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(value);
  return new Date(zoned ? value : `${value.replace(' ', 'T')}Z`);
}

/**
 * `YYYY-MM-DD HH:MM:SS.mmm` in UTC — the shape SQLite's `datetime('now')`
 * writes, plus milliseconds, so the two compare correctly both in SQL (the
 * string sorts the same way the instant does) and after parsing. The extra
 * digits are what let two writes in the same second be ordered at all:
 * `datetime('now')` resolves to whole seconds, so anything relying on it alone
 * has to break ties some other way.
 */
export function formatSqliteTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
}
