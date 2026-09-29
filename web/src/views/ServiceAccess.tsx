import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { ChevronLeft, ChevronRight, Pencil, Plus, Trash2, Users } from 'lucide-react';
import { api } from '../models/api';
import type { Dataset, PageMeta, ServiceMember, ServiceRole, User } from '../models/types';
import { Badge, Empty, Modal, Panel, SectionHeading, Spinner } from '../components/ui';
import './service-access.css';

type Shared = { demo: boolean; updateDemo: (update: (data: Dataset) => Dataset) => void };
type Entity = { id: string; name: string; email?: string; revokedAt?: string | null };
const emptyMeta = { total: 0, totalPages: 1, currentPage: 1, limit: 10 };

function EntityPicker({ kind, demo, data, value, onChange }: { kind: 'users' | 'applications'; demo: boolean; data: Entity[]; value: Entity | null; onChange: (entity: Entity | null) => void }) {
  const [search, setSearch] = useState(''); const [page, setPage] = useState(1);
  const [items, setItems] = useState<Entity[]>([]); const [totalPages, setTotalPages] = useState(1); const [error, setError] = useState('');
  const label = kind === 'users' ? 'ผู้ใช้' : 'Service';
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      if (demo) {
        const matches = data.filter(item => !item.revokedAt && `${item.name} ${item.email ?? ''}`.toLowerCase().includes(search.toLowerCase()));
        setItems(matches.slice((page - 1) * 20, page * 20)); setTotalPages(Math.max(1, Math.ceil(matches.length / 20))); return;
      }
      void api<Record<string, unknown>>(`/admin/${kind}?${new URLSearchParams({ search, page: String(page), limit: '20' })}`).then(result => {
        if (!active) return;
        setItems((result[kind] as Entity[]).filter(item => !item.revokedAt)); setTotalPages(Math.max(1, (result.meta as PageMeta).totalPages)); setError('');
      }).catch(e => { if (active) setError((e as Error).message); });
    }, search ? 250 : 0);
    return () => { active = false; clearTimeout(timer); };
  }, [demo, data, kind, search, page]);
  const options = value && !items.some(item => item.id === value.id) ? [value, ...items] : items;
  return <div className="entity-picker"><label className="field">ค้นหา{label}<input value={search} placeholder={kind === 'users' ? 'ชื่อหรืออีเมล' : 'ชื่อ Service'} onChange={e => { setSearch(e.target.value); setPage(1); }} /></label><label className="field">{label}<select value={value?.id ?? ''} onChange={e => onChange(options.find(item => item.id === e.target.value) ?? null)} required><option value="">เลือก{label}</option>{options.map(item => <option value={item.id} key={item.id}>{item.name}{item.email ? ` · ${item.email}` : ''}</option>)}</select></label>{totalPages > 1 && <div className="picker-pagination"><button type="button" className="icon-button" aria-label={`ค้นหา${label}หน้าก่อน`} disabled={page === 1} onClick={() => setPage(page - 1)}><ChevronLeft size={16} /></button><span>{page} / {totalPages}</span><button type="button" className="icon-button" aria-label={`ค้นหา${label}หน้าถัดไป`} disabled={page >= totalPages} onClick={() => setPage(page + 1)}><ChevronRight size={16} /></button></div>}{error && <p className="inline-error" role="alert">{error}</p>}</div>;
}
export function UserProfileDialog({ user, demo, updateDemo, reload, close }: Shared & { user: User; reload: () => Promise<void>; close: () => void }) {
  const [firstName, setFirst] = useState(user.firstName ?? ''); const [lastName, setLast] = useState(user.lastName ?? '');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const fields = { firstName: firstName.trim(), lastName: lastName.trim() };
      if (demo) updateDemo(data => ({ ...data, users: data.users.map(u => u.id === user.id ? { ...u, ...fields, name: `${fields.firstName} ${fields.lastName}`.trim() || u.name } : u), serviceMembers: data.serviceMembers.map(m => m.userId === user.id ? { ...m, name: `${fields.firstName} ${fields.lastName}`.trim() || m.name } : m) }));
      else { await api(`/admin/users/${user.id}/profile`, 'PATCH', fields); await reload(); }
      close();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <Modal title="รายละเอียดผู้ใช้" description={user.email} close={close} busy={busy}><form onSubmit={save}>{error && <div className="inline-error" role="alert">{error}</div>}<label className="field">ชื่อ<input value={firstName} onChange={e => setFirst(e.target.value)} maxLength={100} autoComplete="given-name" /></label><label className="field">นามสกุล<input value={lastName} onChange={e => setLast(e.target.value)} maxLength={100} autoComplete="family-name" /></label><p className="field-hint">ชื่อ–นามสกุลใช้ร่วมกันทุกระบบ หน่วยงานและ Role กำหนดแยกในเมนู “สิทธิ์แต่ละ Service”</p><div className="service-form-actions"><button className="button secondary" type="button" onClick={close} disabled={busy}>ยกเลิก</button><button className="button primary" disabled={busy}>บันทึกข้อมูล</button></div></form></Modal>;
}

type Dialog = { kind: 'role'; role?: ServiceRole } | { kind: 'member'; member?: ServiceMember } | { kind: 'deleteRole'; role: ServiceRole } | { kind: 'deleteMember'; member: ServiceMember };
export function ServiceAccessPage({ demo, data, updateDemo }: Shared & { data: Dataset }) {
  const [selectedApp, setApp] = useState<Entity | null>(() => data.applications.find(app => !app.revokedAt) ?? null);
  const [roles, setRoles] = useState<ServiceRole[]>([]); const [members, setMembers] = useState<ServiceMember[]>([]);
  const [search, setSearch] = useState(''); const [page, setPage] = useState(1); const [meta, setMeta] = useState<PageMeta>(emptyMeta);
  const [loading, setLoading] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [version, setVersion] = useState(0);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  useEffect(() => {
    if (!selectedApp) { setRoles([]); setMembers([]); return; }
    let active = true; setLoading(true); setError('');
    const timer = setTimeout(() => {
      if (demo) {
        const all = data.serviceMembers.filter(m => m.applicationId === selectedApp.id && `${m.name} ${m.email} ${m.department}`.toLowerCase().includes(search.toLowerCase()));
        setRoles(data.serviceRoles.filter(r => r.applicationId === selectedApp.id)); setMembers(all.slice((page - 1) * 10, page * 10));
        setMeta({ total: all.length, totalPages: Math.ceil(all.length / 10), currentPage: page, limit: 10 }); setLoading(false); return;
      }
      void Promise.all([api<{ roles: ServiceRole[] }>(`/admin/applications/${selectedApp.id}/roles`), api<{ members: ServiceMember[]; meta: PageMeta }>(`/admin/applications/${selectedApp.id}/members?${new URLSearchParams({ search, page: String(page), limit: '10' })}`)])
        .then(([r, m]) => { if (active) { setRoles(r.roles); setMembers(m.members); setMeta(m.meta); } })
        .catch(e => { if (active) { setError((e as Error).message); setRoles([]); setMembers([]); } })
        .finally(() => { if (active) setLoading(false); });
    }, search ? 250 : 0);
    return () => { active = false; clearTimeout(timer); };
  }, [selectedApp?.id, demo, data.serviceRoles, data.serviceMembers, search, page, version]);
  return <><SectionHeading eyebrow="SERVICE ACCESS" title="สิทธิ์แต่ละ Service" description="กำหนดหน่วยงานและ Role ของผู้ใช้แยกตามระบบที่เชื่อมต่อ" />
    <div className="info-strip"><Users size={19} /><span>ผู้ใช้หนึ่งคนมีหลาย Role ได้ แต่ละ Service เห็นเฉพาะสิทธิ์ของตัวเอง Role ที่สร้างที่นี่ไม่ให้สิทธิ์ Admin ของ CUSA SSO</span></div>
    <Panel className="service-picker-panel"><EntityPicker kind="applications" demo={demo} data={data.applications} value={selectedApp} onChange={app => { setApp(app); setRoles([]); setMembers([]); setPage(1); setSearch(''); setDialog(null); setNotice(''); }} /></Panel>
    {notice && <p className="service-notice" role="status">{notice}</p>}{error && <p className="inline-error" role="alert">{error}</p>}
    {!selectedApp ? <Panel><Empty title="เลือก Service เพื่อจัดการสิทธิ์" detail="เพิ่มระบบได้จากเมนูแอปพลิเคชัน แล้วสร้าง Role และเพิ่มสมาชิก" /></Panel> : <>
      <Panel title={`Role ของ ${selectedApp.name}`} subtitle="รหัส Role ใช้ตรวจสอบสิทธิ์ในระบบปลายทาง และเปลี่ยนไม่ได้หลังสร้าง" action={<button className="button secondary" disabled={loading || Boolean(error)} onClick={() => setDialog({ kind: 'role' })}><Plus size={15} />เพิ่ม Role</button>}>
        <div className="service-role-list">{roles.map(role => <div className="service-role" key={role.id}><div><strong>{role.name}</strong><code>{role.code}</code><p>{role.description}</p></div><div className="service-row-actions"><button className="icon-button" aria-label={`แก้ไข Role ${role.code}`} onClick={() => setDialog({ kind: 'role', role })}><Pencil size={15} /></button><button className="icon-button danger-hover" aria-label={`ลบ Role ${role.code}`} onClick={() => setDialog({ kind: 'deleteRole', role })}><Trash2 size={15} /></button></div></div>)}{!roles.length && !loading && <Empty title="ยังไม่มี Role" detail="เริ่มสร้าง Role เช่น viewer, editor หรือ approver" />}</div>
      </Panel>
      <Panel className="service-member-panel" title="ผู้ใช้ที่เข้า Service นี้ได้" subtitle="ต้องกำหนดสมาชิกและอย่างน้อยหนึ่ง Role ก่อนเข้าสู่ Service" action={<button className="button primary" disabled={!roles.length || loading || Boolean(error)} onClick={() => setDialog({ kind: 'member' })}><Plus size={15} />เพิ่มสมาชิก</button>}>
        <label className="service-member-search field">ค้นหาสมาชิก<input value={search} placeholder="ชื่อ อีเมล หรือหน่วยงาน" onChange={e => { setSearch(e.target.value); setPage(1); }} /></label>
        {loading ? <Spinner /> : <div className="table-scroll"><table><thead><tr><th>ผู้ใช้</th><th>หน่วยงาน</th><th>Role</th><th className="align-right">จัดการ</th></tr></thead><tbody>{members.map(member => <tr key={member.userId}><td><div className="person-cell"><div><strong>{member.name}</strong><small>{member.email}</small></div></div></td><td>{member.department || '—'}</td><td><div className="service-role-badges">{member.roleIds.map(id => <Badge key={id} tone="gray">{roles.find(role => role.id === id)?.code ?? id}</Badge>)}</div></td><td className="align-right"><button className="icon-button" aria-label={`แก้ไขสิทธิ์ ${member.email}`} onClick={() => setDialog({ kind: 'member', member })}><Pencil size={16} /></button><button className="icon-button danger-hover" aria-label={`ถอนสมาชิก ${member.email}`} onClick={() => setDialog({ kind: 'deleteMember', member })}><Trash2 size={16} /></button></td></tr>)}</tbody></table>{!members.length && <Empty title="ไม่พบสมาชิก" detail={search ? 'ลองใช้คำค้นหาอื่น' : 'เพิ่มผู้ใช้และเลือก Role เพื่ออนุญาตเข้า Service นี้'} />}</div>}
        <div className="pagination"><span>{meta.total} คน</span><div><button className="icon-button" aria-label="สมาชิกหน้าก่อน" disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft size={16} /></button><span>{page} / {Math.max(1, meta.totalPages)}</span><button className="icon-button" aria-label="สมาชิกหน้าถัดไป" disabled={page >= meta.totalPages} onClick={() => setPage(page + 1)}><ChevronRight size={16} /></button></div></div>
      </Panel></>}
    {dialog && selectedApp && <AccessDialog dialog={dialog} application={selectedApp} roles={roles} demo={demo} data={data} updateDemo={updateDemo} close={() => setDialog(null)} saved={() => { setDialog(null); setVersion(v => v + 1); setPage(1); setNotice('บันทึกแล้ว การเปลี่ยนสิทธิ์จะยกเลิก token เดิมของผู้ใช้ใน Service นี้'); }} />}
  </>;
}
function AccessDialog({ dialog, application, roles, demo, data, updateDemo, close, saved }: Shared & { dialog: Dialog; application: Entity; roles: ServiceRole[]; data: Dataset; close: () => void; saved: () => void }) {
  const role = dialog.kind === 'role' ? dialog.role : undefined;
  const member = dialog.kind === 'member' ? dialog.member : undefined;
  const [selectedUser, setUser] = useState<Entity | null>(member ? { id: member.userId, name: member.name, email: member.email } : null);
  const [code, setCode] = useState(role?.code ?? ''); const [name, setName] = useState(role?.name ?? ''); const [description, setDescription] = useState(role?.description ?? '');
  const [department, setDepartment] = useState(member?.department ?? ''); const [roleIds, setRoleIds] = useState(member?.roleIds ?? []);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const title = dialog.kind === 'role' ? role ? 'แก้ไข Role' : 'เพิ่ม Role' : dialog.kind === 'member' ? member ? 'แก้ไขสิทธิ์สมาชิก' : 'เพิ่มสมาชิก' : dialog.kind === 'deleteRole' ? 'ลบ Role' : 'ถอนสิทธิ์สมาชิก';
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const base = `/admin/applications/${application.id}`;
      if (dialog.kind === 'role') {
        const input = { code, name: name.trim(), description: description.trim() };
        if (demo) {
          if (data.serviceRoles.some(r => r.applicationId === application.id && r.code === code && r.id !== role?.id)) throw new Error('รหัส Role นี้มีอยู่แล้วใน Service');
          const next = { ...input, applicationId: application.id, id: role?.id ?? crypto.randomUUID() };
          updateDemo(d => ({ ...d, serviceRoles: [...d.serviceRoles.filter(r => r.id !== next.id), next] }));
        } else await api(`${base}/roles${role ? `/${role.id}` : ''}`, role ? 'PATCH' : 'POST', input);
      } else if (dialog.kind === 'member') {
        if (!selectedUser || !roleIds.length) throw new Error('เลือกผู้ใช้และอย่างน้อยหนึ่ง Role');
        if (demo) {
          const next = { applicationId: application.id, userId: selectedUser.id, email: selectedUser.email ?? '', name: selectedUser.name, department: department.trim(), roleIds };
          updateDemo(d => ({ ...d, serviceMembers: [...d.serviceMembers.filter(m => !(m.applicationId === application.id && m.userId === next.userId)), next] }));
        } else await api(`${base}/members/${selectedUser.id}`, 'PUT', { department: department.trim(), roleIds });
      } else if (dialog.kind === 'deleteRole') {
        if (demo) {
          if (data.serviceMembers.some(m => m.applicationId === application.id && m.roleIds.includes(dialog.role.id))) throw new Error('ยังมีผู้ใช้ที่ได้รับ Role นี้ กรุณาเปลี่ยนสิทธิ์ก่อนลบ');
          updateDemo(d => ({ ...d, serviceRoles: d.serviceRoles.filter(r => r.id !== dialog.role.id) }));
        } else await api(`${base}/roles/${dialog.role.id}`, 'DELETE');
      } else {
        if (demo) updateDemo(d => ({ ...d, serviceMembers: d.serviceMembers.filter(m => !(m.applicationId === application.id && m.userId === dialog.member.userId)) }));
        else await api(`${base}/members/${dialog.member.userId}`, 'DELETE');
      }
      saved();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <Modal title={title} description={application.name} close={close} busy={busy}><form onSubmit={save}>{error && <div className="inline-error" role="alert">{error}</div>}
    {dialog.kind === 'role' && <><label className="field">รหัส Role<input value={code} onChange={e => setCode(e.target.value)} pattern="[a-z][a-z0-9_-]{0,47}" maxLength={48} readOnly={Boolean(role)} placeholder="เช่น approver" required /></label><label className="field">ชื่อ Role<input value={name} onChange={e => setName(e.target.value)} maxLength={100} placeholder="เช่น ผู้อนุมัติ" required /></label><label className="field">คำอธิบาย<textarea value={description} onChange={e => setDescription(e.target.value)} maxLength={500} rows={3} /></label><p className="field-hint">ระบบปลายทางใช้รหัส Role ตรวจสอบสิทธิ์ตามกติกาที่พัฒนาไว้ ชื่อ Role ใช้แสดงผล</p></>}
    {dialog.kind === 'member' && <>{member ? <p className="service-selected-user">{member.email}</p> : <EntityPicker kind="users" demo={demo} data={data.users} value={selectedUser} onChange={setUser} />}<label className="field">หน่วยงานใน Service นี้<input value={department} onChange={e => setDepartment(e.target.value)} maxLength={150} placeholder="เช่น ฝ่ายการเงิน" /></label><fieldset className="service-role-checkboxes"><legend>Role ที่ได้รับ (เลือกได้หลายรายการ)</legend>{roles.map(r => <label key={r.id}><input type="checkbox" checked={roleIds.includes(r.id)} disabled={!roleIds.includes(r.id) && roleIds.length >= 20} onChange={e => setRoleIds(ids => e.target.checked ? [...ids, r.id] : ids.filter(id => id !== r.id))} /><span><strong>{r.name}</strong><small>{r.code}</small></span></label>)}</fieldset></>}
    {dialog.kind === 'deleteRole' && <p className="modal-body-copy">ลบ Role “{dialog.role.name}” ({dialog.role.code}) ได้เมื่อไม่มีสมาชิกใช้งานอยู่</p>}
    {dialog.kind === 'deleteMember' && <p className="modal-body-copy">ถอนสิทธิ์ {dialog.member.email} จาก {application.name} และยกเลิก token ของ Service นี้</p>}
    <div className="service-form-actions"><button type="button" className="button secondary" onClick={close} disabled={busy}>ยกเลิก</button><button className={`button ${dialog.kind.startsWith('delete') ? 'danger' : 'primary'}`} disabled={busy || (dialog.kind === 'member' && (!selectedUser || !roleIds.length))}>{busy ? 'กำลังบันทึก…' : dialog.kind.startsWith('delete') ? 'ยืนยัน' : 'บันทึก'}</button></div>
  </form></Modal>;
}
