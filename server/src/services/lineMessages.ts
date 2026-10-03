export function lineReference(id: string) {
  return `LN-${id.replaceAll('-', '').slice(0, 12).toUpperCase()}`;
}

export type LineDecision = 'approved' | 'denied';
export function matchingResultMessage(id: string, decision: LineDecision) {
  const approved = decision === 'approved';
  const title = approved ? 'ยืนยันเลขสำเร็จ' : 'คำขอถูกปฏิเสธ';
  const reference = lineReference(id);
  return {
    type: 'flex', altText: `CUSA SSO · ${title} · Ref ${reference}`,
    contents: {
      type: 'bubble', size: 'mega',
      header: { type: 'box', layout: 'vertical', backgroundColor: approved ? '#FFF0D2' : '#FCE9E3', paddingAll: '20px', spacing: 'sm', contents: [
        { type: 'text', text: 'CUSA SSO · ผลการยืนยัน', size: 'sm', color: '#795432' },
        { type: 'text', text: `${approved ? '✓' : '✕'} ${title}`, size: 'xl', weight: 'bold', color: approved ? '#8A4A12' : '#A3402E', wrap: true },
      ] },
      body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
        { type: 'text', text: approved ? 'กลับไปยังหน้าจอที่คุณเริ่มเข้าสู่ระบบ เพื่อให้ระบบตรวจสอบและดำเนินการต่อ' : 'เลขไม่ตรงกันหรือคุณเลือกปฏิเสธ คำขอนี้ใช้เข้าสู่ระบบไม่ได้ หากต้องการเข้าใช้งานให้เริ่มคำขอใหม่จากหน้าจอ CUSA SSO', size: 'sm', wrap: true, color: '#6E5742' },
        { type: 'text', text: `Ref: ${reference}`, weight: 'bold', size: 'sm', color: '#945414' },
        { type: 'separator', color: '#EFE1CE' },
        { type: 'text', text: 'บันทึกผลแล้ว ปุ่มเลือกเลขในคำขอเดิมจะไม่เปลี่ยนผลนี้', size: 'xs', wrap: true, color: '#79624C' },
        ...(!approved ? [{ type: 'text', text: 'หากคุณไม่ได้เริ่มคำขอ โปรดตรวจสอบความปลอดภัยบัญชีของคุณ', size: 'xs', wrap: true, color: '#A04832' }] : []),
      ] },
    },
  };
}

/** A reference correlates the screen and message; it never authorizes a login. */
export function matchingMessage(id: string, choices: { label: string; value: string }[], applicationName?: string | null) {
  const reference = lineReference(id);
  const action = (choice: { label: string; value: string }) => ({
    type: 'postback', label: choice.label,
    data: `cusa_mfa=${id}&choice=${choice.value}`,
    displayText: choice.label === 'ปฏิเสธ'
      ? 'ส่งคำขอปฏิเสธแล้ว กรุณาตรวจผลที่หน้า CUSA SSO'
      : 'ส่งเลขที่เลือกแล้ว กรุณากลับไปตรวจผลที่หน้า CUSA SSO',
  });
  return {
    type: 'flex', altText: `CUSA SSO · ยืนยันเข้าสู่ระบบ · Ref ${reference} · เลือกเลขที่ตรงกับหน้าจอ`,
    contents: {
      type: 'bubble', size: 'mega',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#FFF0D2', paddingAll: '20px', spacing: 'sm', contents: [
        { type: 'text', text: 'CUSA SSO', weight: 'bold', size: 'xl', color: '#693A16' },
        { type: 'text', text: 'คำขอยืนยันเข้าสู่ระบบ', size: 'sm', color: '#8F5B29' },
      ] },
      body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
        { type: 'text', text: applicationName ? `เพื่อเข้าใช้งาน ${applicationName}` : 'เพื่อเข้าใช้งานบัญชี CUSA SSO', weight: 'bold', wrap: true, color: '#493320' },
        { type: 'text', text: 'ดูเลข 2 หลักบนหน้าจอ แล้วเลือกเลขที่ตรงกันด้านล่าง', size: 'sm', wrap: true, color: '#79624C' },
        { type: 'box', layout: 'vertical', backgroundColor: '#FFFAEF', cornerRadius: '10px', paddingAll: '12px', spacing: 'xs', contents: [
          { type: 'text', text: `Ref: ${reference}`, size: 'sm', weight: 'bold', color: '#945414' },
          { type: 'text', text: 'ตรวจ Ref ให้ตรงกัน · หมดอายุใน 3 นาที', size: 'xs', wrap: true, color: '#79624C' },
        ] },
        { type: 'text', text: 'หากคุณไม่ได้เริ่มเข้าสู่ระบบ ให้กดปฏิเสธ ห้ามบอกเลขหรืออนุมัติแทนผู้อื่น', size: 'xs', wrap: true, color: '#A04832' },
      ] },
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
        { type: 'box', layout: 'horizontal', spacing: 'sm', contents: choices.filter(c => c.label !== 'ปฏิเสธ').map(c => ({ type: 'button', style: 'primary', color: '#B95310', height: 'sm', action: action(c) })) },
        ...choices.filter(c => c.label === 'ปฏิเสธ').map(c => ({ type: 'button', style: 'secondary', height: 'sm', action: action(c) })),
      ] },
    },
  };
}
