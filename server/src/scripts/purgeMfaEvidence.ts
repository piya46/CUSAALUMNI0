import { cleanEvidence } from '../services/evidenceCleanup.js';
import { pool } from '../db.js';
try{console.log(JSON.stringify({event:'mfa.evidence.purge.completed',deleted:await cleanEvidence()}));}
catch{console.error(JSON.stringify({event:'mfa.evidence.purge.failure',severity:'critical'}));process.exitCode=1;}
finally{await pool.end();}
