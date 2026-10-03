import { createHash, createHmac } from 'node:crypto';
import { config } from '../config.js';
import { safeEqual } from './crypto.js';
import { HttpError } from '../middleware/security.js';
import { matchingMessage, matchingResultMessage, type LineDecision } from './lineMessages.js';
export function requireLine(){if(!config.lineMfaEnabled)throw new HttpError(404,'LINE MFA ยังไม่เปิดใช้งาน','NOT_FOUND');}
async function lineFetch(url:string,body:URLSearchParams|object,bearer=false){
  const response=await fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{'Content-Type':bearer?'application/json':'application/x-www-form-urlencoded',...(bearer?{Authorization:`Bearer ${config.lineChannelAccessToken}`}:{})},body:bearer?JSON.stringify(body):String(body)});
  if(!response.ok)throw new Error('LINE_PROVIDER_UNAVAILABLE');
  return response.json() as Promise<Record<string,any>>;
}
export function lineLoginUrl(state:string,nonce:string,verifier:string){
  return `https://access.line.me/oauth2/v2.1/authorize?${new URLSearchParams({response_type:'code',client_id:config.lineLoginChannelId,redirect_uri:`${config.appOrigin}/api/auth/line/callback`,state,nonce,scope:'openid',code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url'),bot_prompt:'normal'})}`;
}
export async function exchangeLine(code:string,nonce:string,verifier:string){
  const tokens=await lineFetch('https://api.line.me/oauth2/v2.1/token',new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:`${config.appOrigin}/api/auth/line/callback`,client_id:config.lineLoginChannelId,client_secret:config.lineLoginChannelSecret,code_verifier:verifier}));
  if(typeof tokens.id_token!=='string')throw new Error('LINE_IDENTITY_REJECTED');
  const claims=await lineFetch('https://api.line.me/oauth2/v2.1/verify',new URLSearchParams({id_token:tokens.id_token,client_id:config.lineLoginChannelId,nonce}));
  if(claims.iss!=='https://access.line.me'||claims.aud!==config.lineLoginChannelId||claims.nonce!==nonce||claims.exp<=Date.now()/1000||!/^U[0-9a-f]{32}$/.test(claims.sub))throw new Error('LINE_IDENTITY_REJECTED');
  return claims.sub as string;
}
export async function sendLineMatching(subject:string,id:string,choices:{label:string;value:string}[],applicationName?:string|null){
  const response=await fetch('https://api.line.me/v2/bot/message/push',{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{Authorization:`Bearer ${config.lineChannelAccessToken}`,'Content-Type':'application/json','X-Line-Retry-Key':id},
    body:JSON.stringify({to:subject,messages:[matchingMessage(id,choices,applicationName)]})});
  if(!response.ok)throw new Error('LINE_DELIVERY_UNAVAILABLE');
}
export function validLineSignature(raw:Buffer,signature:string|undefined){
  return Boolean(config.lineMfaEnabled&&signature&&/^[A-Za-z0-9+/]{43}=$/.test(signature)&&safeEqual(signature,createHmac('sha256',config.lineMessagingChannelSecret).update(raw).digest('base64')));
}

export async function replyLineDecision(replyToken:string,id:string,decision:LineDecision){
  const response=await fetch('https://api.line.me/v2/bot/message/reply',{
    method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),
    headers:{Authorization:`Bearer ${config.lineChannelAccessToken}`,'Content-Type':'application/json'},
    body:JSON.stringify({replyToken,messages:[matchingResultMessage(id,decision)]}),
  });
  if(!response.ok)throw new Error('LINE_REPLY_UNAVAILABLE');
}
