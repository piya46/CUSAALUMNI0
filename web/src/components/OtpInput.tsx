import { useId, useRef, useState } from 'react';
import './otp-input.css';

export function OtpInput({value,onChange,name,label='รหัสยืนยัน 6 หลัก',disabled=false,autoFocus=false}: {
  value?:string;onChange?:(value:string)=>void;name?:string;label?:string;disabled?:boolean;autoFocus?:boolean;
}) {
  const [local,setLocal]=useState(''); const code=value??local; const id=useId();
  const inputs=useRef<Array<HTMLInputElement|null>>([]);
  function update(next:string) {setLocal(next);onChange?.(next);}
  function fill(raw:string,index:number) {
    const digits=raw.replace(/[^0-9]/g,'').slice(0,6); if(!digits) return;
    const start=digits.length===6?0:Math.min(index,code.length);
    const next=(code.slice(0,start)+digits+code.slice(start+digits.length)).slice(0,6);
    update(next); inputs.current[Math.min(start+digits.length,5)]?.focus();
  }
  return <fieldset className="otp-field" disabled={disabled}><legend id={id}>{label}</legend>
    <div className="otp-digits" role="group" aria-labelledby={id}>{Array.from({length:6},(_,i)=><input key={i}
      ref={element=>{inputs.current[i]=element;}} type="text" inputMode="numeric" autoComplete={i===0?'one-time-code':'off'}
      aria-label={`${label} หลักที่ ${i+1}`} value={code[i]??''} maxLength={6} pattern="[0-9]" required autoFocus={autoFocus&&i===0}
      onFocus={e=>e.currentTarget.select()} onPaste={e=>{e.preventDefault();fill(e.clipboardData.getData('text'),i);}}
      onChange={e=>{if(!e.target.value){update(code.slice(0,i));}else fill(e.target.value,i);}}
      onKeyDown={e=>{
        if(e.key==='Backspace'){e.preventDefault();const at=code[i]?i:Math.max(0,i-1);update(code.slice(0,at)+code.slice(at+1));inputs.current[at]?.focus();}
        if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();inputs.current[Math.max(0,Math.min(5,i+(e.key==='ArrowLeft'?-1:1)))]?.focus();}
      }} />)}</div>{name&&<input type="hidden" name={name} value={code}/>}</fieldset>;
}
