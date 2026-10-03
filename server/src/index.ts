import { startBackgroundJobs } from './services/backgroundJobs.js';
import { closeQueueRedis } from './services/queueRedis.js';
import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';
import { closeRateLimitStore } from './services/rateLimitStore.js';
import { startAuditWorker } from './services/auditWorker.js';
const app=createApp();
const stopAudit=config.configured&&!config.installEnabled?startAuditWorker():async()=>{};
const stopBackground=startBackgroundJobs();
const server=app.listen(config.port,'0.0.0.0',()=>{
  console.log(`CUSA SSO API listening on port ${config.port}`);
  if (!config.configured) console.log('Setup required. Configure .env before using authentication; UI demo remains available.');
  if (config.installEnabled) console.log('Installation mode: authentication and audit worker are paused. Disable INSTALL_ENABLED and restart after setup.');
});
let stopping=false;
async function stop() {
  if (stopping) return; stopping=true;
  const stoppedBackground=stopBackground();
  server.close(async()=>{await stoppedBackground;await stopAudit();await Promise.allSettled([pool.end(),closeRateLimitStore(),closeQueueRedis()]);process.exit(0);});
  setTimeout(()=>process.exit(1),10000).unref();
}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
