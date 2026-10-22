import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { baseFor, roleOf } from '../api';
import { Empty, ErrorBox, Ic, PageHead, Skeleton } from '../ui';
import { useCategories } from '../components';

/** Catalogue = the active ticket categories. Picking an item opens a new service request with it pre-selected. */
export default function ServiceCatalogue() {
  const b = baseFor(roleOf()); const cats = useCategories(); const [q, setQ] = useState('');
  const all: any[] = (cats.data?.data || []).filter((c: any) => c.is_active !== false);
  const parents = all.filter(c => !c.parent_id); const term = q.trim().toLowerCase();
  const items = parents.map(p => ({ p, subs: all.filter(c => c.parent_id === p.id) }))
    .filter(({ p, subs }) => !term || p.name.toLowerCase().includes(term) || subs.some(s => s.name.toLowerCase().includes(term)))
    .map(({ p, subs }) => ({ p, subs: term && !p.name.toLowerCase().includes(term) ? subs.filter(s => s.name.toLowerCase().includes(term)) : subs }));
  const go = (c: string, s?: string) => `${b}/tickets?type=service_request&new=1&category_id=${c}${s ? `&subcategory_id=${s}` : ''}`;
  return <>
    <PageHead crumbs={[{ label: 'Self service' }, { label: 'Service catalogue' }]} title="Service catalogue" sub="Choose a service to raise a request" />
    <div className="filters"><input type="search" aria-label="Search catalogue" placeholder="Search services…" value={q} onChange={e => setQ(e.target.value)} /></div>
    <ErrorBox error={cats.error} />
    {cats.isLoading ? <div className="card"><Skeleton rows={6} /></div> : !items.length ? <div className="card"><Empty icon="inbox" title="No services found">Try a different search.</Empty></div>
      : <div className="tiles">{items.map(({ p, subs }) => <div key={p.id} className="tile cat">
        <Link to={go(p.id)} className="cat-h"><div className="tile-ic"><Ic n="ticket" /></div><h3>{p.name}</h3></Link>
        {subs.length ? <ul>{subs.map(s => <li key={s.id}><Link to={go(p.id, s.id)}>{s.name}<Ic n="plus" /></Link></li>)}</ul> : <p>General {p.name.toLowerCase()} requests</p>}</div>)}</div>}
  </>;
}
