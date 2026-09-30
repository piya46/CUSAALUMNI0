import { pool,query } from '../db.js';
import { getAuditQueueHealth } from '../models/auditModel.js';
import { config } from '../config.js';

// Read-only diagnostic. Never emit raw SHOW GRANTS (it may contain auth hashes).
try {
  const queue=await getAuditQueueHealth();
  const [server]=await query<{zone:string;role:string}>('SELECT @@session.time_zone AS zone,CURRENT_ROLE() AS role');
  const grants=await query<Record<string,string>>('SHOW GRANTS FOR CURRENT_USER');
  const protectedTables=['audit_logs','installation_state','schema_migrations'];
  const issues:string[]=[];
  for(const row of grants)for(const grant of Object.values(row)) {
    if(/\bWITH GRANT OPTION\b/i.test(grant))issues.push('Runtime must not delegate database privileges');
    const match=grant.match(/^GRANT (.+) ON (.+) TO /i);
    if(!match) {if(/^GRANT /i.test(grant))issues.push('Role grants require DBA review');continue;}
    const scope=match[2].replaceAll('`','');const privileges=match[1].split(',').map(p=>p.trim().toUpperCase());
    if(scope==='*.*'||scope===`${config.dbName}.*`||protectedTables.some(t=>scope===`${config.dbName}.${t}`)) {
      const allowed=scope===`${config.dbName}.audit_logs`?['SELECT','INSERT','USAGE']:['SELECT','USAGE'];
      if(privileges.some(p=>!allowed.includes(p)))issues.push('Runtime has excessive rights on protected data or schema');
    }
  }
  if(server.role&&server.role!=='NULL')issues.push('Active role privileges need explicit DBA verification');
  const [evidence]=await query<{total:number}>("SELECT COUNT(*) AS total FROM mfa_reset_requests WHERE purged_at IS NULL AND delete_after<=UTC_TIMESTAMP(3)");
  if(Number(evidence.total)>0)issues.push('Evidence deletion deadline exceeded');
  if(server.zone!=='+00:00')issues.push('Database session is not UTC');
  if(queue.pending>=10000||queue.oldestAgeSeconds>=60)issues.push('Audit backlog exceeds alert threshold');
  console.log(JSON.stringify({ok:issues.length===0,queue,issues:[...new Set(issues)]}));
  if(issues.length)process.exitCode=1;
}catch{console.error(JSON.stringify({ok:false,reason:'OPERATIONS_CHECK_FAILED'}));process.exitCode=1;}
finally{await pool.end();}
