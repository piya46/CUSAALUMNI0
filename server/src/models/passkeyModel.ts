import { randomUUID } from 'node:crypto';
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse, type AuthenticationResponseJSON, type RegistrationResponseJSON } from '@simplewebauthn/server';
import { config } from '../config.js';
import { execute, query, transaction } from '../db.js';
import { hashToken } from '../services/crypto.js';
import { HttpError } from '../middleware/security.js';
import { failure, promote, type AuthAudit } from './authModel.js';
import { createFactorChallenge, factorChallenge, factorFingerprint, lockFactorSession, type FactorRow } from './factorModel.js';
const rpID=()=>new URL(config.appOrigin).hostname;
const transports=(value:any)=>typeof value==='string'?JSON.parse(value):value;
function enabled(){if(!config.passkeyEnabled)throw new HttpError(404,'Passkeys ยังไม่เปิดใช้งาน','NOT_FOUND');}
export async function listPasskeys(userId:string) {
  return query<FactorRow>('SELECT id,name,created_at AS createdAt,last_used_at AS lastUsedAt,backed_up AS backedUp FROM passkeys WHERE user_id=? ORDER BY created_at',[userId]);
}
export async function registrationOptions(sessionId:string,record:AuthAudit){
  enabled();return transaction(async conn=>{
    const session=await lockFactorSession(sessionId,conn,'manage');
    const keys=await query<FactorRow>('SELECT credential_id,transports FROM passkeys WHERE user_id=?',[session.user_id],conn);
    if(keys.length>=10)throw new HttpError(409,'เพิ่ม Passkey ได้ไม่เกิน 10 รายการ','PASSKEY_LIMIT');
    const options=await generateRegistrationOptions({rpName:'CUSA SSO',rpID:rpID(),userID:new TextEncoder().encode(session.user_id),userName:session.email,attestationType:'none',
      authenticatorSelection:{residentKey:'preferred',userVerification:'required'},supportedAlgorithmIDs:[-7,-257],timeout:120000,
      excludeCredentials:keys.map(k=>({id:k.credential_id,transports:transports(k.transports)}))});
    const challengeId=await createFactorChallenge(sessionId,'passkey_register',{challenge:options.challenge,factor:factorFingerprint(session)},conn);
    await record(conn,'mfa.passkey.registration.started',session.user_id);
    return {challengeId,options};
  });
}
export async function registerPasskey(sessionId:string,id:string,name:string,response:RegistrationResponseJSON,record:AuthAudit){
  enabled();return transaction(async conn=>{
    const session=await lockFactorSession(sessionId,conn,'manage');
    const challenge=await factorChallenge(id,sessionId,'passkey_register',conn);
    if(!challenge)return false;
    await execute("UPDATE factor_challenges SET status='used' WHERE id=?",[id],conn);
    let result;
    try{result=await verifyRegistrationResponse({response,expectedChallenge:challenge.data.challenge,expectedOrigin:config.appOrigin,expectedRPID:rpID(),requireUserVerification:true,supportedAlgorithmIDs:[-7,-257]});}catch{result=null;}
    if(!result?.verified || challenge.data.factor!==factorFingerprint(session)){await failure(session.user_id,conn,record);return false;}
    const [{total}]=await query<FactorRow>('SELECT COUNT(*) AS total FROM passkeys WHERE user_id=?',[session.user_id],conn);
    if(Number(total)>=10)return false;
    const {credential,credentialBackedUp}=result.registrationInfo;
    const [duplicate]=await query('SELECT id FROM passkeys WHERE credential_hash=?',[hashToken(credential.id)],conn);
    if(duplicate){await failure(session.user_id,conn,record);return false;}
    await execute('INSERT INTO passkeys(id,user_id,credential_hash,credential_id,public_key,counter,transports,backed_up,name) VALUES (?,?,?,?,?,?,?,?,?)',
      [randomUUID(),session.user_id,hashToken(credential.id),credential.id,Buffer.from(credential.publicKey),credential.counter,JSON.stringify(credential.transports??[]),credentialBackedUp,name],conn);
    await record(conn,'mfa.passkey.registered',session.user_id,{name});return true;
  });
}
export async function authenticationOptions(sessionId:string){
  enabled();return transaction(async conn=>{
    const session=await lockFactorSession(sessionId,conn,'pending');
    const keys=await query<FactorRow>('SELECT credential_id,transports FROM passkeys WHERE user_id=?',[session.user_id],conn);
    if(!keys.length)throw new HttpError(409,'บัญชีนี้ยังไม่มี Passkey','PASSKEY_UNAVAILABLE');
    const options=await generateAuthenticationOptions({rpID:rpID(),userVerification:'required',timeout:120000,allowCredentials:keys.map(k=>({id:k.credential_id,transports:transports(k.transports)}))});
    const challengeId=await createFactorChallenge(sessionId,'passkey_auth',{challenge:options.challenge,factor:factorFingerprint(session)},conn);
    return {challengeId,options};
  });
}
export async function authenticatePasskey(sessionId:string,id:string,response:AuthenticationResponseJSON,record:AuthAudit){
  enabled();return transaction(async conn=>{
    const session=await lockFactorSession(sessionId,conn,'pending');
    const challenge=await factorChallenge(id,sessionId,'passkey_auth',conn);
    if(!challenge)return null;
    await execute("UPDATE factor_challenges SET status='used' WHERE id=?",[id],conn);
    const [key]=await query<FactorRow>('SELECT * FROM passkeys WHERE credential_hash=? AND user_id=? FOR UPDATE',[hashToken(response.id),session.user_id],conn);
    let result;
    try{
      if(!key || challenge.data.factor!==factorFingerprint(session))throw new Error();
      if(response.response.userHandle && response.response.userHandle!==Buffer.from(session.user_id).toString('base64url'))throw new Error();
      result=await verifyAuthenticationResponse({response,expectedChallenge:challenge.data.challenge,expectedOrigin:config.appOrigin,expectedRPID:rpID(),requireUserVerification:true,
        credential:{id:key.credential_id,publicKey:new Uint8Array(key.public_key),counter:Number(key.counter),transports:transports(key.transports)}});
    }catch{result=null;}
    if(!result?.verified){await failure(session.user_id,conn,record);return null;}
    await execute('UPDATE passkeys SET counter=?,backed_up=?,last_used_at=UTC_TIMESTAMP(3) WHERE id=?',[result.authenticationInfo.newCounter,result.authenticationInfo.credentialBackedUp,key.id],conn);
    return promote(sessionId,session.user_id,'passkey',conn,record);
  });
}
export async function deletePasskey(sessionId:string,id:string,record:AuthAudit){
  return transaction(async conn=>{
    const session=await lockFactorSession(sessionId,conn,'manage');
    const removed=await execute('DELETE FROM passkeys WHERE id=? AND user_id=?',[id,session.user_id],conn);
    if(!removed.affectedRows)throw new HttpError(404,'ไม่พบ Passkey','NOT_FOUND');
    await execute("DELETE FROM sessions WHERE user_id=? AND id<>?",[session.user_id,sessionId],conn);
    await record(conn,'mfa.passkey.removed',session.user_id,{credentialId:id});
  });
}
