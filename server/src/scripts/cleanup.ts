import {execute,pool} from '../db.js';

// Static allowlist only. Audit evidence and user records are never pruned here.
const tables=[['factor_challenges','expires_at'],['sessions','expires_at'],['oauth_flows','expires_at'],['otp_challenges','expires_at'],['mfa_enrollments','expires_at'],['authorization_codes','expires_at'],['access_tokens','expires_at'],['rate_limits','reset_at']] as const;
try{
  for(const [table,column] of tables){
    let total=0;
    for(let batch=0;batch<100;batch++){
      const result=await execute(`DELETE FROM ${table} WHERE ${column}<UTC_TIMESTAMP(3) LIMIT 1000`);
      total+=result.affectedRows;if(result.affectedRows<1000)break;
    }
    console.log(`${table}: ${total} expired rows removed`);
  }
}catch{console.error('Expired credential cleanup failed');process.exitCode=1;}
finally{await pool.end();}
