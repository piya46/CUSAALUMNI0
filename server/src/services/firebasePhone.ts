import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth, type DecodedIdToken } from 'firebase-admin/auth';
import { config } from '../config.js';
import { HttpError } from '../middleware/security.js';
export function requireFirebasePhone(){if(!config.firebasePhoneEnabled)throw new HttpError(404,'SMS ยังไม่เปิดใช้งาน','NOT_FOUND');}
export function firebaseWebConfig(){
  return {apiKey:config.firebaseApiKey,authDomain:config.firebaseAuthDomain,projectId:config.firebaseProjectId,appId:config.firebaseAppId};
}
export function assertPhoneClaims(claims:DecodedIdToken,now=Math.floor(Date.now()/1000)) {
  if(claims.firebase?.sign_in_provider!=='phone'||typeof claims.phone_number!=='string'||!/^\+[1-9]\d{7,14}$/.test(claims.phone_number)
    ||!claims.uid||!Number.isInteger(claims.auth_time)||claims.auth_time>now+10||claims.auth_time<now-180)throw new HttpError(401,'ต้องยืนยัน SMS ใหม่ภายใน 3 นาที','INVALID_PHONE_PROOF');
  return {phone:claims.phone_number,uid:claims.uid,authenticatedAt:claims.auth_time};
}
export async function verifyFirebasePhoneToken(token:string){
  requireFirebasePhone();
  const app=getApps().find(a=>a.name==='cusa-phone')??initializeApp({projectId:config.firebaseProjectId,credential:cert({projectId:config.firebaseProjectId,clientEmail:config.firebaseClientEmail,privateKey:config.firebasePrivateKey})},'cusa-phone');
  try{return assertPhoneClaims(await getAuth(app).verifyIdToken(token,true));}
  catch{throw new HttpError(401,'ยืนยัน SMS ไม่สำเร็จ กรุณาส่งรหัสใหม่','INVALID_PHONE_PROOF');}
}
