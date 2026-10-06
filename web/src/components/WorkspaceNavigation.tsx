import { useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { navGroups, navigationFor } from '../models/navigation';
import type { Identity, Page } from '../models/types';

export function WorkspaceNavigation({ identity, page, users, navigate, reveal }: {
  identity: Identity; page: Page; users: number; navigate: (page: Page) => void; reveal: () => void;
}) {
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const available = navigationFor(identity);
  const term = query.trim().toLocaleLowerCase();
  const results = available.filter(item => `${item.label} ${item.description} ${item.keywords ?? ''}`.toLocaleLowerCase().includes(term));
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !document.querySelector('[role="dialog"]')) {
        event.preventDefault(); reveal(); requestAnimationFrame(() => input.current?.focus());
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [reveal]);
  function go(next: Page) { setQuery(''); navigate(next); }
  return <>
    <div className="nav-search"><Search size={16} aria-hidden="true" /><input ref={input} aria-label="ค้นหาเมนู" placeholder="ค้นหาเมนู…" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
      if (event.key === 'Enter' && results[0]) { event.preventDefault(); go(results[0].page); }
      if (event.key === 'Escape' && query) { event.stopPropagation(); setQuery(''); }
    }} />{query ? <button aria-label="ล้างคำค้นหาเมนู" onClick={() => { setQuery(''); input.current?.focus(); }}><X size={15} /></button> : <kbd>⌘ K</kbd>}</div>
    <nav aria-label="เมนูหลัก">
      {navGroups.map(group => {
        const items = results.filter(item => item.group === group.id);
        if (!items.length) return null;
        return <div className="nav-group" key={group.id}><span className="nav-group-label">{group.label}</span>{items.map(({ page: destination, icon: Icon, label }) =>
          <button key={destination} className={`nav-item ${page === destination ? 'active' : ''}`} aria-current={page === destination ? 'page' : undefined} onClick={() => go(destination)}>
            <Icon size={19} strokeWidth={1.8} /><span>{label}</span>{destination === 'users' ? <small>{users}</small> : page === destination && <span className="nav-active-dot" />}
          </button>)}</div>;
      })}
      {!results.length && <div className="nav-no-results" role="status"><Search size={23} /><strong>ไม่พบเมนูที่ค้นหา</strong><span>ลองค้นด้วยชื่อฟังก์ชัน เช่น LINE</span></div>}
    </nav>
  </>;
}
