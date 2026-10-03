import { useState } from 'react';
import { Fingerprint } from 'lucide-react';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { api } from '../models/api';
import { Modal } from './ui';
import { OtpInput } from './OtpInput';
export function Reauthenticate({complete,cancel,passkeyAvailable=false}:{complete:()=>void;cancel:()=>void;passkeyAvailable?:boolean}) {
  const [code,setCode]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  async function verifyPasskey(){
    setBusy(true);setError('');
    try{
      const {startAuthentication}=await import('@simplewebauthn/browser');
      const result=await api<{challengeId:string;options:PublicKeyCredentialRequestOptionsJSON}>('/auth/passkeys/reauth/options','POST',{},false);
      const response=await startAuthentication({optionsJSON:result.options});
      await api('/auth/passkeys/reauth/verify','POST',{challengeId:result.challengeId,response},false);
      complete();
    }catch(err){setError(err instanceof Error && err.name==='NotAllowedError'?'ยังไม่ได้ยืนยัน Passkey ลองอีกครั้งหรือใช้ Authenticator':(err as Error).message);}
    finally{setBusy(false);}
  }
  return <Modal title="ยืนยันก่อนเปลี่ยนแปลงสิทธิ์" description={passkeyAvailable?'เลือก Passkey หรือกรอกรหัส Authenticator เพื่อดำเนินการต่อ':'กรอกรหัสปัจจุบันจาก Authenticator เพื่อดำเนินการต่อ'} close={cancel} busy={busy}>
    {error&&<p role="alert" className="inline-error">{error}</p>}
    {passkeyAvailable&&<div className="extra-mfa"><button className="button secondary full-width" disabled={busy} onClick={()=>void verifyPasskey()}><Fingerprint size={18}/>ยืนยันด้วย Passkey</button><p>หรือใช้ Authenticator</p></div>}
    <form onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{await api('/auth/reauth','POST',{code},false);complete();}catch(err){setError((err as Error).message);setCode('');}finally{setBusy(false);}}}>
      <OtpInput value={code} onChange={setCode} autoFocus disabled={busy}/><button className="button primary full-width" disabled={busy||code.length!==6}>{busy?'กำลังตรวจสอบ…':'ยืนยันและดำเนินการต่อ'}</button>
    </form></Modal>;
}
