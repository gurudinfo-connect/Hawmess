/**
 * Hawmess integration tests — run against a RUNNING API with a migrated + seeded database.
 *   API_URL=http://localhost:4000/api/v1 ADMIN_EMAIL=admin@hawmess.com ADMIN_PASSWORD=Admin@123 npm test
 * The suite creates its own throw-away users, so it does not depend on the demo accounts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const API = process.env.API_URL || 'http://localhost:4000/api/v1';
const ADMIN = { email: process.env.ADMIN_EMAIL || 'admin@hawmess.com', password: process.env.ADMIN_PASSWORD || 'Admin@123' };
const stamp = Date.now();

async function call(method: string, path: string, token?: string, body?: any) {
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const r = await fetch(API + path, { method, headers: { ...(isForm || body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : isForm ? body : JSON.stringify(body) });
  const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}
async function login(email: string, password: string) { const r = await call('POST', '/auth/login', undefined, { email, password }); assert.equal(r.status, 200, `login ${email}: ${r.text}`); return r.json; }
const ctx: any = {};
const form = (o: Record<string, string>, file?: { name: string; content: string }) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.append(k, v); if (file) f.append('files', new Blob([file.content], { type: 'text/plain' }), file.name); return f; };

test('setup: admin creates HR + two employees; categories and SLA exist', async () => {
  const a = await login(ADMIN.email, ADMIN.password); ctx.admin = a.token; ctx.adminUser = a.user;
  assert.equal(a.user.role, 'admin'); assert.equal(a.user.home, '/admin/dashboard');
  const mk = async (name: string, role: string) => { const email = `${name}.${stamp}@test.local`; const r = await call('POST', '/users', ctx.admin, { name, email, password: 'Passw0rd!x', role }); assert.equal(r.status, 201, r.text); const l = await login(email, 'Passw0rd!x'); return { id: r.json.id, token: l.token, user: l.user }; };
  ctx.hr = await mk('hrtest', 'hr'); ctx.e1 = await mk('emp1', 'employee'); ctx.e2 = await mk('emp2', 'employee');
  assert.equal(ctx.hr.user.home, '/hr/dashboard'); assert.equal(ctx.e1.user.home, '/employee/dashboard');
  const cats = (await call('GET', '/config/categories', ctx.e1.token)).json.data;
  ctx.catIT = cats.find((c: any) => c.name === 'Hardware' && !c.parent_id); ctx.catHR = cats.find((c: any) => c.name === 'HR and Employee Services' && !c.parent_id);
  assert.ok(ctx.catIT && ctx.catHR);
  assert.equal(ctx.catHR.hr_visible, true); assert.equal(ctx.catIT.hr_visible, false);
});

test('SLA: deadlines come from the configured policy and priority changes recalculate them', async () => {
  const sla = (await call('GET', '/config/sla', ctx.admin)).json.data; const crit = sla.find((s: any) => s.priority === 'critical' && !s.category_id);
  const r = await call('POST', '/tickets', ctx.e1.token, form({ subject: 'Server room is hot', description: 'Temperature alarm in rack 4', category_id: ctx.catIT.id, priority: 'critical' }));
  assert.equal(r.status, 201, r.text); ctx.t1 = r.json;
  const created = new Date(r.json.created_at).getTime();
  assert.equal(new Date(r.json.resolution_due).getTime() - created, crit.resolution_minutes * 60000);
  assert.equal(new Date(r.json.first_response_due).getTime() - created, crit.first_response_minutes * 60000);
  assert.match(r.json.ticket_no, /^HW-T\d{2}ID\d{2,4}$/); assert.equal(r.json.status, 'open');   // Hardware routes to IT Support team via the category rule
  const p = await call('PATCH', `/tickets/${ctx.t1.id}`, ctx.admin, { priority: 'low' }); assert.equal(p.status, 200);
  const d = (await call('GET', `/tickets/${ctx.t1.id}`, ctx.admin)).json; const low = sla.find((s: any) => s.priority === 'low' && !s.category_id);
  assert.equal(new Date(d.resolution_due).getTime() - created, low.resolution_minutes * 60000);
  assert.equal(d.sla.has_policy, true); assert.equal(d.sla.is_overdue, false);
});

test('lifecycle: transitions are validated server-side and every change is recorded', async () => {
  const id = ctx.t1.id;
  assert.equal((await call('POST', `/tickets/${id}/status`, ctx.admin, { status: 'closed' })).status, 400, 'open → closed must be refused');
  assert.equal((await call('POST', `/tickets/${id}/status`, ctx.admin, { status: 'resolved' })).status, 400, 'resolving needs resolution details');
  assert.equal((await call('POST', `/tickets/${id}/assign`, ctx.admin, { assignee_id: ctx.hr.id })).status, 200);
  let d = (await call('GET', `/tickets/${id}`, ctx.admin)).json; assert.equal(d.status, 'assigned'); assert.equal(d.assignee_id, ctx.hr.id);
  assert.equal((await call('POST', `/tickets/${id}/status`, ctx.admin, { status: 'in_progress' })).status, 200);
  assert.equal((await call('POST', `/tickets/${id}/status`, ctx.admin, { status: 'resolved', note: 'Replaced the fan' })).status, 200);
  d = (await call('GET', `/tickets/${id}`, ctx.admin)).json;
  assert.equal(d.status, 'resolved'); assert.ok(d.resolved_at); assert.equal(d.resolution_note, 'Replaced the fan');
  assert.deepEqual(d.status_history.map((h: any) => h.to_status), ['open', 'assigned', 'in_progress', 'resolved']);
  assert.ok(d.status_history.every((h: any) => h.changed_by_name), 'who changed it is recorded');
  assert.ok(d.assignment_history.length >= 2, 'assignment history kept');
  // requester can reopen their resolved ticket, and cannot jump to arbitrary states
  assert.equal((await call('POST', `/tickets/${id}/status`, ctx.e1.token, { status: 'in_progress' })).status, 400);
  assert.equal((await call('POST', `/tickets/${id}/status`, ctx.e1.token, { status: 'open', note: 'Still hot' })).status, 200);
  d = (await call('GET', `/tickets/${id}`, ctx.admin)).json; assert.equal(d.status, 'open'); assert.equal(d.resolved_at, null);
  // another employee cannot touch it at all
  assert.equal((await call('POST', `/tickets/${id}/status`, ctx.e2.token, { status: 'cancelled' })).status, 404);
});

test('privacy: employees only see their own tickets; internal notes and internal files never reach them', async () => {
  const id = ctx.t1.id;
  assert.equal((await call('GET', `/tickets/${id}`, ctx.e2.token)).status, 404);
  const list2 = (await call('GET', '/tickets?pageSize=100', ctx.e2.token)).json; assert.ok(!list2.data.some((t: any) => t.id === id));
  const note = await call('POST', `/tickets/${id}/comments`, ctx.admin, form({ body: 'INTERNAL-ONLY secret note', is_internal: 'true' }, { name: 'internal.txt', content: 'secret' })); assert.equal(note.status, 201, note.text);
  const pub = await call('POST', `/tickets/${id}/comments`, ctx.admin, form({ body: 'Public reply to requester' })); assert.equal(pub.status, 201);
  const asEmp = (await call('GET', `/tickets/${id}`, ctx.e1.token)).json;
  assert.ok(!JSON.stringify(asEmp).includes('INTERNAL-ONLY'), 'internal note leaked to requester');
  assert.ok(asEmp.comments.some((c: any) => c.body === 'Public reply to requester'));
  assert.equal(asEmp.attachments.length, 0, 'internal attachment leaked');
  const asAdmin = (await call('GET', `/tickets/${id}`, ctx.admin)).json; assert.ok(asAdmin.comments.some((c: any) => c.is_internal));
  const internalFile = asAdmin.attachments.find((a: any) => a.is_internal); assert.ok(internalFile);
  assert.equal((await call('GET', `/tickets/attachments/${internalFile.id}`, ctx.e1.token)).status, 404, 'requester must not download internal files');
  assert.equal((await call('POST', `/tickets/${id}/comments`, ctx.e1.token, form({ body: 'sneaky', is_internal: 'true' }))).status, 403);
  assert.equal((await call('GET', `/tickets/attachments/${internalFile.id}`, ctx.admin)).status, 200);
});

test('attachments: upload on create, secure download for requester only, dangerous types refused', async () => {
  const r = await call('POST', '/tickets', ctx.e1.token, form({ subject: 'Screenshot attached', description: 'See file', category_id: ctx.catIT.id }, { name: 'shot.txt', content: 'hello-attachment' })); assert.equal(r.status, 201, r.text);
  const d = (await call('GET', `/tickets/${r.json.id}`, ctx.e1.token)).json; assert.equal(d.attachments.length, 1);
  const dl = await call('GET', `/tickets/attachments/${d.attachments[0].id}`, ctx.e1.token); assert.equal(dl.status, 200); assert.equal(dl.text, 'hello-attachment');
  assert.equal((await call('GET', `/tickets/attachments/${d.attachments[0].id}`, ctx.e2.token)).status, 404);
  assert.equal((await call('GET', `/tickets/attachments/${d.attachments[0].id}`)).status, 401);
  const bad = await call('POST', '/tickets', ctx.e1.token, form({ subject: 'Bad file', description: 'xyz', category_id: ctx.catIT.id }, { name: 'virus.exe', content: 'MZ' })); assert.equal(bad.status, 400);
});

test('HR scope: sees HR-visible tickets, not unrelated IT tickets; cannot use admin functions', async () => {
  const hrT = await call('POST', '/tickets', ctx.e2.token, form({ subject: 'Payslip query', description: 'Wrong amount', category_id: ctx.catHR.id })); assert.equal(hrT.status, 201);
  const itT = await call('POST', '/tickets', ctx.e2.token, form({ subject: 'Mouse broken', description: 'No click', category_id: ctx.catIT.id })); assert.equal(itT.status, 201);
  assert.equal((await call('GET', `/tickets/${hrT.json.id}`, ctx.hr.token)).status, 200);
  assert.equal((await call('GET', `/tickets/${itT.json.id}`, ctx.hr.token)).status, 404, 'HR must not see unrelated IT tickets');
  for (const [m, p, b] of [['POST', '/config/categories', { name: 'x' }], ['POST', '/users', { name: 'x' }], ['GET', '/users', undefined], ['POST', '/projects', { name: 'Nope' }], ['PUT', '/config/settings/general', {}]] as any)
    assert.equal((await call(m, p, ctx.hr.token, b)).status, 403, `${m} ${p} must be admin-only`);
  assert.equal((await call('GET', '/audit-logs', ctx.hr.token)).status, 200);
  assert.ok(!(await call('GET', '/audit-logs?pageSize=100', ctx.hr.token)).json.data.some((l: any) => l.module === 'auth' || l.module === 'configuration'), 'HR sees only ticket/request activity');
  const es = await call('POST', `/tickets/${hrT.json.id}/escalate`, ctx.hr.token, { reason: 'Payroll cut-off tomorrow' }); assert.equal(es.status, 200, es.text);
  assert.equal((await call('GET', `/tickets/${hrT.json.id}`, ctx.admin)).json.is_escalated, true);
});

test('employee cannot reach admin / HR functions by calling the API directly', async () => {
  for (const [m, p] of [['GET', '/users'], ['GET', '/users/directory/list'], ['GET', '/audit-logs'], ['GET', '/config/sla'], ['GET', '/config/roles'], ['GET', '/reports/agents'], ['GET', '/tickets/assignable'], ['GET', '/tasks?view=all'], ['POST', '/tickets/bulk']] as any)
    assert.equal((await call(m, p, ctx.e1.token, m === 'POST' ? { ids: [], action: 'status' } : undefined)).status, 403, `${m} ${p}`);
  assert.equal((await call('POST', '/users', ctx.e1.token, { name: 'x', email: 'x@y.z', password: 'Passw0rd!x', role: 'admin' })).status, 403);
  assert.equal((await call('PATCH', '/users/me', ctx.e1.token, { role: 'admin' })).status, 403, 'self role change refused');
  assert.equal((await call('GET', '/tickets')).status, 401);
});

test('accounting and quotation endpoints are gone', async () => {
  for (const p of ['/invoices', '/quotations', '/customers', '/vendors', '/payments', '/credit-notes', '/leads']) assert.equal((await call('GET', p, ctx.admin)).status, 404, p);
});

test('notifications: creation, assignment and replies notify the right people; mark read works', async () => {
  const r = await call('POST', '/tickets', ctx.e1.token, form({ subject: 'Notify test', description: 'abc', category_id: ctx.catIT.id })); const id = r.json.id;
  let n = (await call('GET', '/notifications', ctx.e1.token)).json; assert.ok(n.data.some((x: any) => x.type === 'ticket_created' && x.entity_id === id));
  await call('POST', `/tickets/${id}/assign`, ctx.admin, { assignee_id: ctx.hr.id });
  assert.ok((await call('GET', '/notifications', ctx.hr.token)).json.data.some((x: any) => x.type === 'ticket_assigned' && x.entity_id === id));
  await call('POST', `/tickets/${id}/comments`, ctx.hr.token, form({ body: 'Can you share the asset tag?', request_info: 'true' }));
  const d = (await call('GET', `/tickets/${id}`, ctx.e1.token)).json; assert.equal(d.status, 'pending', 'info request moves ticket to pending'); assert.ok(d.first_response_at, 'first public staff reply starts the SLA response');
  n = (await call('GET', '/notifications', ctx.e1.token)).json; assert.ok(n.data.some((x: any) => x.type === 'info_request' && x.entity_id === id));
  await call('POST', `/tickets/${id}/comments`, ctx.e1.token, form({ body: 'Tag is A-1234' }));
  assert.equal((await call('GET', `/tickets/${id}`, ctx.e1.token)).json.status, 'in_progress', 'requester reply resumes work');
  const before = n.unread; assert.ok(before > 0);
  await call('POST', '/notifications/read-all', ctx.e1.token); assert.equal((await call('GET', '/notifications', ctx.e1.token)).json.unread, 0);
});

test('search, filters, sorting, pagination and bulk updates', async () => {
  const all = (await call('GET', '/tickets?pageSize=2&page=1&sort=priority&dir=desc', ctx.admin)).json; assert.equal(all.data.length, 2); assert.ok(all.total >= 4);
  const rank: any = { critical: 4, high: 3, medium: 2, low: 1 }; assert.ok(rank[all.data[0].priority] >= rank[all.data[1].priority]);
  assert.ok((await call('GET', '/tickets?search=Payslip', ctx.admin)).json.data.every((t: any) => /payslip/i.test(t.subject)));
  assert.ok((await call('GET', `/tickets?search=${ctx.t1.ticket_no}`, ctx.admin)).json.data.some((t: any) => t.id === ctx.t1.id));
  assert.ok((await call('GET', '/tickets?view=unassigned', ctx.admin)).json.data.every((t: any) => !t.assignee_id));
  assert.ok((await call('GET', '/tickets?priority=critical,high', ctx.admin)).json.data.every((t: any) => ['critical', 'high'].includes(t.priority)));
  assert.equal((await call('GET', '/tickets?category_id=not-a-uuid', ctx.admin)).status, 400);
  const open = (await call('GET', '/tickets?view=unassigned&pageSize=3', ctx.admin)).json.data.map((t: any) => t.id);
  const b = (await call('POST', '/tickets/bulk', ctx.admin, { ids: open, action: 'assign', assignee_id: ctx.hr.id })).json; assert.equal(b.updated + b.failed.length, open.length); assert.ok(b.updated > 0);
  const c = (await call('POST', '/tickets/bulk', ctx.admin, { ids: open, action: 'status', status: 'closed' })).json; assert.equal(c.updated, 0, 'closing straight from assigned is refused for every ticket'); assert.equal(c.failed.length, open.length);
});

test('tasks, projects and requests respect ownership and approval rules', async () => {
  const t = await call('POST', '/tasks', ctx.e1.token, { title: 'Prepare slides', priority: 'high', due_date: '2030-01-01' }); assert.equal(t.status, 201, t.text);
  assert.equal((await call('POST', '/tasks', ctx.e1.token, { title: 'For someone else', assigned_to: ctx.e2.id })).status, 403);
  assert.equal((await call('GET', `/tasks/${t.json.id}`, ctx.e2.token)).status, 404);
  assert.equal((await call('PATCH', `/tasks/${t.json.id}`, ctx.e1.token, { status: 'completed' })).status, 200);
  const given = await call('POST', '/tasks', ctx.admin, { title: 'Admin assigned', assigned_to: ctx.e2.id }); assert.equal(given.status, 201);
  assert.ok((await call('GET', '/notifications', ctx.e2.token)).json.data.some((n: any) => n.type === 'task_assigned'));
  const p = await call('POST', '/projects', ctx.admin, { name: `Proj ${stamp}`, members: [{ user_id: ctx.e1.id }], due_date: '2031-01-01', start_date: '2030-01-01' }); assert.equal(p.status, 201, p.text);
  assert.ok((await call('GET', '/projects', ctx.e1.token)).json.data.some((x: any) => x.id === p.json.id));
  assert.ok(!(await call('GET', '/projects', ctx.e2.token)).json.data.some((x: any) => x.id === p.json.id)); assert.equal((await call('GET', `/projects/${p.json.id}`, ctx.e2.token)).status, 404);
  const lv = await call('POST', '/requests', ctx.e1.token, { type: 'leave', leave_type: 'annual', start_date: '2030-05-01', end_date: '2030-05-03', reason: 'Trip' }); assert.equal(lv.status, 201, lv.text);
  assert.equal((await call('POST', '/requests', ctx.e1.token, { type: 'leave', leave_type: 'sick', start_date: '2030-05-02', end_date: '2030-05-04' })).status, 400, 'overlapping leave refused');
  assert.equal((await call('POST', `/requests/${lv.json.id}/decide`, ctx.e1.token, { decision: 'approved' })).status, 403, 'employee cannot approve');
  assert.equal((await call('POST', `/requests/${lv.json.id}/decide`, ctx.e2.token, { decision: 'approved' })).status, 403);
  assert.equal((await call('POST', `/requests/${lv.json.id}/decide`, ctx.hr.token, { decision: 'rejected' })).status, 400, 'rejection needs a reason');
  assert.equal((await call('POST', `/requests/${lv.json.id}/decide`, ctx.hr.token, { decision: 'approved' })).status, 200);
  assert.equal((await call('POST', `/requests/${lv.json.id}/decide`, ctx.hr.token, { decision: 'approved' })).status, 400, 'already decided');
  const own = await call('POST', '/requests', ctx.hr.token, { type: 'equipment', title: 'Headset' }); assert.equal((await call('POST', `/requests/${own.json.id}/decide`, ctx.hr.token, { decision: 'approved' })).status, 403, 'HR cannot approve own request');
  assert.equal((await call('POST', `/requests/${own.json.id}/decide`, ctx.admin, { decision: 'approved' })).status, 200);
});

test('chat: DM between employee and HR; outsiders cannot read it', async () => {
  const c = await call('POST', '/chat/conversations', ctx.e1.token, { type: 'direct', user_id: ctx.hr.id }); assert.equal(c.status, 200, c.text);
  const again = await call('POST', '/chat/conversations', ctx.hr.token, { type: 'direct', user_id: ctx.e1.id }); assert.equal(again.json.id, c.json.id, 'one DM per pair');
  assert.equal((await call('POST', `/chat/conversations/${c.json.id}/messages`, ctx.e1.token, { body: 'Hello HR' })).status, 201);
  assert.equal((await call('GET', '/chat/unread', ctx.hr.token)).json.unread >= 1, true);
  const msgs = (await call('GET', `/chat/conversations/${c.json.id}/messages`, ctx.hr.token)).json.data; assert.equal(msgs.at(-1).body, 'Hello HR');
  assert.equal((await call('GET', '/chat/unread', ctx.hr.token)).json.unread, 0, 'reading clears unread');
  assert.equal((await call('GET', `/chat/conversations/${c.json.id}/messages`, ctx.e2.token)).status, 404);
  assert.equal((await call('POST', `/chat/conversations/${c.json.id}/messages`, ctx.e2.token, { body: 'intruder' })).status, 404);
  assert.equal((await call('POST', '/chat/conversations', ctx.e1.token, { type: 'group', name: 'Nope', user_ids: [] })).status, 403, 'employees cannot create groups');
  assert.equal((await call('POST', '/chat/conversations', ctx.hr.token, { type: 'group', name: 'HR + Emp', user_ids: [ctx.e1.id, ctx.e2.id] })).status, 201);
});

test('reports and activity log: scoped, exportable and audited', async () => {
  const r = await call('GET', '/reports/status', ctx.admin); assert.equal(r.status, 200); assert.ok(r.json.rows.length > 0);
  const csv = await call('GET', '/reports/priority?format=csv', ctx.admin); assert.equal(csv.status, 200); assert.match(csv.text, /Priority,Total,Open,Resolved/);
  assert.equal((await call('GET', '/reports/agents', ctx.hr.token)).status, 403);
  const mine = await call('GET', '/reports/my-tickets', ctx.e1.token); assert.equal(mine.status, 200); assert.ok(mine.json.rows.every((x: any) => x.ticket_no));
  assert.equal((await call('GET', '/reports/status', ctx.e1.token)).status, 403, 'employees only get personal reports');
  const log = (await call('GET', '/audit-logs?pageSize=100', ctx.admin)).json.data;
  for (const a of ['login', 'create', 'status_change', 'assign', 'internal_note']) assert.ok(log.some((l: any) => l.action === a), `audit has ${a}`);
  assert.ok(log.every((l: any) => l.description && l.created_at));
  await call('POST', '/auth/logout', ctx.e1.token);
  assert.ok((await call('GET', '/audit-logs?action=logout', ctx.admin)).json.data.length >= 1, 'logout recorded');
  assert.equal((await call('POST', '/auth/login', undefined, { email: ADMIN.email, password: 'wrong' })).status, 401);
});

test('dashboards return role-appropriate data', async () => {
  const a = (await call('GET', '/dashboard', ctx.admin)).json; assert.equal(a.role, 'admin'); assert.ok('sla_compliance' in a.kpis && a.trend.length === 14);
  const h = (await call('GET', '/dashboard', ctx.hr.token)).json; assert.equal(h.role, 'hr');
  const e = (await call('GET', '/dashboard', ctx.e1.token)).json; assert.equal(e.role, 'employee'); assert.ok(!('workload' in e), 'employee dashboard has no staff workload');
});

test('navbar: favorites, watchers, Workspace ("involved") views and the incident type filter', async () => {
  const id = ctx.t1.id;
  assert.equal((await call('POST', `/tickets/${id}/favorite`, ctx.e1.token, { on: true })).status, 200);
  const fav = (await call('GET', '/tickets?view=favorites', ctx.e1.token)).json; assert.ok(fav.data.some((t: any) => t.id === id && t.is_favorite === true), 'starred ticket is listed');
  assert.equal((await call('POST', `/tickets/${id}/favorite`, ctx.e2.token, { on: true })).status, 404, 'cannot star a ticket you cannot see');
  const nav = (await call('GET', '/tickets/nav', ctx.e1.token)).json; assert.ok(nav.favorites >= 1 && nav.favorite_tickets.some((t: any) => t.id === id) && nav.ws_open >= 1);

  assert.equal((await call('GET', `/tickets/${id}`, ctx.e2.token)).status, 404, 'unrelated employee cannot open it');
  assert.equal((await call('POST', `/tickets/${id}/watchers`, ctx.e2.token, { user_id: ctx.e2.id })).status, 403, 'only staff add watchers');
  assert.equal((await call('POST', `/tickets/${id}/watchers`, ctx.admin, { user_id: ctx.e2.id })).status, 200);
  const d = await call('GET', `/tickets/${id}`, ctx.e2.token); assert.equal(d.status, 200, 'watcher can read'); assert.equal(d.json.is_watching, true); assert.equal(d.json.actions.can_reply, false); assert.equal(d.json.watchers.length, 0, 'watcher list is staff-only');
  assert.equal((await call('POST', `/tickets/${id}/comments`, ctx.e2.token, { body: 'hello' })).status, 403, 'watcher is read-only');
  assert.deepEqual((await call('GET', '/tickets?view=involved', ctx.e2.token)).json.data.find((t: any) => t.id === id)?.involvement, ['watching']);
  assert.ok((await call('GET', '/tickets?view=watching', ctx.e2.token)).json.data.some((t: any) => t.id === id));
  assert.ok((await call('GET', '/tickets?view=involved', ctx.e1.token)).json.data.find((t: any) => t.id === id).involvement.includes('requester'));

  assert.ok((await call('GET', '/tickets?type=incident', ctx.admin)).json.data.some((t: any) => t.id === id), 'tickets default to the incident type');
  assert.ok(!(await call('GET', '/tickets?type=question', ctx.admin)).json.data.some((t: any) => t.id === id));
  assert.equal((await call('DELETE', `/tickets/${id}/watchers/${ctx.e2.id}`, ctx.admin)).status, 200);
  assert.equal((await call('GET', `/tickets/${id}`, ctx.e2.token)).status, 404, 'access ends when the watcher is removed');
});

test('configuration: categories archive instead of delete when used; SLA validated; deactivated users are locked out', async () => {
  const c = await call('POST', '/config/categories', ctx.admin, { name: `Cat ${stamp}`, hr_visible: true }); assert.equal(c.status, 201);
  assert.equal((await call('POST', '/config/categories', ctx.admin, { name: `Cat ${stamp}` })).status, 400, 'duplicate name refused');
  const t = await call('POST', '/tickets', ctx.e1.token, form({ subject: 'Uses new cat', description: 'xyz', category_id: c.json.id })); assert.equal(t.status, 201);
  assert.equal((await call('DELETE', `/config/categories/${c.json.id}`, ctx.admin)).json.archived, true);
  assert.equal((await call('POST', '/config/sla', ctx.admin, { name: 'bad', priority: 'low', category_id: c.json.id, first_response_minutes: 100, resolution_minutes: 10 })).status, 400);
  assert.equal((await call('PATCH', `/users/${ctx.e2.id}`, ctx.admin, { is_active: false })).status, 200);
  assert.equal((await call('GET', '/tickets', ctx.e2.token)).status, 403, 'deactivated user is locked out immediately');
  assert.equal((await call('POST', '/auth/login', undefined, { email: `emp2.${stamp}@test.local`, password: 'Passw0rd!x' })).status, 403);
});

test('assignment to employees: accept → progress updates → admin sees it; reassign keeps the same reference ID', async () => {
  const mk = async (name: string) => { const email = `${name}.${stamp}@test.local`; const r = await call('POST', '/users', ctx.admin, { name, email, password: 'Passw0rd!x', role: 'employee' }); assert.equal(r.status, 201, r.text); const l = await login(email, 'Passw0rd!x'); return { id: r.json.id, token: l.token }; };
  const a = await mk('assignA'), b = await mk('assignB'), other = await mk('assignOther');
  assert.ok((await call('GET', '/tickets/assignable', ctx.admin)).json.data.some((u: any) => u.id === a.id), 'employees can be chosen as assignee');

  // admin raises a ticket straight to employee A
  const r = await call('POST', '/tickets', ctx.admin, form({ subject: 'Set up laptop for new joiner', description: 'Install the standard image', category_id: ctx.catIT.id, assignee_id: a.id }));
  assert.equal(r.status, 201, r.text); const id = r.json.id, no = r.json.ticket_no;
  assert.equal(r.json.acceptance, 'pending'); assert.equal(r.json.status, 'assigned');
  assert.ok((await call('GET', '/notifications', a.token)).json.data.some((n: any) => n.type === 'ticket_assigned' && n.entity_id === id));

  // the employee can open it, sees the accept action, but cannot work it before accepting
  let d = (await call('GET', `/tickets/${id}`, a.token)).json; assert.equal(d.actions.can_accept, true); assert.equal(d.actions.can_update, false); assert.deepEqual(d.actions.next_statuses, []);
  assert.equal((await call('GET', `/tickets/${id}`, other.token)).status, 404, 'unrelated employee still cannot see it');
  assert.equal((await call('POST', `/tickets/${id}/status`, a.token, { status: 'in_progress' })).status, 400, 'cannot start before accepting');
  assert.equal((await call('POST', `/tickets/${id}/updates`, a.token, { note: 'working on it' })).status, 400, 'cannot post updates before accepting');
  assert.equal((await call('POST', `/tickets/${id}/accept`, other.token, {})).status, 404);
  assert.equal((await call('POST', `/tickets/${id}/accept`, b.token, {})).status, 404, 'someone it is not assigned to cannot accept');
  assert.ok((await call('GET', '/tickets?view=awaiting_acceptance', a.token)).json.data.some((t: any) => t.id === id));
  assert.ok((await call('GET', '/tickets?view=awaiting_acceptance', ctx.admin)).json.data.some((t: any) => t.id === id), 'admin sees it waiting');

  // accept → admin is notified and sees it as accepted
  assert.equal((await call('POST', `/tickets/${id}/accept`, a.token, { note: 'On it' })).status, 200);
  assert.equal((await call('POST', `/tickets/${id}/accept`, a.token, {})).status, 400, 'cannot accept twice');
  d = (await call('GET', `/tickets/${id}`, ctx.admin)).json; assert.equal(d.acceptance, 'accepted'); assert.ok(d.accepted_at); assert.ok(d.updates.some((x: any) => x.type === 'accepted'));
  assert.ok((await call('GET', '/notifications', ctx.admin)).json.data.some((n: any) => n.type === 'ticket_accepted' && n.entity_id === id), 'admin notified of acceptance');
  assert.ok((await call('GET', '/tickets?view=accepted', ctx.admin)).json.data.some((t: any) => t.id === id), 'appears in the admin accepted view');
  assert.ok((await call('GET', '/dashboard', ctx.admin)).json.acceptances.some((x: any) => x.ticket_id === id && x.type === 'accepted'), 'appears on the admin dashboard');

  // progress updates + status moves by the employee
  d = (await call('GET', `/tickets/${id}`, a.token)).json; assert.equal(d.actions.can_update, true); assert.deepEqual(d.actions.next_statuses, ['in_progress']);
  assert.equal((await call('POST', `/tickets/${id}/updates`, a.token, { note: 'Image downloaded', progress: 40, status: 'in_progress' })).status, 200);
  assert.equal((await call('POST', `/tickets/${id}/updates`, a.token, { note: 'x' })).status, 400, 'update needs a real note');
  assert.equal((await call('POST', `/tickets/${id}/updates`, a.token, { note: 'cancel it', status: 'cancelled' })).status, 400, 'employee cannot cancel');
  d = (await call('GET', `/tickets/${id}`, ctx.admin)).json; assert.equal(d.status, 'in_progress'); assert.equal(d.progress, 40);
  assert.ok((await call('GET', '/notifications', ctx.admin)).json.data.length > 0);

  // admin reassigns to employee B: same ticket / same reference number, acceptance starts over, A is informed and loses access
  assert.equal((await call('POST', `/tickets/${id}/assign`, ctx.admin, { assignee_id: b.id, note: 'A is on leave' })).status, 200);
  d = (await call('GET', `/tickets/${id}`, ctx.admin)).json;
  assert.equal(d.ticket_no, no, 'reference ID unchanged'); assert.equal(d.id, id); assert.equal(d.assignee_id, b.id);
  assert.equal(d.acceptance, 'pending'); assert.equal(d.status, 'assigned', 'new assignee starts from assigned'); assert.equal(d.accepted_at, null);
  assert.ok(d.updates.some((x: any) => x.type === 'reassigned' && x.to_user_name === 'assignB'));
  assert.ok(d.assignment_history.some((h: any) => h.from_assignee_name === 'assignA' && h.to_assignee_name === 'assignB'));
  assert.ok((await call('GET', '/notifications', b.token)).json.data.some((n: any) => n.type === 'ticket_assigned' && n.entity_id === id));
  assert.ok((await call('GET', '/notifications', a.token)).json.data.some((n: any) => n.type === 'ticket_assignment' && n.entity_id === id), 'previous assignee told');
  assert.equal((await call('GET', `/tickets/${id}`, a.token)).status, 404, 'previous assignee no longer has access');
  assert.equal((await call('POST', `/tickets/${id}/updates`, a.token, { note: 'still me?' })).status, 404);

  // B declines → back to the queue with the reason; admin reassigns again, B accepts and resolves
  assert.equal((await call('POST', `/tickets/${id}/decline`, b.token, { reason: '' })).status, 400, 'a reason is required');
  assert.equal((await call('POST', `/tickets/${id}/decline`, b.token, { reason: 'Out of office all week' })).status, 200);
  d = (await call('GET', `/tickets/${id}`, ctx.admin)).json; assert.equal(d.assignee_id, null); assert.equal(d.acceptance, 'declined'); assert.equal(d.acceptance_note, 'Out of office all week'); assert.equal(d.ticket_no, no);
  assert.ok((await call('GET', '/tickets?view=declined', ctx.admin)).json.data.some((t: any) => t.id === id));
  assert.ok((await call('GET', '/notifications', ctx.admin)).json.data.some((n: any) => n.type === 'ticket_declined' && n.entity_id === id));
  assert.equal((await call('POST', `/tickets/${id}/assign`, ctx.admin, { assignee_id: a.id })).status, 200);
  assert.equal((await call('POST', `/tickets/${id}/accept`, a.token, {})).status, 200);
  assert.equal((await call('POST', `/tickets/${id}/updates`, a.token, { note: 'Image done, handed over', status: 'in_progress' })).status, 200);
  assert.equal((await call('POST', `/tickets/${id}/updates`, a.token, { note: 'Laptop configured and delivered', status: 'resolved' })).status, 200);
  d = (await call('GET', `/tickets/${id}`, ctx.admin)).json; assert.equal(d.status, 'resolved'); assert.equal(d.progress, 100); assert.equal(d.resolution_note, 'Laptop configured and delivered');
  assert.equal(d.ticket_no, no);

  // admin / HR assignees need no acceptance
  const hrT = await call('POST', '/tickets', ctx.admin, form({ subject: 'HR handles this', description: 'direct assignment', category_id: ctx.catHR.id, assignee_id: ctx.hr.id }));
  assert.equal(hrT.status, 201, hrT.text); assert.equal(hrT.json.acceptance, null);
});
