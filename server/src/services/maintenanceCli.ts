import { pool } from '../db.js';
import { runMaintenanceTask } from './maintenanceTasks.js';
import type { MaintenanceTask } from './maintenanceLock.js';

export async function runMaintenanceCli(task: MaintenanceTask) {
  try {
    const result = await runMaintenanceTask(task);
    if (result.outcome === 'skipped') {
      console.log(JSON.stringify({ event: 'background.job.skipped', job: task, reason: 'ALREADY_RUNNING' }));
    } else {
      const event = task === 'evidence_purge' ? 'mfa.evidence.purge.completed' : 'background.job.completed';
      (result.ok ? console.log : console.error)(JSON.stringify({ event: result.ok ? event : 'background.job.failed', job: task, ...result.details }));
      if (!result.ok) process.exitCode = 1;
    }
  } catch {
    console.error(JSON.stringify({ event: 'background.job.failed', job: task, reason: 'JOB_FAILED' }));
    process.exitCode = 1;
  } finally { await pool.end(); }
}
