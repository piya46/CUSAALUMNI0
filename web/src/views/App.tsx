import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowRight, ChevronDown, ChevronRight, CircleHelp, Download, Fingerprint, LoaderCircle, LockKeyhole, LogOut, Menu, Plus, RefreshCw, ShieldCheck, Sparkles, X } from 'lucide-react';
import QRCode from 'qrcode';
import { api, ApiError, setCsrfToken } from '../models/api';
import { demoIdentity, makeDemoData } from '../models/demo';
import { emptyData } from '../models/types';
import type { ApiKey, Application, Dataset, Identity, Page, PageMeta } from '../models/types';
import { Avatar, Brand, CopyButton, Modal, Spinner, Toast } from '../components/ui';
import { ContinueLogin, Login, LoginRequest, Mfa } from './Auth';
import { LegalLinks } from '../components/LegalLinks';
import { getLoginContext, type LoginContext } from '../models/login';
import type { ServerStatus } from './Auth';
import { navItems, PageView } from './Pages';
import type { RevokeKind } from './Pages';

type Dialog = { type: 'email' | 'application' | 'key' | 'disableTotp' | 'regenerateCodes' } | { type: 'revoke'; entity: RevokeKind; id: string; label: string; current?: boolean } | { type: 'totp'; secret: string; uri: string; recoveryCodes: string[] } | { type: 'secret'; key: string } | { type: 'recoveryCodes'; recoveryCodes: string[] };
const collectionMap: Partial<Record<Page, { path: string; field: keyof Dataset; response: string }>> = {
  users: { path: '/admin/users', field: 'users', response: 'users' },
  allowlist: { path: '/admin/allowlist', field: 'emails', response: 'emails' },
  applications: { path: '/admin/applications', field: 'applications', response: 'applications' },
  keys: { path: '/admin/api-keys', field: 'apiKeys', response: 'apiKeys' },
  audit: { path: '/admin/audit', field: 'events', response: 'events' },
};
const baseMeta: PageMeta = { total: 0, totalPages: 1, currentPage: 1, limit: 10 };
export type AuditFilters = { event: string; email: string; startDate: string; endDate: string; status: string };
const noFilters: AuditFilters = { event: '', email: '', startDate: '', endDate: '', status: '' };
const uid = () => crypto.randomUUID();
const demoCodes = () => Array.from({ length: 8 }, () => `DEMO-${crypto.randomUUID().slice(0, 14)}`);

export default function App() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [initialized, setInitialized] = useState(false);
  const [returnTo] = useState(() => new URLSearchParams(window.location.search).get('returnTo'));
  const [loginContext, setLoginContext] = useState<LoginContext | null>(null);
  const [loginError, setLoginError] = useState('');
  const accessDenied = new URLSearchParams(window.location.search).get('auth') === 'access_denied';
  const [demo, setDemo] = useState(false);
  const [page, setPage] = useState<Page>('overview');
  const [data, setData] = useState<Dataset>(emptyData);
  const [applicationOptions, setApplicationOptions] = useState<Application[]>([]);
  const [dataReady, setDataReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [pageNumber, setPageNumber] = useState(1);
  const [meta, setMeta] = useState<PageMeta>(baseMeta);
  const [auditFilters, setAuditFilters] = useState<AuditFilters>(noFilters);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [modalError, setModalError] = useState('');
  const [busy, setBusy] = useState(false);
  const [qrCode, setQrCode] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; error: boolean } | null>(null);
  const requestId = useRef(0);
  const notify = useCallback((message: string, error = false) => setToast({ message, error }), []);
  const closeDialog = useCallback(() => { setDialog(null); setModalError(''); }, []);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), 5500); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(null), 2500); return () => clearTimeout(timer); }, [copied]);
  useEffect(() => {
    setQrCode('');
    if (dialog?.type === 'totp') { let active = true; void QRCode.toDataURL(dialog.uri, { width: 210, margin: 2, color: { dark: '#152a2a', light: '#ffffff' } }).then(url => { if (active) setQrCode(url); }).catch(() => {}); return () => { active = false; }; }
  }, [dialog]);

  async function checkIdentity() {
    setChecking(true);
    const [serverResult, authResult] = await Promise.allSettled([api<ServerStatus>('/auth/status'), api<Identity>('/auth/me')]);
    setStatus(serverResult.status === 'fulfilled' ? serverResult.value : null);
    if (authResult.status === 'fulfilled') {
      setIdentity(authResult.value); setCsrfToken(authResult.value.csrfToken);
      if (authResult.value.user.role !== 'admin') setPage('security');
    }
    setChecking(false); setInitialized(true);
  }
  useEffect(() => { void checkIdentity(); }, []);
  async function checkLoginContext() {
    if (returnTo === null) return;
    setLoginError('');
    try { setLoginContext(await getLoginContext(returnTo)); }
    catch { setLoginError('ไม่สามารถตรวจสอบแอปปลายทางได้ หรือคำขอเข้าสู่ระบบไม่ถูกต้อง'); }
  }
  useEffect(() => { void checkLoginContext(); }, [returnTo]);

  async function loadData() {
    if (!identity || identity.requiresMfa || demo || (returnTo !== null && identity.mfaMethod !== 'recovery')) return;
    setLoading(true);
    try {
      if (identity.user.role === 'admin') {
        const [overview, users, emails, applications, keys, audit, sessions] = await Promise.all([
          api<{ stats: Dataset['stats'] }>('/admin/overview'),
          api<{ users: Dataset['users'] }>('/admin/users?limit=10&page=1'),
          api<{ emails: Dataset['emails'] }>('/admin/allowlist?limit=10&page=1'),
          api<{ applications: Dataset['applications'] }>('/admin/applications?limit=100&page=1'),
          api<{ apiKeys: Dataset['apiKeys'] }>('/admin/api-keys?limit=10&page=1'),
          api<{ events: Dataset['events'] }>('/admin/audit?limit=10&page=1'),
          api<{ sessions: Dataset['sessions'] }>('/auth/sessions'),
        ]);
        setData({ ...emptyData, stats: overview.stats, users: users.users, emails: emails.emails, applications: applications.applications, apiKeys: keys.apiKeys, events: audit.events, sessions: sessions.sessions });
        setApplicationOptions(applications.applications);
      } else {
        const sessions = await api<{ sessions: Dataset['sessions'] }>('/auth/sessions');
        setData({ ...emptyData, sessions: sessions.sessions });
      }
      setDataReady(true);
    } catch (error) { handleError(error); } finally { setLoading(false); }
  }
  useEffect(() => { if (identity && !identity.requiresMfa && !demo) void loadData(); }, [identity?.user.id, identity?.requiresMfa, demo]);
  useEffect(() => {
    const collection = collectionMap[page];
    if (!identity || identity.requiresMfa || demo || !dataReady || !collection) return;
    const currentRequest = ++requestId.current;
    const timer = setTimeout(() => {
      setLoading(true);
      const params = new URLSearchParams({ page: String(pageNumber), limit: '10', search });
      if (page === 'audit') Object.entries(auditFilters).forEach(([key, value]) => { if (value) params.set(key, value); });
      void api<Record<string, unknown>>(`${collection.path}?${params}`).then(result => {
        if (currentRequest !== requestId.current) return;
        setData(previous => ({ ...previous, [collection.field]: result[collection.response] }));
        setMeta(result.meta as PageMeta || { ...baseMeta, total: (result[collection.response] as unknown[]).length });
      }).catch(error => { if (currentRequest === requestId.current) handleError(error); }).finally(() => { if (currentRequest === requestId.current) setLoading(false); });
    }, search || page === 'audit' ? 300 : 0);
    return () => { clearTimeout(timer); requestId.current++; };
  }, [page, search, pageNumber, demo, dataReady, identity?.user.id, identity?.requiresMfa, auditFilters]);

  function handleError(error: unknown) {
    notify((error as Error).message || 'เกิดข้อผิดพลาด กรุณาลองอีกครั้ง', true);
    if (error instanceof ApiError && error.status === 401) { setIdentity(null); setData(emptyData); setDataReady(false); }
  }
  function navigate(next: Page) { setPage(next); setSearch(''); setPageNumber(1); setMeta(baseMeta); setMobileOpen(false); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  function enterDemo() { const sample = makeDemoData(); setDemo(true); setData(sample); setApplicationOptions(sample.applications); setIdentity({ ...demoIdentity, recoveryCodesRemaining: 8 }); setDataReady(true); navigate('overview'); }
  async function logout() {
    if (!demo) { try { await api('/auth/logout', 'POST', {}); } catch (error) { handleError(error); return; } }
    setDialog(null); setIdentity(null); setData(emptyData); setDataReady(false); setDemo(false); setCsrfToken('');
  }
  async function onVerified() {
    const next = await api<Identity>('/auth/me'); setIdentity(next); setCsrfToken(next.csrfToken);
    if (next.mfaMethod === 'recovery') navigate('security');
    else if (loginContext) window.location.assign(loginContext.returnTo);
    else if (next.user.role !== 'admin') navigate('security');
  }
  async function refresh() {
    if (demo) { notify('ข้อมูลตัวอย่างเป็นสถานะล่าสุดแล้ว'); return; }
    await loadData();
    setDataReady(false); setTimeout(() => setDataReady(true), 0);
  }
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); setCopied(value); }
    catch { notify('คัดลอกอัตโนมัติไม่ได้ กรุณาเลือกข้อความและคัดลอกด้วยตนเอง', true); }
  }
  function downloadCodes(codes: string[]) {
    const blob = new Blob([`CUSA SSO recovery codes\nAccount: ${identity?.user.email}\nCreated: ${new Date().toISOString()}\n${demo ? 'DEMO ONLY — these codes cannot authenticate.\n' : ''}Keep private. Each code works once.\n\n${codes.join('\n')}\n`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'cusa-recovery-codes.txt'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function demoUpdate(updater: (previous: Dataset) => Dataset, event: string, target: string) {
    setData(previous => {
      const next = updater(previous);
      next.stats = { ...next.stats, users: next.users.length, allowedEmails: next.emails.length, applications: next.applications.filter(a => !a.revokedAt).length, activeApiKeys: next.apiKeys.filter(k => !k.revokedAt && new Date(k.expiresAt).getTime() > Date.now()).length, mfaEnabled: next.users.filter(u => u.totpEnabled).length };
      next.events = [{ id: uid(), actorEmail: identity!.user.email, event, target, ip: '192.0.2.10', metadata: { demo: true }, createdAt: new Date().toISOString(), status: 'success' }, ...next.events];
      return next;
    });
  }
  async function setupTotp() {
    if (busy) return; setBusy(true); setModalError('');
    try {
      const result = demo ? { secret: 'JBSWY3DPEHPK3PXP', uri: `otpauth://totp/CUSA%20Demo:${identity!.user.email}?secret=JBSWY3DPEHPK3PXP&issuer=CUSA%20Demo`, recoveryCodes: demoCodes() } : await api<{ secret: string; uri: string; recoveryCodes: string[] }>('/auth/totp/setup', 'POST', {});
      setDialog({ type: 'totp', ...result });
    } catch (error) { handleError(error); } finally { setBusy(false); }
  }
  function open(kind: 'email' | 'application' | 'key') { setModalError(''); setDialog({ type: kind }); }
  function revoke(entity: RevokeKind, id: string, label: string, current?: boolean) { setModalError(''); setDialog({ type: 'revoke', entity, id, label, current }); }
  async function submitDialog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!dialog || !identity || busy) return;
    const values = new FormData(event.currentTarget); const value = (key: string) => String(values.get(key) || '').trim();
    setBusy(true); setModalError('');
    try {
      switch (dialog.type) {
        case 'email': {
          const email = value('email').toLowerCase(); const role = value('role') as 'admin' | 'user';
          if (demo) {
            if (data.emails.some(e => e.email === email)) throw new Error('อีเมลนี้ได้รับอนุญาตแล้ว');
            demoUpdate(d => ({ ...d, emails: [{ id: uid(), email, role, createdAt: new Date().toISOString() }, ...d.emails] }), 'allowlist.created', email);
          } else await api('/admin/allowlist', 'POST', { email, role });
          notify('เพิ่มอีเมลที่อนุญาตแล้ว'); break;
        }
        case 'application': {
          const fields = { name: value('name'), description: value('description'), redirectUri: value('redirectUri') };
          const url = new URL(fields.redirectUri);
          if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Redirect URI ต้องเป็น HTTPS หรือ HTTP localhost สำหรับพัฒนา');
          if (url.hash || url.username || url.password) throw new Error('Redirect URI ต้องไม่มี fragment หรือข้อมูลบัญชีใน URL');
          if (demo) { const app = { id: uid(), ...fields, createdAt: new Date().toISOString(), revokedAt: null }; demoUpdate(d => ({ ...d, applications: [app, ...d.applications] }), 'application.created', fields.name); setApplicationOptions(options => [app, ...options]); }
          else await api('/admin/applications', 'POST', fields);
          notify('เพิ่มแอปพลิเคชันแล้ว'); break;
        }
        case 'key': {
          const scopes = values.getAll('scopes').map(String);
          if (!scopes.length) throw new Error('เลือกอย่างน้อยหนึ่ง scope');
          const fields = { applicationId: value('applicationId'), name: value('name'), scopes, expiresInDays: Number(value('expiresInDays')) };
          let key: string;
          if (demo) { key = `DEMO_UI_ONLY_${uid().replace(/-/g, '')}`; const apiKey: ApiKey = { id: uid(), ...fields, prefix: 'DEMO_UI_ONLY', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + fields.expiresInDays * 86400000).toISOString(), lastUsedAt: null, revokedAt: null }; demoUpdate(d => ({ ...d, apiKeys: [apiKey, ...d.apiKeys] }), 'api_key.created', fields.name); }
          else { const result = await api<{ key: string }>('/admin/api-keys', 'POST', fields); key = result.key; await loadData(); }
          setDialog({ type: 'secret', key }); notify('สร้าง API key แล้ว'); return;
        }
        case 'revoke': {
          const paths = { user: '/admin/users', email: '/admin/allowlist', application: '/admin/applications', key: '/admin/api-keys', session: '/auth/sessions' };
          if (demo) {
            if (dialog.entity === 'user' && dialog.id === identity.user.id) throw new Error('ไม่สามารถลบสิทธิ์ของบัญชีปัจจุบันได้');
            const now = new Date().toISOString();
            demoUpdate(d => {
              if (dialog.entity === 'user') { const user = d.users.find(u => u.id === dialog.id); return { ...d, users: d.users.filter(u => u.id !== dialog.id), emails: d.emails.filter(e => e.email !== user?.email) }; }
              if (dialog.entity === 'email') { const email = d.emails.find(e => e.id === dialog.id); return { ...d, emails: d.emails.filter(e => e.id !== dialog.id), users: d.users.filter(u => u.email !== email?.email) }; }
              if (dialog.entity === 'application') { setApplicationOptions(options => options.map(a => a.id === dialog.id ? { ...a, revokedAt: now } : a)); return { ...d, applications: d.applications.map(a => a.id === dialog.id ? { ...a, revokedAt: now } : a), apiKeys: d.apiKeys.map(k => k.applicationId === dialog.id ? { ...k, revokedAt: now } : k) }; }
              if (dialog.entity === 'key') return { ...d, apiKeys: d.apiKeys.map(k => k.id === dialog.id ? { ...k, revokedAt: now } : k) };
              return { ...d, sessions: d.sessions.filter(s => s.id !== dialog.id), stats: { ...d.stats, activeSessions: Math.max(0, d.stats.activeSessions - 1) } };
            }, `${dialog.entity === 'email' ? 'allowlist' : dialog.entity === 'key' ? 'api_key' : dialog.entity}.${['user', 'email'].includes(dialog.entity) ? 'deleted' : 'revoked'}`, dialog.label);
          } else await api(`${paths[dialog.entity]}/${encodeURIComponent(dialog.id)}`, 'DELETE');
          if (dialog.entity === 'session' && dialog.current) { setDialog(null); setIdentity(null); setDemo(false); setDataReady(false); setData(emptyData); notify('ยกเลิกเซสชันปัจจุบันแล้ว'); return; }
          notify('ยกเลิกสิทธิ์การเข้าถึงแล้ว'); break;
        }
        case 'totp':
        case 'disableTotp': {
          const enabled = dialog.type === 'totp';
          if (demo) { setIdentity(i => i ? { ...i, user: { ...i.user, totpEnabled: enabled }, mfaMethod: enabled ? 'totp' : 'email', recoveryCodesRemaining: enabled ? 8 : 0 } : null); demoUpdate(d => ({ ...d, users: d.users.map(u => u.id === identity.user.id ? { ...u, totpEnabled: enabled } : u) }), enabled ? 'totp.enabled' : 'totp.disabled', identity.user.email); }
          else { await api(`/auth/totp/${enabled ? 'enable' : 'disable'}`, 'POST', { code: value('code') }); const next = await api<Identity>('/auth/me'); setIdentity(next); setCsrfToken(next.csrfToken); }
          notify(enabled ? 'เปิดใช้งาน Authenticator แล้ว' : 'ปิด Authenticator แล้ว การเข้าสู่ระบบครั้งถัดไปจะใช้ Email OTP'); break;
        }
        case 'regenerateCodes': {
          const result = demo ? { recoveryCodes: demoCodes() } : await api<{ recoveryCodes: string[] }>('/auth/recovery/regenerate', 'POST', { code: value('code') });
          setIdentity(i => i ? { ...i, recoveryCodesRemaining: result.recoveryCodes.length } : null);
          setDialog({ type: 'recoveryCodes', ...result }); notify('สร้างรหัสชุดใหม่แล้ว รหัสชุดเดิมถูกยกเลิก'); return;
        }
        case 'secret': case 'recoveryCodes': closeDialog(); return;
      }
      closeDialog();
      if (!demo) { await loadData(); setPageNumber(1); setSearch(''); setDataReady(false); setTimeout(() => setDataReady(true), 0); }
    } catch (error) { setModalError((error as Error).message); } finally { setBusy(false); }
  }

  if (!initialized) return <div className="startup"><Brand /><Spinner label="กำลังเชื่อมต่อพื้นที่ทำงาน…" /></div>;
  if (returnTo !== null && !loginContext) return <LoginRequest error={loginError} onRetry={() => void checkLoginContext()} />;
  if (!identity) return <><Login context={loginContext} status={status} checking={checking} onDemo={enterDemo} onRetry={() => void checkIdentity()} />{toast && <Toast {...toast} close={() => setToast(null)} />}</>;
  if (identity.requiresMfa) return <><Mfa context={loginContext} identity={identity} onVerified={onVerified} onLogout={logout} />{toast && <Toast {...toast} close={() => setToast(null)} />}</>;
  if (loginContext && (identity.mfaMethod !== 'recovery' || accessDenied)) return <ContinueLogin denied={accessDenied} identity={identity} context={loginContext} onLogout={logout} />;

  let displayedData = data; let displayedMeta = meta;
  const collection = collectionMap[page];
  if (demo && collection) {
    let list = (data[collection.field] as unknown as Record<string, unknown>[]).filter(row => Object.values(row).some(v => typeof v === 'string' && v.toLowerCase().includes(search.toLowerCase())));
    if (page === 'audit') list = list.filter(row => (!auditFilters.event || String(row.event).toLowerCase().includes(auditFilters.event.toLowerCase())) && (!auditFilters.email || String(row.actorEmail).toLowerCase().includes(auditFilters.email.toLowerCase())) && (!auditFilters.startDate || new Date(String(row.createdAt)) >= new Date(auditFilters.startDate)) && (!auditFilters.endDate || new Date(String(row.createdAt)) <= new Date(`${auditFilters.endDate}T23:59:59.999`)) && (!auditFilters.status || (row.status || 'success') === auditFilters.status));
    const totalPages = Math.max(1, Math.ceil(list.length / 10)); const currentPage = Math.min(pageNumber, totalPages);
    displayedMeta = { total: list.length, currentPage, totalPages, limit: 10 };
    displayedData = { ...data, [collection.field]: list.slice((currentPage - 1) * 10, currentPage * 10) };
  }
  const title = navItems.find(item => item.page === page)?.label;
  const allowedApps = applicationOptions.filter(a => !a.revokedAt);
  const codes = dialog?.type === 'totp' || dialog?.type === 'recoveryCodes' ? dialog.recoveryCodes : [];
  const modalTitles = { email: 'เพิ่มอีเมลที่อนุญาต', application: 'เพิ่มแอปพลิเคชัน', key: 'สร้าง API key', revoke: 'ยืนยันการยกเลิกสิทธิ์', totp: 'ตั้งค่า Authenticator', disableTotp: 'ปิดใช้งาน Authenticator', regenerateCodes: 'สร้าง Recovery codes ชุดใหม่', secret: 'บันทึก API key ของคุณ', recoveryCodes: 'บันทึก Recovery codes' };
  return <div className="app-shell"><a className="skip-link" href="#main-content">ข้ามไปยังเนื้อหา</a>{mobileOpen && <div className="sidebar-scrim" onClick={() => setMobileOpen(false)} />}<aside className={`sidebar ${mobileOpen ? 'open' : ''}`}><div className="sidebar-brand"><Brand /><button className="icon-button mobile-only" onClick={() => setMobileOpen(false)} aria-label="ปิดเมนู"><X size={21} /></button></div><div className="workspace-switch"><span className="workspace-symbol">C</span><div><strong>CUSA Workspace</strong><small>{demo ? 'Demo workspace' : 'Identity management'}</small></div><LockKeyhole size={14} /></div><nav aria-label="เมนูหลัก">{[0, 1, 2].map(group => <div className="nav-group" key={group}><span className="nav-group-label">{group === 0 ? 'WORKSPACE' : group === 1 ? 'SECURITY & ACCESS' : 'DEVELOPERS'}</span>{navItems.filter(item => item.group === group && (!item.admin || identity.user.role === 'admin')).map(({ page: destination, icon: Icon, label }) => <button key={destination} className={`nav-item ${page === destination ? 'active' : ''}`} aria-current={page === destination ? 'page' : undefined} onClick={() => navigate(destination)}><Icon size={18} strokeWidth={1.7} /><span>{label}</span>{destination === 'users' && <small>{data.stats.users}</small>}{page === destination && destination !== 'users' && <span className="nav-active-dot" />}</button>)}</div>)}</nav><div className="sidebar-bottom"><div className="protected-card"><div><ShieldCheck size={18} /><strong>{demo ? 'Demo environment' : 'Identity protected'}</strong><span className="status-dot" /></div><p>{demo ? 'ทดลองหน้าจอด้วยข้อมูลจำลอง' : 'Google SSO + multi-factor auth'}</p></div><div className="sidebar-account"><Avatar name={identity.user.name || identity.user.email} small /><div><strong>{identity.user.name || 'My account'}</strong><small>{identity.user.role === 'admin' ? 'Workspace admin' : 'Workspace member'}</small></div><button className="logout-button" aria-label={demo ? 'ออกจากโหมดตัวอย่าง' : 'ออกจากระบบ'} title="ออกจากระบบ" onClick={() => void logout()}><LogOut size={17} /></button></div></div></aside><div className="main-shell"><header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-only" onClick={() => setMobileOpen(true)} aria-label="เปิดเมนู"><Menu size={21} /></button><span>Workspace</span><ChevronRight size={14} /><strong>{title}</strong></div><div className="topbar-actions"><span className="topbar-status"><span className="status-dot" />{demo ? 'Demo workspace' : 'Authenticated session'}</span><span className="topbar-divider" /><button className="icon-button" aria-label="รีเฟรชข้อมูล" title="รีเฟรชข้อมูล" disabled={loading} onClick={() => void refresh()}><RefreshCw size={17} className={loading ? 'spin' : ''} /></button>{identity.user.role === 'admin' && <button className="icon-button" aria-label="คู่มือเชื่อมต่อ" title="คู่มือเชื่อมต่อ" onClick={() => navigate('integration')}><CircleHelp size={18} /></button>}<button className="topbar-avatar" aria-label="ดูความปลอดภัยบัญชี" onClick={() => navigate('security')}><Avatar name={identity.user.name} small /><ChevronDown size={13} /></button></div></header>{demo && <div className="demo-banner"><span><Sparkles size={14} /><strong>โหมดตัวอย่าง</strong><span>ข้อมูลจำลองสำหรับทดลอง UI · ไม่ใช่การยืนยันตัวตนจริง · รีเซ็ตเมื่อโหลดหน้าใหม่</span></span><button onClick={() => void logout()}>ออกจากโหมดตัวอย่าง<ArrowRight size={13} /></button></div>}{loginContext && <div className="sso-resume"><span>หลังตั้งค่าความปลอดภัย คุณสามารถกลับไปยัง {loginContext.application.name}</span><a className="text-link" href={loginContext.returnTo}>ดำเนินการต่อ<ArrowRight size={15} /></a></div>}<main className="page-content" id="main-content" aria-busy={loading}>{loading && <div className="page-progress" />}{!dataReady && loading ? <Spinner label="กำลังโหลดพื้นที่ทำงาน…" /> : <PageView updateDemo={setData} reload={refresh} page={page} data={displayedData} identity={identity} demo={demo} search={search} setSearch={value => { setSearch(value); setPageNumber(1); }} navigate={navigate} create={open} revoke={revoke} setupTotp={() => void setupTotp()} disableTotp={() => { setModalError(''); setDialog({ type: 'disableTotp' }); }} regenerateCodes={() => { setModalError(''); setDialog({ type: 'regenerateCodes' }); }} copied={copied} copy={value => void copy(value)} meta={displayedMeta} setPageNumber={setPageNumber} auditFilters={auditFilters} setAuditFilters={filters => { setAuditFilters(filters); setPageNumber(1); }} />}</main><footer className="app-footer"><span>© {new Date().getFullYear()} CUSA SSO</span><LegalLinks /></footer></div>{dialog && <Modal title={modalTitles[dialog.type]} description={dialog.type === 'revoke' ? 'ตรวจสอบรายการก่อนดำเนินการ' : dialog.type === 'secret' ? 'คีย์ฉบับเต็มจะแสดงครั้งเดียวในหน้าต่างนี้' : undefined} close={closeDialog} busy={busy}>{demo && <div className="modal-demo-note"><Sparkles size={14} />ข้อมูลในโหมดตัวอย่าง ใช้เข้าสู่ระบบจริงไม่ได้</div>}{modalError && <div className="inline-error" role="alert">{modalError}</div>}<form onSubmit={submitDialog}>
      {dialog.type === 'email' && <><label className="field">อีเมล Google<input name="email" type="email" placeholder="name@gmail.com" maxLength={254} required autoComplete="off" /></label><label className="field">สิทธิ์เมื่อเข้าสู่ระบบ<select name="role" defaultValue="user"><option value="user">Member — ผู้ใช้งานทั่วไป</option><option value="admin">Admin — จัดการผู้ใช้และการเข้าถึงทั้งหมด</option></select></label><div className="field-hint"><ShieldCheck size={15} />เพิ่มเฉพาะบัญชี Google ที่คุณต้องการอนุญาต ผู้ใช้จะต้องยืนยันสองขั้นตอนเมื่อเข้าสู่ระบบ</div></>}
      {dialog.type === 'application' && <><label className="field">ชื่อแอปพลิเคชัน<input name="name" placeholder="เช่น People & HR" maxLength={100} required /></label><label className="field">คำอธิบาย <span>(ไม่จำเป็น)</span><textarea name="description" placeholder="ระบบนี้ใช้สำหรับอะไร" maxLength={500} rows={3} /></label><label className="field">Redirect URI<input name="redirectUri" type="url" placeholder="https://app.example.com/auth/callback" maxLength={2048} required /></label><p className="field-hint">ต้องเป็น HTTPS และตรงกับ callback ของแอปทุกตัวอักษร อนุญาต HTTP localhost สำหรับการพัฒนา</p></>}
      {dialog.type === 'key' && <>{!allowedApps.length ? <div className="inline-error">เพิ่มแอปพลิเคชันที่ใช้งานได้ก่อนสร้าง API key <button type="button" className="text-link" onClick={() => setDialog({ type: 'application' })}>เพิ่มแอปพลิเคชัน<Plus size={14} /></button></div> : <><label className="field">ชื่อคีย์<input name="name" placeholder="เช่น Production service" maxLength={100} required /></label><label className="field">แอปพลิเคชัน<select name="applicationId" required>{allowedApps.map(app => <option value={app.id} key={app.id}>{app.name}</option>)}</select></label><label className="field">อายุคีย์<select name="expiresInDays" defaultValue="30"><option value="30">30 วัน</option><option value="60">60 วัน</option><option value="90">90 วัน</option><option value="365">365 วัน</option></select></label><fieldset className="scope-fieldset"><legend>ขอบเขตสิทธิ์ (Scopes)</legend><label className="checkbox-row"><input type="checkbox" name="scopes" value="identity:read" defaultChecked /><span><strong>identity:read</strong><small>อ่านข้อมูลผู้ใช้จาก access token</small></span></label><label className="checkbox-row"><input type="checkbox" name="scopes" value="token:introspect" defaultChecked /><span><strong>token:introspect</strong><small>ตรวจสอบสถานะ token และการเพิกถอน</small></span></label></fieldset></>}</>}
      {dialog.type === 'revoke' && <><div className="revoke-target"><LockKeyhole size={22} /><strong>{dialog.label}</strong></div><p className="modal-body-copy">{dialog.entity === 'user' || dialog.entity === 'email' ? 'บัญชีนี้จะสูญเสียสิทธิ์เข้าสู่ระบบ เซสชันและ SSO token ที่เกี่ยวข้องจะถูกยกเลิก ระบบปลายทางอาจรับรู้การเปลี่ยนแปลงช้าสูงสุด 5 วินาที' : dialog.entity === 'application' ? 'แอปพลิเคชันนี้ รวมถึง API keys และ token ที่เกี่ยวข้องจะใช้ยืนยันตัวตนไม่ได้อีก' : dialog.entity === 'key' ? 'ระบบที่ใช้คีย์นี้จะเรียก API ไม่ได้ ควรเปลี่ยนไปใช้คีย์ใหม่ก่อนดำเนินการ' : dialog.current ? 'คุณจะออกจากระบบในอุปกรณ์นี้ และ token ที่ผูกกับเซสชันนี้จะสิ้นสุดลง' : 'เซสชันนี้และ SSO token ที่เกี่ยวข้องจะถูกยกเลิก ระบบปลายทางอาจรับรู้ช้าสูงสุด 5 วินาที'}</p></>}
      {dialog.type === 'totp' && <><p className="modal-body-copy">1. สแกน QR ด้วย Google Authenticator หรือแอป TOTP ที่รองรับ</p><div className="qr-frame">{qrCode ? <img src={qrCode} width="210" height="210" alt="QR code สำหรับตั้งค่า Authenticator" /> : <Spinner label="กำลังสร้าง QR…" />}</div><div className="secret-manual"><label>หรือป้อน Setup key ด้วยตนเอง</label><div><code>{dialog.secret}</code><CopyButton value={dialog.secret} copied={copied} onCopy={value => void copy(value)} /></div></div><p className="modal-body-copy">2. บันทึก Recovery codes ไว้ในที่ปลอดภัย รหัสจะใช้ได้หลังเปิด Authenticator สำเร็จ</p></>}
      {(dialog.type === 'totp' || dialog.type === 'recoveryCodes') && <><div className="recovery-codes">{codes.map(code => <code key={code}>{code}</code>)}</div><div className="recovery-actions"><CopyButton value={codes.join('\n')} copied={copied} onCopy={value => void copy(value)} label="คัดลอกรหัส" /><button className="copy-button" type="button" onClick={() => downloadCodes(codes)}><Download size={15} />ดาวน์โหลด</button></div><p className="field-hint">แต่ละรหัสใช้ได้เพียงครั้งเดียว ระบบจะไม่แสดงรหัสชุดนี้ซ้ำหลังปิดหน้าต่าง</p><label className="checkbox-row"><input type="checkbox" required /><span>ฉันบันทึกรหัสกู้คืนไว้ในที่ปลอดภัยแล้ว</span></label></>}
      {(dialog.type === 'totp' || dialog.type === 'disableTotp' || dialog.type === 'regenerateCodes') && <>{dialog.type === 'disableTotp' && <p className="modal-body-copy">ยืนยันด้วยรหัสจาก Authenticator ปัจจุบัน การเข้าสู่ระบบครั้งถัดไปจะใช้ Email OTP และ Recovery codes เดิมจะถูกยกเลิก</p>}{dialog.type === 'regenerateCodes' && <p className="modal-body-copy">ยืนยันด้วยรหัสจาก Authenticator ปัจจุบัน เมื่อสร้างรหัสชุดใหม่ Recovery codes ชุดเดิมจะถูกยกเลิกทั้งหมด</p>}<label className="field">{dialog.type === 'totp' ? '3. กรอกรหัส 6 หลักจากแอป' : 'รหัสจาก Authenticator'}<input name="code" className="otp-input" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} placeholder="000000" required /></label></>}
      {dialog.type === 'secret' && <><div className="secret-key"><code>{dialog.key}</code><CopyButton value={dialog.key} copied={copied} onCopy={value => void copy(value)} label="คัดลอกคีย์" /></div><div className="field-hint"><LockKeyhole size={16} />เก็บคีย์ใน environment หรือ secret manager ของเซิร์ฟเวอร์ ห้ามเผยแพร่ใน frontend หรือ Git</div><label className="checkbox-row"><input type="checkbox" required /><span>ฉันบันทึกคีย์ไว้ในที่ปลอดภัยแล้ว</span></label></>}
      <div className="modal-actions">{!['secret', 'recoveryCodes'].includes(dialog.type) && <button className="button secondary" type="button" onClick={closeDialog} disabled={busy}>ยกเลิก</button>}<button className={`button ${dialog.type === 'revoke' ? 'danger' : 'primary'}`} type="submit" disabled={busy || (dialog.type === 'key' && !allowedApps.length)}>{busy ? <LoaderCircle size={16} className="spin" /> : dialog.type === 'revoke' ? <LockKeyhole size={16} /> : ['totp', 'disableTotp', 'regenerateCodes'].includes(dialog.type) ? <Fingerprint size={16} /> : null}{busy ? 'กำลังดำเนินการ…' : dialog.type === 'email' ? 'เพิ่มอีเมล' : dialog.type === 'application' ? 'เพิ่มแอปพลิเคชัน' : dialog.type === 'key' ? 'สร้าง API key' : dialog.type === 'revoke' ? 'ยืนยันยกเลิกสิทธิ์' : dialog.type === 'totp' ? 'ยืนยันและเปิดใช้งาน' : dialog.type === 'disableTotp' ? 'ยืนยันปิดใช้งาน' : dialog.type === 'regenerateCodes' ? 'สร้างรหัสชุดใหม่' : 'บันทึกแล้ว เสร็จสิ้น'}</button></div></form></Modal>}{toast && <Toast {...toast} close={() => setToast(null)} />}</div>;
}
