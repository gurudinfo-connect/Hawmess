import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ago, baseFor, qs, roleOf } from '../api';
import { Badge, Empty, ErrorBox, Ic, PageHead, Skeleton, useDebounced, useToast } from '../ui';
import { ConfirmModal } from '../components';

export default function Knowledge() {
  const role = roleOf(); const base = baseFor(role); const staff = role !== 'employee';
  const [search, setSearch] = useState(''); const ds = useDebounced(search); const [cat, setCat] = useState('');
  const q = useQuery({ queryKey: ['kb', ds, cat], queryFn: () => api(`/knowledge${qs({ search: ds, category: cat, pageSize: 50 })}`), placeholderData: p => p });
  const rows: any[] = q.data?.data || []; const cats: any[] = q.data?.categories || [];
  return <>
    <PageHead crumbs={[{ label: 'Self service' }, { label: 'Knowledge' }]} title="Knowledge" sub="Self-help articles — search before you raise a ticket">
      {staff && <Link to={`${base}/knowledge/new`} className="btn primary"><Ic n="plus" />New article</Link>}</PageHead>
    <div className="filters"><input type="search" aria-label="Search knowledge" placeholder="Search articles…" value={search} onChange={e => setSearch(e.target.value)} />
      <select aria-label="Category" value={cat} onChange={e => setCat(e.target.value)}><option value="">All categories</option>{cats.map(c => <option key={c.name} value={c.name}>{c.name} ({c.n})</option>)}</select></div>
    <ErrorBox error={q.error} />
    {q.isLoading ? <div className="card"><Skeleton rows={6} /></div> : !rows.length ? <div className="card"><Empty icon="inbox" title="No articles found">{ds || cat ? 'Try a different search.' : staff ? 'Write the first article to get started.' : 'Nothing has been published yet.'}</Empty></div>
      : <div className="tiles">{rows.map(a => <Link key={a.id} to={`${base}/knowledge/${a.id}`} className="tile">
        <div className="tile-h"><span className="tile-cat">{a.category}</span>{!a.is_published && <Badge v="pending" text="Draft" />}</div>
        <h3>{a.title}</h3>{a.summary && <p>{a.summary}</p>}<small>{a.author_name ? `${a.author_name} · ` : ''}updated {ago(a.updated_at)} · {a.views} views</small></Link>)}</div>}
  </>;
}

export function KnowledgeArticle() {
  const { id } = useParams(); const role = roleOf(); const base = baseFor(role); const staff = role !== 'employee'; const nav = useNavigate(); const toast = useToast(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['kb-article', id], queryFn: () => api(`/knowledge/${id}`) }); const [del, setDel] = useState(false); const a = q.data;
  return <>
    <PageHead crumbs={[{ label: 'Knowledge', to: `${base}/knowledge` }, { label: a?.title || 'Article' }]} title={a?.title || 'Article'} sub={a ? `${a.category} · ${a.author_name || 'Unknown'} · updated ${ago(a.updated_at)} · ${a.views} views` : undefined}>
      {a && staff && <Link to={`${base}/knowledge/${a.id}/edit`} className="btn"><Ic n="edit" />Edit</Link>}
      {a && role === 'admin' && <button className="btn danger" onClick={() => setDel(true)}><Ic n="trash" />Delete</button>}</PageHead>
    <ErrorBox error={q.error} />
    {q.isLoading ? <div className="card"><Skeleton rows={8} /></div> : a && <div className="card kb-article">
      {!a.is_published && <div className="warnbox">This article is a draft and is only visible to staff.</div>}
      {a.summary && <p className="kb-lead">{a.summary}</p>}<div className="kb-body">{a.body}</div>
      <div className="snow-foot" style={{ justifyContent: 'space-between' }}><span className="cell-sub">Did this not solve it?</span><Link className="btn primary" to={`${base}/tickets?type=incident&new=1`}><Ic n="alert" />Report an incident</Link></div></div>}
    {del && a && <ConfirmModal title="Delete article" text={`Delete “${a.title}” permanently?`} confirm="Delete" danger onClose={() => setDel(false)}
      onYes={async () => { await api(`/knowledge/${a.id}`, { method: 'DELETE' }); qc.invalidateQueries({ queryKey: ['kb'] }); toast('Article deleted'); nav(`${base}/knowledge`); }} />}
  </>;
}

export function KnowledgeEditor() {
  const { id } = useParams(); const role = roleOf(); const base = baseFor(role); const nav = useNavigate(); const toast = useToast(); const qc = useQueryClient();
  const existing = useQuery({ queryKey: ['kb-article', id, 'edit'], queryFn: () => api(`/knowledge/${id}`), enabled: !!id });
  const list = useQuery({ queryKey: ['kb', '', ''], queryFn: () => api(`/knowledge${qs({ pageSize: 50 })}`) });
  const [f, setF] = useState<any>({ title: '', summary: '', body: '', category: 'General', is_published: true });
  useEffect(() => { if (existing.data) setF({ title: existing.data.title, summary: existing.data.summary || '', body: existing.data.body, category: existing.data.category, is_published: existing.data.is_published }); }, [existing.data]);
  const save = useMutation({ mutationFn: () => api(id ? `/knowledge/${id}` : '/knowledge', { method: id ? 'PUT' : 'POST', body: f }),
    onSuccess: (a: any) => { qc.invalidateQueries({ queryKey: ['kb'] }); qc.invalidateQueries({ queryKey: ['kb-article'] }); toast('Article saved'); nav(`${base}/knowledge/${a.id}`); }, onError: (e: any) => toast(e.message, 'error') });
  const set = (k: string) => (e: any) => setF((s: any) => ({ ...s, [k]: e.target.value }));
  const actions = <><Link to={`${base}/knowledge`} className="btn">Cancel</Link><button className="btn primary" form="kbform" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</button></>;
  return <div className="snow-page">
    <PageHead crumbs={[{ label: 'Knowledge', to: `${base}/knowledge` }, { label: id ? 'Edit article' : 'New article' }]} title="Knowledge article" sub={id ? 'Edit' : 'New record'}>{actions}</PageHead>
    <div className="card snow-card"><form id="kbform" className="snow-wide" onSubmit={e => { e.preventDefault(); save.mutate(); }}>
      <label className="snow-row"><span className="snow-lbl"><b className="req">*</b>Title</span><span className="snow-ctl"><input value={f.title} onChange={set('title')} minLength={3} maxLength={200} required /></span></label>
      <label className="snow-row"><span className="snow-lbl"><b className="req">*</b>Category</span><span className="snow-ctl"><input list="kbcats" value={f.category} onChange={set('category')} maxLength={80} required /><datalist id="kbcats">{(list.data?.categories || []).map((c: any) => <option key={c.name} value={c.name} />)}</datalist></span></label>
      <label className="snow-row"><span className="snow-lbl">Summary</span><span className="snow-ctl"><input value={f.summary} onChange={set('summary')} maxLength={500} /></span></label>
      <label className="snow-row"><span className="snow-lbl"><b className="req">*</b>Article text</span><span className="snow-ctl"><textarea rows={14} value={f.body} onChange={set('body')} minLength={3} required /></span></label>
      <label className="snow-row"><span className="snow-lbl">Published</span><span className="snow-ctl"><input type="checkbox" style={{ width: 'auto' }} checked={f.is_published} onChange={e => setF((s: any) => ({ ...s, is_published: e.target.checked }))} /> <span className="cell-sub">Unpublished drafts are visible to staff only</span></span></label>
    </form><div className="snow-foot">{actions}</div></div></div>;
}
