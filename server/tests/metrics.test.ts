import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import request from 'supertest';
import { config } from '../src/config.js';
import { metrics } from '../src/controllers/metricsController.js';
test('metrics requires a dedicated bearer credential and exposes bounded process values only',async()=>{
  const old=config.metricsToken;const app=express();app.get('/api/metrics',metrics);app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status??500).json({code:error.code}));
  try{
    config.metricsToken='';await request(app).get('/api/metrics').expect(404);
    config.metricsToken='x'.repeat(43);await request(app).get('/api/metrics').expect(401);await request(app).get('/api/metrics?token='+config.metricsToken).expect(401);
    const result=await request(app).get('/api/metrics').set('Authorization',`Bearer ${config.metricsToken}`).expect(200);
    assert.match(result.text,/process_resident_memory_bytes \d+/);assert.equal(result.headers['cache-control'],'no-store');assert.ok(!result.text.includes(config.metricsToken));assert.ok(!result.text.includes('user_id'));
  }finally{config.metricsToken=old;}
});
