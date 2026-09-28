import { drainAuditBatch } from '../models/auditModel.js';

interface WorkerStatus { running: boolean; faulted: boolean; lastSuccessAt: string | null; consecutiveFailures: number }
const status: WorkerStatus = { running: false, faulted: false, lastSuccessAt: null, consecutiveFailures: 0 };
export function getAuditWorkerStatus(): Readonly<WorkerStatus> { return { ...status }; }

/** The request awaits durable outbox insertion; this tracked worker awaits every batch. */
export function startAuditWorker(options: {
  batchSize?: number; pollMs?: number; retryDelayMs?: number; maxConsecutiveFailures?: number; drain?: typeof drainAuditBatch;
} = {}): () => Promise<void> {
  if (status.running) throw new Error('Audit worker already started');
  const batchSize = options.batchSize ?? 100;
  const pollMs = options.pollMs ?? 1000;
  const retryDelayMs = options.retryDelayMs ?? 5000;
  const maxConsecutiveFailures = options.maxConsecutiveFailures ?? 3;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500
    || !Number.isFinite(pollMs) || pollMs < 10
    || !Number.isFinite(retryDelayMs) || retryDelayMs < 1
    || !Number.isInteger(maxConsecutiveFailures) || maxConsecutiveFailures < 1) {
    throw new Error('Invalid audit worker options');
  }
  const drain = options.drain ?? drainAuditBatch;
  let stopping = false;
  let timer: NodeJS.Timeout | undefined;
  let wake: (() => void) | undefined;
  status.running = true;
  status.faulted = false;
  status.consecutiveFailures = 0;
  status.lastSuccessAt = null;
  const delay = (milliseconds: number) => new Promise<void>(resolve => {
    wake = resolve;
    timer = setTimeout(() => { timer = undefined; wake = undefined; resolve(); }, milliseconds);
    timer.unref();
  });
  const running = (async () => {
    try {
      while (!stopping) {
        try {
          const count = await drain(batchSize);
          status.lastSuccessAt = new Date().toISOString();
          status.consecutiveFailures = 0;
          if (!stopping && count < batchSize) await delay(pollMs);
        } catch {
          status.consecutiveFailures += 1;
          // Never print SQL/payloads: driver errors can contain personal data or secrets.
          if (status.consecutiveFailures >= maxConsecutiveFailures) {
            status.faulted = true;
            console.error('CRITICAL: Audit worker stopped after repeated batch failures; durable outbox retained',
              { consecutiveFailures: status.consecutiveFailures });
            break;
          }
          console.error('Audit worker batch failed; durable outbox retained', { consecutiveFailures: status.consecutiveFailures });
          if (!stopping) await delay(retryDelayMs);
        }
      }
    } finally { status.running = false; }
  })();
  return async () => {
    stopping = true;
    if (timer) clearTimeout(timer);
    wake?.();
    await running;
  };
}
