/** A failure's message for the worker log. RPC and HTTP errors can quote the
 * endpoint, whose query carries the provider key, so every URL keeps only its
 * scheme, host and path. */
export function failureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi,(url) =>
    url.replace(/\/\/[^/@\s]*@/,'//…@').replace(/[?#].*$/,'?…')).slice(0,300);
}

/** Saved evidence that contradicts itself needs an operator. Everything else,
 * such as a stale or restarting stream, an RPC error or a catalog that aged
 * out, clears on a later cycle. */
export function isFatalPortfolioError(error: unknown) {
  return error instanceof Error && error.message.startsWith('FINALIZED_INVARIANT');
}

const pausable = async (ms: number,stopped: () => boolean) => {
  for (let elapsed=0; elapsed<ms && !stopped(); elapsed+=500)
    await new Promise((resolve) => setTimeout(resolve,Math.min(500,ms-elapsed)));
};

/** Replays saved captures, then captures, once per interval. A failed cycle
 * is logged and retried on the next interval, so the worker outlives a stream
 * stall or a deploy that starts it before the indexer is live; Railway's
 * bounded restarts would otherwise run out within a minute and leave it
 * crashed. One-shot runs and finalized-invariant failures still reject. */
export async function runPortfolioCaptures(options: {
  replay: () => Promise<number>; capture: () => Promise<unknown>;
  intervalMs: number; once: boolean; replayOnly: boolean; stopped: () => boolean;
  sleep?: (ms: number,stopped: () => boolean) => Promise<void>;
}) {
  const { replay,capture,intervalMs,once,replayOnly,stopped } = options,sleep = options.sleep ?? pausable;
  do {
    try {
      let replayed: number;
      do { replayed = await replay(); if (replayed) console.log('Replayed Dusk portfolio captures',{ count: replayed }); }
      while (replayed === 10 && !stopped());
      if (stopped() || replayOnly) return;
      console.log('Captured Dusk portfolio snapshots',await capture());
    } catch (error) {
      if (once || replayOnly || isFatalPortfolioError(error)) throw error;
      console.warn('Dusk portfolio capture skipped; retrying next interval',{ reason: failureReason(error) });
    }
    if (once) return;
    await sleep(intervalMs,stopped);
  } while (!stopped());
}
