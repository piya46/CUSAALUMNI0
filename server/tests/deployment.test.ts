import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,mkdir,writeFile,rm,symlink,stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkDeployment } from '../src/services/deploymentCheck.js';
import { resolveEvidenceDirectory } from '../src/services/evidenceDirectory.js';

async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'cusa-deploy-check-'));
  for(const name of ['public','server/dist','server/migrations','web/dist','web/public','var/evidence'])await mkdir(join(root,name),{recursive:true,mode:0o700});
  for(const name of ['app.cjs','package-lock.json','server/dist/index.js','web/dist/index.html','server/migrations/004_security_hardening.sql','server/migrations/005_mfa_reset_evidence.sql','server/migrations/006_additional_factors.sql','server/migrations/007_waiting_room.sql','server/migrations/008_service_consent.sql','server/migrations/009_service_accounts.sql'])await writeFile(join(root,name),'fixture');
  await writeFile(join(root,'.env'),'NOT_A_REAL_SECRET=synthetic-value',{mode:0o600});
  return {root,config:{nodeEnv:'production',secureCookies:true,appOrigin:'https://example.test',configured:true,installEnabled:false,installToken:'',dbTls:false,dbHost:'127.0.0.1',dbCaFile:'',redisUrl:'',mfaEvidenceKey:Buffer.alloc(32,5).toString('base64'),encryptionKey:Buffer.alloc(32,7).toString('base64'),mfaEvidenceDir:join(root,'var/evidence')} as Parameters<typeof checkDeployment>[0]};
}

test('offline deployment check diagnoses unsafe transport, leftover installer and reused keys without disclosing values',async()=>{
  const {root,config}=await fixture();
  try{
    assert.equal((await checkDeployment(config,root,'22.12.0')).ok,true);
    config.dbHost='203.0.113.10';config.installToken='synthetic-install-secret';config.redisUrl='https://secret-user:secret-password@example.test';config.mfaEvidenceKey=config.encryptionKey;
    const report=await checkDeployment(config,root,'22.11.0');assert.equal(report.ok,false);
    const failures=report.checks.filter(c=>c.status==='fail').map(c=>c.code);
    for(const code of ['NODE_VERSION','DB_TRANSPORT','INSTALL_DISABLED','REDIS_URL','EVIDENCE_KEY_SEPARATION'])assert.ok(failures.includes(code));
    const output=JSON.stringify(report);for(const value of [config.installToken,config.mfaEvidenceKey,'secret-password',config.dbHost])assert.equal(output.includes(value),false);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('evidence path validation rejects public paths and symlinked public roots before making directories',async()=>{
  const {root}=await fixture(),outside=await mkdtemp(join(tmpdir(),'cusa-public-target-'));
  try{
    await assert.rejects(resolveEvidenceDirectory(root,root));await assert.rejects(resolveEvidenceDirectory(tmpdir(),root));
    await assert.rejects(resolveEvidenceDirectory(join(root,'public','not-created'),root));
    await assert.rejects(stat(join(root,'public','not-created')));
    await rm(join(root,'web/public'),{recursive:true});await symlink(outside,join(root,'web/public'));
    await assert.rejects(resolveEvidenceDirectory(join(outside,'evidence'),root));
    await symlink(join(root,'public'),join(root,'public-link'));
    await assert.rejects(resolveEvidenceDirectory(join(root,'public-link','evidence'),root));
    const privatePath=await resolveEvidenceDirectory(join(root,'var/new-private-dir'),root);assert.ok(privatePath.endsWith('var/new-private-dir'));
  }finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});
