import bcrypt from 'bcryptjs';
import { pool, query } from './pool';
import { slaTargets } from '../lib/sla';

/**
 * Idempotent seed. Base configuration (roles, company, admin, departments, teams, categories, SLA policies, #general) is always ensured.
 * Demo people / projects / tickets are created only when SEED_DEMO is not "false" AND the database has no tickets yet.
 */
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@hawmess.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin@123';

async function seed() {
  console.log('Seeding Hawmess...');
  const roleDefs: [string, string[]][] = [
    ['admin', ['*']],
    ['hr', ['tickets.manage.hr', 'people.view', 'requests.decide', 'projects.view', 'reports.view']],
    ['employee', ['tickets.create', 'tickets.view.own', 'tasks.own', 'projects.view.own']],
  ];
  for (const [name, perms] of roleDefs) await query(`INSERT INTO roles (name, permissions) VALUES ($1,$2) ON CONFLICT (name) DO UPDATE SET permissions=$2`, [name, JSON.stringify(perms)]);
  const roleId = async (n: string) => (await query<any>(`SELECT id FROM roles WHERE name=$1`, [n]))[0].id;

  let company = (await query<any>(`SELECT * FROM companies ORDER BY created_at LIMIT 1`))[0];
  if (!company) company = (await query<any>(`INSERT INTO companies (name, legal_name, email) VALUES ('Hawmess','Hawmess','support@hawmess.com') RETURNING *`))[0];
  const cid = company.id;

  const mkUser = async (name: string, email: string, password: string, role: string, extra: { dept?: string; designation?: string } = {}) => {
    let u = (await query<any>(`SELECT * FROM users WHERE lower(email)=lower($1)`, [email]))[0];
    if (!u) u = (await query<any>(`INSERT INTO users (name, email, password_hash, designation, department_id) VALUES ($1,$2,$3,$4,(SELECT id FROM departments WHERE company_id=$5 AND name=$6)) RETURNING *`, [name, email.toLowerCase(), await bcrypt.hash(password, 10), extra.designation || null, cid, extra.dept || null]))[0];
    await query(`INSERT INTO company_users (company_id, user_id, role_id) VALUES ($1,$2,$3) ON CONFLICT (company_id, user_id) DO NOTHING`, [cid, u.id, await roleId(role)]);
    return u.id as string;
  };

  for (const d of ['IT', 'HR', 'Operations', 'Finance', 'Engineering', 'Facilities']) await query(`INSERT INTO departments (company_id, name) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [cid, d]);
  const adminId = await mkUser('Administrator', ADMIN_EMAIL, ADMIN_PASSWORD, 'admin', { dept: 'IT', designation: 'System Administrator' });

  const teamDefs: [string, string][] = [['IT Support', 'IT'], ['HR Services', 'HR'], ['Facilities Desk', 'Facilities']];
  for (const [t, d] of teamDefs) await query(`INSERT INTO teams (company_id, name, department_id) VALUES ($1,$2,(SELECT id FROM departments WHERE company_id=$1 AND name=$3)) ON CONFLICT DO NOTHING`, [cid, t, d]);
  const teamId = async (n: string) => (await query<any>(`SELECT id FROM teams WHERE company_id=$1 AND name=$2`, [cid, n]))[0].id as string;

  // categories + assignment rules (default team) — HR sees the hr_visible ones
  const cats: [string, string | null, boolean, string[]][] = [
    ['IT Support', 'IT Support', false, ['Account / Password', 'Email', 'Other']],
    ['Software and Applications', 'IT Support', false, ['Installation', 'Licence', 'Bug / Error']],
    ['Hardware', 'IT Support', false, ['Laptop / Desktop', 'Printer', 'Peripherals']],
    ['Network and Internet', 'IT Support', false, ['Wi-Fi', 'VPN', 'Connectivity']],
    ['HR and Employee Services', 'HR Services', true, ['Payroll', 'Leave', 'Onboarding', 'Policies']],
    ['Access and Permissions', 'IT Support', true, ['System access', 'Building access']],
    ['Facilities', 'Facilities Desk', false, ['Workspace', 'Maintenance', 'Supplies']],
    ['Project Support', null, false, []],
    ['General Inquiry', null, true, []],
  ];
  for (const [name, team, hrv, subs] of cats) {
    await query(`INSERT INTO ticket_categories (company_id, name, default_team_id, hr_visible) SELECT $1,$2,$3,$4 WHERE NOT EXISTS (SELECT 1 FROM ticket_categories WHERE company_id=$1 AND name=$2 AND parent_id IS NULL)`, [cid, name, team ? await teamId(team) : null, hrv]);
    const pid = (await query<any>(`SELECT id FROM ticket_categories WHERE company_id=$1 AND name=$2 AND parent_id IS NULL`, [cid, name]))[0].id;
    for (const s of subs) await query(`INSERT INTO ticket_categories (company_id, name, parent_id) SELECT $1,$2,$3 WHERE NOT EXISTS (SELECT 1 FROM ticket_categories WHERE company_id=$1 AND name=$2 AND parent_id=$3)`, [cid, s, pid]);
  }

  // starter knowledge-base articles (idempotent by title)
  const kb: [string, string, string, string][] = [
    ['How to reset your password', 'Accounts', 'Reset your sign-in password in under a minute.', '1. Open Profile & settings from your avatar menu.\n2. Choose Change password and enter your current password.\n3. Pick a new password (at least 8 characters) and save.\n\nForgot it? Ask HR or an administrator to reset it for you, or raise an incident under "Reason for creation: Account access".'],
    ['Raising a good incident', 'Helpdesk', 'What to include so your incident is fixed faster.', 'Use a short, specific Short description (e.g. "Outlook will not open"). In the Detailed Description say what happened, what you expected, any error message, and when it started. Attach a screenshot if you can. Choose Impact (how many people are affected) and Urgency (how soon it must be fixed) — Priority is calculated for you.'],
    ['Requesting leave', 'HR', 'How to apply for leave and track approval.', 'Open To-do → Leave & requests, choose Leave, pick the leave type and dates, and submit. HR approves or rejects the request and you are notified either way. You cannot approve your own request.'],
    ['What do the ticket states mean?', 'Helpdesk', 'New, Open, Assigned, In Progress, Pending, Resolved, Closed.', 'New: received, not yet triaged. Open: routed to a team. Assigned: owned by a person. In Progress: being worked on. Pending: waiting on you or a third party. Resolved: a fix is provided — close it or reopen if it is not fixed. Closed: finished.'],
  ];
  for (const [title, category, summary, body] of kb) await query(`INSERT INTO knowledge_articles (company_id, title, category, summary, body) SELECT $1,$2,$3,$4,$5 WHERE NOT EXISTS (SELECT 1 FROM knowledge_articles WHERE company_id=$1 AND title=$2)`, [cid, title, category, summary, body]);

  // default SLA policies (minutes) — editable in Configuration → SLA policies
  const sla: [string, string, number, number][] = [['Critical', 'critical', 30, 240], ['High', 'high', 60, 480], ['Medium', 'medium', 240, 1440], ['Low', 'low', 480, 4320]];
  for (const [n, p, fr, rs] of sla) await query(`INSERT INTO sla_policies (company_id, name, priority, first_response_minutes, resolution_minutes) SELECT $1,$2,$3,$4,$5 WHERE NOT EXISTS (SELECT 1 FROM sla_policies WHERE company_id=$1 AND priority=$3 AND category_id IS NULL)`, [cid, n, p, fr, rs]);

  // company-wide #general channel
  await query(`INSERT INTO conversations (company_id, type, name, direct_key, created_by) VALUES ($1,'channel','general','channel:general',$2) ON CONFLICT (direct_key) DO NOTHING`, [cid, adminId]);
  const general = (await query<any>(`SELECT id FROM conversations WHERE direct_key='channel:general'`))[0].id;
  await query(`INSERT INTO conversation_members (conversation_id, user_id) SELECT $1, cu.user_id FROM company_users cu WHERE cu.company_id=$2 ON CONFLICT DO NOTHING`, [general, cid]);

  if (process.env.SEED_DEMO !== 'false' && (await query<any>(`SELECT COUNT(*)::int n FROM tickets`))[0].n === 0) await demo(cid, adminId, general, mkUser, teamId);
  console.log('Seed complete.');
}

async function demo(cid: string, adminId: string, general: string, mkUser: any, teamId: (n: string) => Promise<string>) {
  console.log('Creating demo people, projects and tickets (set SEED_DEMO=false to skip)...');
  const hr = await mkUser('Priya Nair', 'hr@hawmess.com', 'Hr@12345', 'hr', { dept: 'HR', designation: 'HR Manager' });
  const asha = await mkUser('Asha Rao', 'asha@hawmess.com', 'Employee@123', 'employee', { dept: 'Engineering', designation: 'Software Engineer' });
  const ravi = await mkUser('Ravi Kumar', 'ravi@hawmess.com', 'Employee@123', 'employee', { dept: 'Operations', designation: 'Operations Analyst' });
  const meera = await mkUser('Meera Shah', 'meera@hawmess.com', 'Employee@123', 'employee', { dept: 'Finance', designation: 'Accountant' });
  const itAgent = await mkUser('Karthik Iyer', 'it@hawmess.com', 'Hr@12345', 'hr', { dept: 'IT', designation: 'IT Support Lead' });
  await query(`INSERT INTO conversation_members (conversation_id, user_id) SELECT $1, cu.user_id FROM company_users cu WHERE cu.company_id=$2 ON CONFLICT DO NOTHING`, [general, cid]);
  for (const [t, ids] of [['HR Services', [hr]], ['IT Support', [itAgent, adminId]], ['Facilities Desk', [hr]]] as [string, string[]][])
    for (const id of ids) await query(`INSERT INTO team_members (team_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [await teamId(t), id]);

  const proj = async (code: string, name: string, status: string, start: string, due: string, mgr: string, members: string[], desc: string) => {
    const p = (await query<any>(`INSERT INTO projects (company_id, code, name, description, status, start_date, due_date, manager_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (company_id, code) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [cid, code, name, desc, status, start, due, mgr, adminId]))[0].id;
    for (const m of [mgr, ...members]) await query(`INSERT INTO project_members (project_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [p, m]);
    return p as string;
  };
  const pWeb = await proj('PRJ-001', 'Customer Portal Revamp', 'active', '2026-08-01', '2026-12-15', asha, [ravi], 'Rebuild the customer-facing portal with the new design system.');
  const pErp = await proj('PRJ-002', 'Payroll System Migration', 'planning', '2026-11-01', '2027-02-28', meera, [hr], 'Move payroll processing to the new platform.');
  await proj('PRJ-003', 'Office Move — Floor 3', 'completed', '2026-05-01', '2026-09-30', ravi, [asha], 'Relocation of teams to the third floor.');

  const cat = async (n: string) => (await query<any>(`SELECT id, default_team_id FROM ticket_categories WHERE company_id=$1 AND name=$2 AND parent_id IS NULL`, [cid, n]))[0];
  const mk = async (subject: string, desc: string, catName: string, priority: string, requester: string, status: string, hoursAgo: number, opts: { assignee?: string; project?: string; escalated?: boolean; resolved?: boolean; replied?: boolean } = {}) => {
    const c = await cat(catName); const created = new Date(Date.now() - hoursAgo * 3600_000); const sla = await slaTargets(cid, priority, c.id, created);
    const resolvedAt = ['resolved', 'closed'].includes(status) ? new Date(created.getTime() + 3 * 3600_000) : null;
    const t = (await query<any>(`INSERT INTO tickets (company_id, subject, description, category_id, priority, requester_id, department_id, project_id, team_id, assignee_id, status, is_escalated, escalated_at, escalation_reason, first_response_at, first_response_due, resolution_due, resolved_at, closed_at, resolution_note, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,(SELECT department_id FROM users WHERE id=$6),$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$20) RETURNING id`,
      [cid, subject, desc, c.id, priority, requester, opts.project || null, c.default_team_id, opts.assignee || null, status, !!opts.escalated, opts.escalated ? new Date() : null, opts.escalated ? 'Business-critical: payroll cut-off tomorrow' : null,
       opts.replied || resolvedAt ? new Date(created.getTime() + 20 * 60_000) : null, sla.first_response_due, sla.resolution_due, resolvedAt, status === 'closed' ? resolvedAt : null, resolvedAt ? 'Resolved — confirmed working after the fix.' : null, created]))[0];
    await query(`INSERT INTO ticket_status_history (ticket_id, from_status, to_status, changed_by, note, created_at) VALUES ($1,NULL,'new',$2,'Ticket created',$3)`, [t.id, requester, created]);
    if (status !== 'new') await query(`INSERT INTO ticket_status_history (ticket_id, from_status, to_status, changed_by, created_at) VALUES ($1,'new',$2,$3,$4)`, [t.id, status, opts.assignee || adminId, new Date(created.getTime() + 25 * 60_000)]);
    if (opts.assignee) await query(`INSERT INTO ticket_assignments (ticket_id, to_assignee, to_team, changed_by, note, created_at) VALUES ($1,$2,$3,$4,'Assigned',$5)`, [t.id, opts.assignee, c.default_team_id, adminId, new Date(created.getTime() + 10 * 60_000)]);
    if (opts.replied) await query(`INSERT INTO ticket_comments (ticket_id, author_id, body, created_at) VALUES ($1,$2,'Thanks for reporting this — we are looking into it now.',$3)`, [t.id, opts.assignee || adminId, new Date(created.getTime() + 20 * 60_000)]);
    if (opts.assignee) await query(`INSERT INTO ticket_comments (ticket_id, author_id, body, is_internal, created_at) VALUES ($1,$2,'Internal: checked logs, looks like a profile corruption. Will rebuild.',true,$3)`, [t.id, opts.assignee, new Date(created.getTime() + 30 * 60_000)]);
    return t.id as string;
  };
  const tVpn = await mk('Cannot connect to office VPN', 'Since this morning the VPN client says "authentication failed" even though my password works elsewhere.', 'Network and Internet', 'high', asha, 'in_progress', 3, { assignee: itAgent, replied: true });
  await mk('Laptop battery drains in an hour', 'My laptop battery dropped from 100% to 5% in about an hour of normal use.', 'Hardware', 'medium', ravi, 'new', 2);
  const tPay = await mk('Payroll shows wrong tax deduction for October', 'The October payslip deducts more tax than previous months. Please review.', 'HR and Employee Services', 'critical', meera, 'assigned', 5, { assignee: hr, escalated: true, replied: true });
  await mk('Need access to the shared finance folder', 'Please grant me read access to /Finance/Reports.', 'Access and Permissions', 'low', asha, 'pending', 30, { assignee: itAgent, replied: true });
  await mk('Install Figma on my workstation', 'Needed for the Customer Portal Revamp project.', 'Software and Applications', 'medium', asha, 'resolved', 52, { assignee: itAgent, project: pWeb });
  await mk('Desk lamp not working on floor 3', 'The lamp at desk 3-14 flickers and then turns off.', 'Facilities', 'low', ravi, 'closed', 100, { assignee: hr });
  const tSandbox = await mk('Payroll migration kickoff — need test environment', 'Project team needs a sandbox environment for the payroll migration.', 'Project Support', 'high', meera, 'open', 8, { project: pErp });
  await mk('Question about leave carry-over policy', 'How many unused days carry over to next year?', 'HR and Employee Services', 'low', ravi, 'new', 1);
  await query(`UPDATE tickets SET request_type='service_request' WHERE company_id=$1 AND subject IN ('Install Figma on my workstation','Need access to the shared finance folder','Payroll migration kickoff — need test environment')`, [cid]);
  await query(`UPDATE tickets SET request_type='question' WHERE company_id=$1 AND subject LIKE 'Question about leave carry-over%'`, [cid]);
  // demo data for the Favorites and Workspace menus
  await query(`INSERT INTO ticket_favorites (user_id, ticket_id) VALUES ($1,$2),($1,$3) ON CONFLICT DO NOTHING`, [adminId, tVpn, tPay]);
  await query(`INSERT INTO ticket_watchers (ticket_id, user_id, added_by) VALUES ($1,$2,$3),($4,$2,$3),($1,$5,$3) ON CONFLICT DO NOTHING`, [tPay, asha, adminId, tSandbox, hr]);

  const task = async (title: string, to: string, by: string, status: string, due: number, prio: string, project?: string) =>
    query(`INSERT INTO tasks (company_id, title, description, assigned_to, created_by, priority, status, due_date, project_id) VALUES ($1,$2,'',$3,$4,$5,$6,CURRENT_DATE + $7::int,$8)`, [cid, title, to, by, prio, status, due, project || null]);
  await task('Draft new portal navigation', asha, adminId, 'in_progress', 3, 'high', pWeb);
  await task('Review accessibility checklist', ravi, asha, 'pending', -1, 'medium', pWeb);
  await task('Collect payroll vendor requirements', meera, adminId, 'pending', 7, 'high', pErp);
  await task('Update leave policy FAQ', hr, adminId, 'pending', 2, 'low');
  await task('Confirm floor 3 seating plan', ravi, adminId, 'completed', -5, 'medium');

  await query(`INSERT INTO employee_requests (company_id, user_id, type, leave_type, title, reason, start_date, end_date) VALUES ($1,$2,'leave','annual','Annual leave','Family function',CURRENT_DATE+10,CURRENT_DATE+12)`, [cid, asha]);
  await query(`INSERT INTO employee_requests (company_id, user_id, type, title, reason) VALUES ($1,$2,'equipment','Second monitor','Working with dashboards all day')`, [cid, meera]);

  const dm = (await query<any>(`INSERT INTO conversations (company_id, type, direct_key, created_by) VALUES ($1,'direct',$2,$3) RETURNING id`, [cid, [asha, hr].sort().join(':'), asha]))[0].id;
  for (const u of [asha, hr]) await query(`INSERT INTO conversation_members (conversation_id, user_id, last_read_at) VALUES ($1,$2, now() - interval '1 day')`, [dm, u]);
  await query(`INSERT INTO messages (conversation_id, sender_id, body, created_at) VALUES ($1,$2,'Hi Priya, could you confirm my leave request for next week?', now() - interval '20 minutes'), ($1,$3,'Hi Asha — yes, I will review it this afternoon.', now() - interval '10 minutes')`, [dm, asha, hr]);
  await query(`INSERT INTO messages (conversation_id, sender_id, body) VALUES ($1,$2,'Welcome to Hawmess! Use this channel for company-wide announcements and quick questions.')`, [general, adminId]);
}

seed().then(() => pool.end()).catch(e => { console.error('Seed failed:', e); process.exit(1); });
