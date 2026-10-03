export type JobOutcome = { outcome: 'skipped' } | {
  outcome: 'completed'; ok: boolean; details: Record<string, unknown>;
};
export interface BackgroundJob {
  name: string; intervalMs: number;
  run: (signal: AbortSignal) => Promise<JobOutcome>;
}
export interface JobStatus {
  name: string; running: boolean; intervalMs: number; nextRunAt: number;
  lastStartedAt: number | null; lastSuccessAt: number | null;
  lastFailureAt: number | null; consecutiveFailures: number;
  lastOutcome: 'pending' | 'completed' | 'failed' | 'skipped' | 'cancelled';
}
type Report = (event: Record<string, unknown>, failed: boolean) => void;
const log: Report = (event, failed) => (failed ? console.error : console.log)(JSON.stringify(event));

// One cycle at a time. Restart performs one catch-up scan, not a replay of all
// missed ticks. Durable expiry/deletion deadlines remain in MariaDB.
export function createBackgroundScheduler(jobs: BackgroundJob[], report: Report = log) {
  if (!jobs.length || new Set(jobs.map(job => job.name)).size !== jobs.length ||
      jobs.some(job => !Number.isSafeInteger(job.intervalMs) || job.intervalMs < 1 || job.intervalMs > 2_147_483_647)) {
    throw new Error('Invalid background jobs');
  }
  const state: JobStatus[] = jobs.map(job => ({ name: job.name, intervalMs: job.intervalMs,
    running: false, nextRunAt: 0, lastStartedAt: null, lastSuccessAt: null,
    lastFailureAt: null, consecutiveFailures: 0, lastOutcome: 'pending' }));
  const abort = new AbortController();
  let started = false, running = false;
  let timer: NodeJS.Timeout | undefined;
  let cycle: Promise<void> | undefined;
  const emit: Report = (event, failed) => { try { report(event, failed); } catch { /* Logging cannot stop cleanup. */ } };

  async function tick() {
    for (const [index, job] of jobs.entries()) {
      const current = state[index];
      if (!running) break;
      if (current.nextRunAt > Date.now()) continue;
      current.running = true; current.lastStartedAt = Date.now();
      try {
        const result = await job.run(abort.signal);
        if (abort.signal.aborted) { current.lastOutcome = 'cancelled'; continue; }
        if (result.outcome === 'skipped') {
          current.lastOutcome = 'skipped';
          emit({ event: 'background.job.skipped', job: job.name, reason: 'ALREADY_RUNNING' }, false);
        } else if (result.ok) {
          current.lastOutcome = 'completed'; current.lastSuccessAt = Date.now(); current.consecutiveFailures = 0;
          emit({ event: 'background.job.completed', job: job.name, ...result.details }, false);
        } else {
          current.lastOutcome = 'failed'; current.lastFailureAt = Date.now(); current.consecutiveFailures++;
          emit({ event: 'background.job.failed', job: job.name, severity: 'error', ...result.details }, true);
        }
      } catch {
        if (abort.signal.aborted) current.lastOutcome = 'cancelled';
        else {
          current.lastOutcome = 'failed'; current.lastFailureAt = Date.now(); current.consecutiveFailures++;
          // Exceptions may contain SQL, credentials or evidence paths.
          emit({ event: 'background.job.failed', job: job.name, severity: 'error', reason: 'JOB_FAILED' }, true);
        }
      } finally {
        current.running = false;
        const delay = current.lastOutcome === 'failed' ? Math.min(60_000, job.intervalMs)
          : current.lastOutcome === 'skipped' ? Math.min(30_000, job.intervalMs) : job.intervalMs;
        current.nextRunAt = Date.now() + delay;
      }
    }
  }
  function wake() {
    if (!running || cycle) return;
    cycle = tick().finally(() => {
      cycle = undefined;
      if (!running) return;
      const delay = Math.max(1, Math.min(...state.map(job => job.nextRunAt)) - Date.now());
      timer = setTimeout(wake, delay); timer.unref();
    });
  }
  return {
    start() {
      if (started) throw new Error('Background scheduler already started');
      started = true; running = true;
      emit({ event: 'background.scheduler.started', jobs: jobs.map(({ name, intervalMs }) => ({ name, intervalMs })) }, false);
      wake();
    },
    async stop() {
      running = false;
      if (timer) clearTimeout(timer);
      abort.abort(); await cycle;
    },
    status: () => ({ running, jobs: state.map(job => ({ ...job })) }),
  };
}
