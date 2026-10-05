import { execute, query, transaction } from '../db.js';
import { hashToken, seal } from '../services/crypto.js';
import { HttpError } from '../middleware/security.js';
import { OtpCooldownError, type AuthAudit } from './authModel.js';
import { createFactorChallenge, factorChallenge, lockFactorSession, type FactorRow } from './factorModel.js';
import { requireFirebasePhone } from '../services/firebasePhone.js';
export async function startPhoneVerification(sessionId:string,phone:string,record:AuthAudit){
  requireFirebasePhone();return transaction(async conn=>{
    const s=await lockFactorSession(sessionId,conn,'phone');
    const [existing]=await query('SELECT user_id FROM phone_identities WHERE user_id=?',[s.user_id],conn);
    if(existing)throw new HttpError(409,'บัญชียืนยันเบอร์แล้ว การเปลี่ยนเบอร์ให้ติดต่อผู้ดูแล','PHONE_ALREADY_VERIFIED');
    const [cooldown]=await query<FactorRow>('SELECT GREATEST(0,CEIL(60-TIMESTAMPDIFF(MICROSECOND,phone_sent_at,UTC_TIMESTAMP(3))/1000000)) AS seconds FROM users WHERE id=?',[s.user_id],conn);
    if(Number(cooldown.seconds)>0)throw new OtpCooldownError(Number(cooldown.seconds));
    await execute('UPDATE users SET phone_sent_at=UTC_TIMESTAMP(3) WHERE id=?',[s.user_id],conn);
    const challengeId=await createFactorChallenge(sessionId,'phone',{phoneHash:hashToken(`phone:${phone}`)},conn);
    await record(conn,'phone.verification.started',s.user_id,{noticeVersion:'1.2',purpose:'firebase_phone_verification',acknowledged:true});
    return {challengeId,retryAfter:60,expiresIn:180};
  });
}
// This function accepts only claims already verified with the configured Firebase
// Admin SDK. Never call it with decoded/unverified browser JWT contents.
export async function finishPhoneVerification(sessionId:string,id:string,proof:{phone:string;uid:string;authenticatedAt:number},record:AuthAudit){
  requireFirebasePhone();return transaction(async conn=>{
    const s=await lockFactorSession(sessionId,conn,'phone');
    const challenge=await factorChallenge(id,sessionId,'phone',conn);
    if(!challenge)return false;
    await execute("UPDATE factor_challenges SET status='used' WHERE id=?",[id],conn);
    const now=Date.now()/1000;
    if(challenge.data.phoneHash!==hashToken(`phone:${proof.phone}`)||proof.authenticatedAt<new Date(challenge.created_at).getTime()/1000-10||proof.authenticatedAt<now-180||proof.authenticatedAt>now+10){
      await record(conn,'phone.verification.failure',s.user_id,{failure_reason:'INVALID_PHONE_PROOF'});return false;
    }
    // The unique user/phone/Firebase UID indexes arbitrate across accounts and
    // workers atomically. Never upsert: that could transfer somebody else's phone.
    // Handle the duplicate statement inside this transaction so the used challenge
    // and failure audit commit together, without revealing the existing owner.
    try {
      await execute('INSERT INTO phone_identities(user_id,phone_hash,phone_encrypted,firebase_uid_hash) VALUES (?,?,?,?)',[s.user_id,challenge.data.phoneHash,seal(proof.phone),hashToken(`firebase:${proof.uid}`)],conn);
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ER_DUP_ENTRY') throw error;
      await record(conn,'phone.verification.failure',s.user_id,{failure_reason:'PHONE_UNAVAILABLE'});
      return false;
    }
    await record(conn,'phone.verified',s.user_id);return true;
  });
}
