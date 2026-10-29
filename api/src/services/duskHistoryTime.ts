/** Match the display-envelope clock allowance. Keep the exact requested cutoff
 * in cursor identity: clamping it to server-now would invalidate the next page. */
export const HISTORY_CLOCK_SKEW_MS = 1_000;
export function validHistoryUntil(time: number, now = Date.now()): boolean {
  return Number.isFinite(time) && time >= 0 && time <= now + HISTORY_CLOCK_SKEW_MS;
}
