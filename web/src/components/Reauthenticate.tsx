import { useState } from 'react';
import { api } from '../models/api';
import { Modal } from './ui';
import { OtpInput } from './OtpInput';
export function Reauthenticate({complete,cancel}:{complete:()=>void;cancel:()=>void}) {
  const [code,setCode]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  return <Modal title="ยืนยันก่อนเปลี่ยนแปลงสิทธิ์" description="กรอกรหัสปัจจุบันจาก Authenticator เพื่อดำเนินการต่อ" close={cancel} busy={busy}>
    {error&&<p role="alert" className="inline-error">{error}</p>}
    <form onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{await api('/auth/reauth','POST',{code});complete();}catch(err){setError((err as Error).message);setCode('');}finally{setBusy(false);}}}>
      <OtpInput value={code} onChange={setCode} autoFocus disabled={busy}/><button className="button primary full-width" disabled={busy||code.length!==6}>{busy?'กำลังตรวจสอบ…':'ยืนยันและดำเนินการต่อ'}</button>
    </form></Modal>;
}
