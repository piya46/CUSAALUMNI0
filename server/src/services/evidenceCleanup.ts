import { purgeResetEvidence } from '../models/mfaResetModel.js';
let running:Promise<number>|undefined;
export async function cleanEvidence(){
  if(!running)running=purgeResetEvidence().finally(()=>{running=undefined;});return running;
}
export function startEvidenceCleanup(){
  const run=()=>{void cleanEvidence().catch(()=>console.error(JSON.stringify({event:'mfa.evidence.purge.failure',severity:'critical'})));};
  run();const timer=setInterval(run,15*60*1000);timer.unref();
  return async()=>{clearInterval(timer);await running?.catch(()=>{});};
}
