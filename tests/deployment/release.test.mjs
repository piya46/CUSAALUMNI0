import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,mkdir,writeFile,rm,symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectReleaseFiles,releaseContent,assertNoSecrets } from '../../scripts/lib/release-files.mjs';

test('release file allowlist excludes external private data and rejects hidden secrets and symlinks inside selected roots',async()=>{
  const root=await mkdtemp(join(tmpdir(),'cusa-package-test-'));
  try{
    await mkdir(join(root,'src'));await mkdir(join(root,'var'));
    await writeFile(join(root,'src/index.js'),'// public code');await writeFile(join(root,'src/index.js.map'),'not bundled');
    await writeFile(join(root,'.env'),'REAL_SECRET=private');await writeFile(join(root,'var/document.enc'),'private evidence');
    assert.deepEqual(await collectReleaseFiles(root,['src']),['src/index.js']);
    await writeFile(join(root,'src/.env'),'private');await assert.rejects(collectReleaseFiles(root,['src']));await rm(join(root,'src/.env'));
    await symlink(join(root,'.env'),join(root,'src/config.js'));await assert.rejects(collectReleaseFiles(root,['src']));
    await assert.rejects(releaseContent(root,'src/config.js',[]));
    await assert.rejects(collectReleaseFiles(root,['../outside']));
    assert.throws(()=>assertNoSecrets(Buffer.from('prefix configured-secret-123 suffix'),['configured-secret-123']));
    assert.throws(()=>assertNoSecrets(Buffer.from('-----BEGIN PRIVATE KEY-----\nfixture')));
  }finally{await rm(root,{recursive:true,force:true});}
});
