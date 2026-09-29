import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp,readFile,writeFile,stat,rm,symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { config } from '../src/config.js';
import { watermarkEvidence,storeEvidence,readEvidence,destroyEvidence } from '../src/services/mfaEvidence.js';

test('evidence is watermarked without metadata, encrypted/authenticated, bound to ID, private and idempotently destroyed',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'cusa-evidence-unit-'));
  config.mfaEvidenceDir=dir;config.mfaEvidenceKey=Buffer.alloc(32,9).toString('base64');
  try{
    const id=randomUUID();const original=await sharp({create:{width:600,height:400,channels:3,background:'#dedede'}}).jpeg().withMetadata().toBuffer();
    const watermarked=await watermarkEvidence(original,id);assert.notDeepEqual(original,watermarked);
    const metadata=await sharp(watermarked).metadata();assert.equal(metadata.format,'jpeg');assert.equal(metadata.exif,undefined);
    await storeEvidence(id,watermarked);assert.deepEqual(await readEvidence(id),watermarked);
    const ciphertext=await readFile(join(dir,`${id}.enc`));assert.equal(ciphertext.includes(watermarked.subarray(0,30)),false);
    assert.equal((await stat(dir)).mode&0o777,0o700);assert.equal((await stat(join(dir,`${id}.enc`))).mode&0o777,0o600);
    const other=randomUUID();await writeFile(join(dir,`${other}.enc`),ciphertext);await writeFile(join(dir,`${other}.key`),await readFile(join(dir,`${id}.key`)));
    await assert.rejects(readEvidence(other));
    ciphertext[ciphertext.length-1]^=1;await writeFile(join(dir,`${id}.enc`),ciphertext);await assert.rejects(readEvidence(id));
    await destroyEvidence(id);await destroyEvidence(id);await assert.rejects(readEvidence(id));
    await assert.rejects(watermarkEvidence(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),id));
    await assert.rejects(watermarkEvidence(Buffer.from('not a photo'),id));
    await assert.rejects(readEvidence('../outside'));
    const linked=randomUUID();await symlink(join(dir,`${other}.key`),join(dir,`${linked}.key`));await assert.rejects(readEvidence(linked));
  }finally{await rm(dir,{recursive:true,force:true});}
});
