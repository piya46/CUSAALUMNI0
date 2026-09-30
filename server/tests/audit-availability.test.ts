import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { auditAvailability } from '../src/middleware/auditAvailability.js';
import { pool } from '../src/db.js';

test('production requests fail closed while audit worker is stopped even before a backlog forms',async()=>{
  const original={nodeEnv:config.nodeEnv,configured:config.configured};let called=false;
  try{
    config.nodeEnv='production';config.configured=true;
    await assert.rejects(async()=>{await auditAvailability({} as any,{setHeader:(name:string,value:number)=>{assert.equal(name,'Retry-After');assert.equal(value,30);}} as any,()=>{called=true;});},{code:'AUDIT_UNAVAILABLE'});
    assert.equal(called,false);
  }finally{Object.assign(config,original);await pool.end();}
});
