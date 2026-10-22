# Hawmess — Employee Helpdesk & Ticketing

*All your tickets, in one place.* Hawmess is a role-based helpdesk for **Admin**, **HR** and **Employees**: tickets with SLA tracking, tasks, projects, leave/requests, reports, an audit trail and built-in chat. It was converted from the previous accounting app — invoices, quotations, customers, vendors, payments, credit notes and CRM leads are **removed** (code, routes and UI).

Stack (unchanged): React 18 + Vite + TypeScript · Express + TypeScript · PostgreSQL · JWT auth.

## Quick start (Docker)
```bash
cp .env.example .env        # edit JWT_SECRET, POSTGRES_PASSWORD, ADMIN_* (placeholders only in the example)
docker compose up --build   # http://localhost:3100
```
After the first start set `RUN_SEED=false` (and use `SEED_DEMO=false` for a clean production install).

## Local development
```bash
# 1. database (the compose Postgres: db/user hawmess_tickets, localhost:5433)
docker compose up -d postgres
# 2. API
cd backend && cp .env.example .env && npm install
npm run migrate && npm run seed
npm run dev                  # http://localhost:4000/api/v1/health
# 3. web app
cd ../frontend && npm install && npm run dev     # http://localhost:3100 (proxies /api to :4000)
```

## Navigation
Top row: **Dashboard · Incidents ▾ · Favorites ▾ · Workspace**. Everything else (All tickets, People, Projects, Reports, To-do, Configuration, Activity log, Profile, Sign out) is in the ☰ menu on the right.
- **Incidents** — tickets of type *incident*: report one, all / open / unassigned / assigned to me / in progress / pending / escalated / SLA breached / resolved / closed (employees see their own).
- **Favorites** — *Starred tickets* (click ☆ on any ticket), *Tickets I am watching*, plus your 5 latest starred tickets for quick access.
- **Workspace** — every ticket you are involved in (raised, assigned, escalated to you, watching, commented / acted on) with tabs and a "My role" column. Staff can add someone as a read-only *watcher* from the ticket page; watchers are notified of public replies and status changes.

### Demo accounts (created by the seed when `SEED_DEMO=true` — change/remove before real use)
| Role | Email | Password |
|---|---|---|
| Admin | admin@hawmess.com | Admin@123 |
| HR | hr@hawmess.com | Hr@12345 |
| HR (IT lead) | it@hawmess.com | Hr@12345 |
| Employee | asha@ / ravi@ / meera@hawmess.com | Employee@123 |

## Tests & checks
```bash
cd backend && npm run typecheck
API_URL=http://localhost:4000/api/v1 npm test        # 15 integration tests against a running API + seeded DB
cd ../frontend && npm run build                       # typecheck + production build
```
The suite covers authentication, role permissions, privacy of tickets/internal notes/attachments, the full ticket lifecycle and history, SLA calculation, assignment + notifications, search/filter/sort/pagination/bulk, tasks, projects, leave approval rules, chat access, reports/CSV, audit log and the removal of accounting endpoints.

## Assigning to employees: accept → update → reassign
- Staff can assign a ticket to **any active user, including employees** (on creation, from the ticket page, or in bulk). The ticket keeps the same reference ID (`HW-T16ID24`) for its whole life.
- An employee sees tickets assigned to them (**Assigned to me**, **To accept**). Until they click **Accept ticket** they cannot start work; they can also **Decline** with a reason, which returns the ticket to the queue.
- After accepting, the employee uses **Update progress**: a note, a % complete and optionally a status move (Start work / Pending / Resolve). Every step lands in the ticket's **Updates** tab.
- Admin side: notification + dashboard "Employee responses", list tabs **Awaiting acceptance / Accepted / Declined**, an acceptance badge on every ticket, and the Updates tab.
- **Reassign** to another employee from the same page: same ticket ID, the new assignee has to accept, the previous assignee is notified and loses access, and the full trail stays in *Assignments* / *Updates*. Admin / HR assignees need no acceptance.
- Needs migration `021_ticket_acceptance.sql` (`npm run migrate`; applied automatically by the Docker entrypoint).

## Roles
| | Admin | HR | Employee |
|---|---|---|---|
| Tickets | all | HR-visible categories, tickets assigned to them/their teams, their own | their own only |
| Internal notes | ✔ | ✔ | never visible |
| Assign / escalate | ✔ | ✔ (escalate to admin) | – |
| People | manage users, roles, departments | directory (read) | – |
| Projects | create/edit/delete | read all | those they belong to |
| Configuration | ✔ | – | – |
| Activity log | everything | ticket/request/task/project activity | – |
| Requests & leave | approve any (not own) | approve employees' (not own, not admin/HR) | submit/cancel own |

All checks run on the server; the UI only chooses which screens to show.

## Ticket lifecycle
`New → Open → Assigned → In Progress → Pending → Resolved → Closed` (+ reopen, cancel). Transitions are validated in `tickets.routes.ts`; every change stores who/when/from/to. Requesters can cancel (before work starts), confirm-close or reopen a resolved ticket. Resolving needs resolution details. An information request moves a ticket to *Pending*; the requester's reply resumes it.

**SLA**: policies (Configuration → SLA policies) define first-response and resolution minutes per priority, optionally per category. Deadlines are stored on the ticket at creation (and recalculated on priority/category change); “overdue / breached / time remaining” are computed from real timestamps — nothing is fabricated. If no policy applies, the UI says so.

**Assignment rules**: each category can name a default person (→ *Assigned*) or team (→ *Open*); otherwise the ticket lands in the unassigned queue as *New* (safe fallback).

## Email
In-app notifications always work. Email is optional: set `SMTP_*` in the server environment (see `backend/.env.example`). Delivery results are logged in `email_log` and shown in Configuration → Email; failures never break a request. Credentials never reach the browser.

## Attachments
Stored on disk under `STORAGE_DIR` with random names, served only through `GET /tickets/attachments/:id` after a permission check (internal-note files are staff-only). Max 5 files × 10 MB; executables/scripts/HTML/SVG are refused. In Docker the folder is a named volume.

## Database
Migrations `016_helpdesk.sql` and `017_unique_category_names.sql` are **additive**. The old accounting tables (invoices, quotations, customers …) are **kept untouched** so no data is lost; nothing in the app reads them. If you are sure you no longer need them, drop them manually after taking a backup. Legacy roles (sales_person, accountant, manager, viewer) are treated as *employee*.

## Chat
Direct messages (any two people), the company `#general` channel, and group chats (created by HR/admin). Messages are stored in PostgreSQL and delivered by short polling (3 s open conversation, 5–8 s unread badge) — no extra infrastructure required.

## Known limitations
- SLA clocks use calendar time (no business-hours calendar, no pause while *Pending*).
- Saved filters and drag-and-drop on the board are not implemented (use filters / the ticket page).
- Notification toggles in Configuration are stored but every event type is always generated; per-user in-app/email preferences are enforced.
- “Clients” (external requesters) from the sketch are not included — requesters are employees.
- Rate limiting is in-memory (single instance).
- Chat is polling-based, not WebSocket push; no file sharing in chat.
