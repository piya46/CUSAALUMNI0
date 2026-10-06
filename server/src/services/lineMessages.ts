export function lineReference(id: string) {
  return `LN-${id.replaceAll('-', '').slice(0, 12).toUpperCase()}`;
}

const palette = {
  ink: '#493421', muted: '#887055', accent: '#B95310', line: '#EDE1CE',
  cream: '#FFFAF1', amber: '#FFF0D2', success: '#3E7052', danger: '#A3402E',
};

function referencePanel(reference: string, hint: string) {
  return { type: 'box', layout: 'vertical', backgroundColor: palette.cream, cornerRadius: '12px', paddingAll: '14px', spacing: 'xs', contents: [
    { type: 'text', text: `Ref: ${reference}`, weight: 'bold', size: 'sm', color: '#945414' },
    { type: 'text', text: hint, size: 'xs', wrap: true, color: palette.muted },
  ] };
}

export type LineDecision = 'approved' | 'denied';
export function matchingResultMessage(id: string, decision: LineDecision) {
  const approved = decision === 'approved';
  const title = approved ? 'ยืนยันเลขสำเร็จ' : 'คำขอถูกปฏิเสธ';
  const reference = lineReference(id);
  const tone = approved ? palette.success : palette.danger;
  return {
    type: 'flex', altText: `CUSA SSO · ${title} · Ref ${reference}`,
    contents: {
      type: 'bubble', size: 'mega',
      header: { type: 'box', layout: 'vertical', backgroundColor: approved ? '#EDF5EE' : '#FCEEE8', paddingAll: '24px', spacing: 'md', contents: [
        { type: 'text', text: 'CUSA SSO  /  ผลการยืนยัน', size: 'xs', weight: 'bold', color: tone },
        { type: 'text', text: `${approved ? '✓' : '✕'}  ${title}`, size: 'xl', weight: 'bold', color: tone, wrap: true },
        { type: 'text', text: approved ? 'ขั้นตอนถัดไปอยู่บนหน้าจอของคุณ' : 'คำขอนี้ใช้เข้าสู่ระบบไม่ได้', size: 'sm', color: tone, wrap: true },
      ] },
      body: { type: 'box', layout: 'vertical', paddingAll: '24px', spacing: 'lg', contents: [
        { type: 'text', text: approved ? 'กลับไปยังหน้าจอที่คุณเริ่มเข้าสู่ระบบ เพื่อให้ระบบตรวจสอบและดำเนินการต่อ' : 'เลขไม่ตรงกันหรือคุณเลือกปฏิเสธ หากต้องการเข้าใช้งาน ให้เริ่มคำขอใหม่จากหน้าจอ CUSA SSO', size: 'sm', wrap: true, color: palette.ink },
        referencePanel(reference, 'บันทึกผลแล้ว · คำขอนี้ใช้ยืนยันได้ครั้งเดียว'),
        { type: 'separator', color: palette.line },
        { type: 'text', text: 'ปุ่มเลือกเลขในคำขอเดิมจะไม่เปลี่ยนผลนี้', size: 'xs', wrap: true, color: palette.muted },
        ...(!approved ? [{ type: 'text', text: 'หากคุณไม่ได้เริ่มคำขอ โปรดตรวจสอบความปลอดภัยบัญชีของคุณ', size: 'xs', wrap: true, color: palette.danger }] : []),
      ] },
    },
  };
}

/** A reference correlates the screen and message; it never authorizes a login. */
export function matchingMessage(id: string, choices: { label: string; value: string }[], applicationName?: string | null) {
  const reference = lineReference(id);
  // A silent postback never creates a message on the user's behalf. The webhook
  // uses LINE's native loading indicator and sends only the committed result.
  const action = (choice: { label: string; value: string }) => ({
    type: 'postback', label: choice.label,
    data: `cusa_mfa=${id}&choice=${choice.value}`,
  });
  return {
    type: 'flex', altText: `CUSA SSO · ยืนยันเข้าสู่ระบบ · Ref ${reference} · เลือกเลขที่ตรงกับหน้าจอ`,
    contents: {
      type: 'bubble', size: 'mega',
      header: { type: 'box', layout: 'vertical', backgroundColor: palette.amber, paddingAll: '24px', spacing: 'md', contents: [
        { type: 'text', text: 'CUSA SSO  /  ยืนยันตัวตน', size: 'xs', weight: 'bold', color: '#99602C' },
        { type: 'text', text: 'นี่คือคุณใช่ไหม?', weight: 'bold', size: 'xl', color: '#693A16', wrap: true },
        { type: 'text', text: 'คำขอยืนยันเข้าสู่ระบบ', size: 'sm', color: '#8F5B29' },
      ] },
      body: { type: 'box', layout: 'vertical', paddingAll: '24px', spacing: 'lg', contents: [
        { type: 'box', layout: 'vertical', spacing: 'xs', contents: [
          { type: 'text', text: 'บริการที่กำลังเข้าใช้งาน', size: 'xs', color: palette.muted },
          { type: 'text', text: applicationName || 'บัญชี CUSA SSO', weight: 'bold', wrap: true, size: 'md', color: palette.ink },
        ] },
        referencePanel(reference, 'ตรวจ Ref ให้ตรงกัน · หมดอายุใน 3 นาที'),
        { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
          { type: 'text', text: '01  ดูเลข 2 หลักบนหน้าจอเข้าสู่ระบบ', size: 'sm', wrap: true, color: palette.ink },
          { type: 'text', text: '02  แตะเลขที่ตรงกันด้านล่าง', size: 'sm', wrap: true, color: palette.ink },
        ] },
      ] },
      footer: { type: 'box', layout: 'vertical', paddingAll: '24px', paddingTop: '0px', spacing: 'md', contents: [
        { type: 'box', layout: 'horizontal', spacing: 'sm', contents: choices.filter(c => c.label !== 'ปฏิเสธ').map(c => ({ type: 'button', style: 'primary', color: palette.accent, height: 'md', action: action(c) })) },
        ...choices.filter(c => c.label === 'ปฏิเสธ').map(c => ({ type: 'button', style: 'secondary', height: 'sm', action: action(c) })),
        { type: 'separator', color: palette.line, margin: 'lg' },
        { type: 'text', text: 'ไม่ได้เริ่มคำขอนี้? ให้กดปฏิเสธ\nห้ามบอกเลขหรืออนุมัติแทนผู้อื่น', size: 'xs', wrap: true, color: palette.danger },
      ] },
    },
  };
}
