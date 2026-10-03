import { config } from '../config.js';
import { createBackgroundScheduler } from './backgroundScheduler.js';
import { runMaintenanceTask } from './maintenanceTasks.js';
import type { MaintenanceTask } from './maintenanceLock.js';

export const maintenanceIntervals: Record<MaintenanceTask, number> = {
  evidence_purge: 15 * 60_000, operations_check: 5 * 60_000, expired_credentials: 60 * 60_000,
};
let scheduler: ReturnType<typeof createBackgroundScheduler> | undefined;
export function startBackgroundJobs() {
  if (!config.backgroundJobsEnabled || !config.configured || config.installEnabled) {
    console.log(JSON.stringify({ event: 'background.scheduler.disabled' }));
    return async () => {};
  }
  if (scheduler?.status().running) throw new Error('Background jobs already started');
  const current = createBackgroundScheduler(Object.entries(maintenanceIntervals).map(([name, intervalMs]) => ({
    name, intervalMs, run: (signal: AbortSignal) => runMaintenanceTask(name as MaintenanceTask, signal),
  })));
  scheduler = current; current.start();
  return () => current.stop();
}
export const getBackgroundJobsStatus = () => scheduler?.status() ?? { running: false, jobs: [] };
