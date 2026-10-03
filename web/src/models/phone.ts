/** Local Thai mobile input only. The API and Firebase still receive E.164. */
export function thaiMobile(value: string): string | null {
  const digits = value.replace(/[๐-๙]/g, digit => String(digit.charCodeAt(0) - 0x0e50)).replace(/[\s()-]/g, '');
  if (/^0[689]\d{8}$/.test(digits)) return `+66${digits.slice(1)}`;
  if (/^\+?66[689]\d{8}$/.test(digits)) return `+${digits.replace(/^\+/, '')}`;
  return null;
}

export function displayThaiMobile(value: string): string {
  const normalized = thaiMobile(value);
  if (!normalized) return value;
  const local = `0${normalized.slice(3)}`;
  return `${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}`;
}
