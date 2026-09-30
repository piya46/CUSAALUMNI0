import { createCipheriv,createDecipheriv,randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir,open,unlink,chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { config } from '../config.js';
import { resolveEvidenceDirectory } from './evidenceDirectory.js';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const options={limitInputPixels:20_000_000,failOn:'warning' as const};
function checkId(id:string){if(!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id))throw new Error('Invalid evidence ID');}
function master(){const key=Buffer.from(config.mfaEvidenceKey,'base64');if(key.length!==32)throw new Error('Evidence encryption is not configured');return key;}
function encrypt(value:Buffer,key:Buffer,aad:string){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(aad));const encrypted=Buffer.concat([cipher.update(value),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),encrypted]);}
function decrypt(value:Buffer,key:Buffer,aad:string){if(value.length<28)throw new Error('Invalid encrypted evidence');const cipher=createDecipheriv('aes-256-gcm',key,value.subarray(0,12));cipher.setAAD(Buffer.from(aad));cipher.setAuthTag(value.subarray(12,28));return Buffer.concat([cipher.update(value.subarray(28)),cipher.final()]);}
async function directory(){
  const folder=await resolveEvidenceDirectory(config.mfaEvidenceDir,root);
  await mkdir(folder,{recursive:true,mode:0o700});
  const actual=await resolveEvidenceDirectory(folder,root);
  await chmod(actual,0o700);return actual;
}
async function writeExclusive(path:string,data:Buffer){const file=await open(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);try{await file.writeFile(data);await file.sync();}finally{await file.close();}}
async function readPrivate(path:string){const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const info=await file.stat();if(!info.isFile()||info.size>8*1024*1024)throw new Error('Invalid evidence file');return await file.readFile();}finally{await file.close();}}
export async function watermarkEvidence(input:Buffer,id:string){
  checkId(id);if(input.length>5*1024*1024)throw new Error('Evidence too large');
  // Check the signature before libvips: never parse SVG/PDF or remote references.
  const jpeg=input[0]===0xff&&input[1]===0xd8&&input[2]===0xff;
  const png=input.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if(!jpeg&&!png)throw new Error('Only JPEG/PNG evidence is accepted');
  const meta=await sharp(input,options).metadata();if(!['jpeg','png'].includes(meta.format??'')||(meta.pages??1)!==1)throw new Error('Unsupported evidence');
  const normalized=await sharp(input,options).rotate().resize({width:1600,height:1600,fit:'inside',withoutEnlargement:true}).flatten({background:'#ffffff'}).jpeg({quality:85}).toBuffer({resolveWithObject:true});
  const {width,height}=normalized.info;const size=Math.max(11,Math.floor(width/36));
  const stamp=`CUSA SSO - MFA RESET ONLY - ${id.slice(0,8)} - ${new Date().toISOString().slice(0,10)}`;
  const lines=Array.from({length:5},(_,i)=>`<text x="${width/2}" y="${Math.round(height*(i+1)/6)}" text-anchor="middle" fill="#274b39" fill-opacity=".32" stroke="#ffffff" stroke-opacity=".35" stroke-width=".4" font-family="sans-serif" font-size="${size}">${stamp}</text>`).join('');
  const overlay=Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${lines}</svg>`);
  try{return await sharp(normalized.data,options).composite([{input:overlay}]).jpeg({quality:85}).toBuffer();}finally{normalized.data.fill(0);} // metadata stripped by default
}
export async function storeEvidence(id:string,image:Buffer){
  checkId(id);const folder=await directory(),key=randomBytes(32);
  try{
    await writeExclusive(resolve(folder,`${id}.enc`),encrypt(image,key,`${id}:image:v1`));
    await writeExclusive(resolve(folder,`${id}.key`),encrypt(key,master(),`${id}:key:v1`));
  }finally{key.fill(0);}
}
export async function readEvidence(id:string){
  checkId(id);const folder=await directory();const key=decrypt(await readPrivate(resolve(folder,`${id}.key`)),master(),`${id}:key:v1`);
  try{return decrypt(await readPrivate(resolve(folder,`${id}.enc`)),key,`${id}:image:v1`);}finally{key.fill(0);}
}
export async function destroyEvidence(id:string){
  checkId(id);const folder=await directory();
  // Remove the per-document key first. No original/plaintext image was written to disk.
  for(const extension of ['key','enc'])await unlink(resolve(folder,`${id}.${extension}`)).catch(error=>{if(error.code!=='ENOENT')throw error;});
}
