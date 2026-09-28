import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';
import { closeRateLimitStore } from './services/rateLimitStore.js';
import { startAuditWorker } from './services/auditWorker.js';
const stopAudit=config.configured?startAuditWorker():async()=>{};
const server=createApp().listen(config.port,'0.0.0.0',()=>{
  console.log(`CUSA Identity API listening on port ${config.port}`);
  if (!config.configured) console.log('Setup required. Configure .env before using authentication; UI demo remains available.');
});
let stopping=false;
async function stop() {
  if (stopping) return; stopping=true;
  server.close(async()=>{await stopAudit();await Promise.allSettled([pool.end(),closeRateLimitStore()]);process.exit(0);});
  setTimeout(()=>process.exit(1),10000).unref();
}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
