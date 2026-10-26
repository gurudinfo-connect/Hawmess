# Files and modules changed

## Removed (accounting / quotation / CRM)
Backend routes: invoices, quotations, credit notes, payments, customers, vendors, services, reports (accounting), crm (leads, follow-ups), reference, dashboard (old).
Backend libs: accounting, invoicePdf, quotationPdf, pdfFonts, whatsapp, sequence, scope; db: catalogue*, quoteItems, serviceMaster, emailTest; `assets/` (PDF fonts/partners), `verify.sh`, old tests.
Dependencies removed: `pdfkit`, `qrcode` (+ types). Frontend: every invoice / quotation / customer / vendor / service / lead / aging page, `quoteLines.ts`.

## Added / rewritten — backend (`backend/`)
- `migrations/016_helpdesk.sql`, `017_unique_category_names.sql`
- `src/routes/`: `tickets`, `config`, `projects`, `tasks`, `requests`, `dashboard`, `reports`, `chat`, `misc` (notifications, audit log, global search); `auth` (login/logout audit, throttling) and `users` (HR role, departments, directory/lookup, preferences) updated
- `src/lib/`: `access` (scoping), `sla`, `notify` (in-app + email), `storage` (attachments), `http`, `chat`, `reminders` (task deadline reminders); `auth` (role normalisation)
- `src/db/seed.ts` (helpdesk seed), `src/db/pool.ts` (DATE parsing), `src/index.ts`
- `tests/helpdesk.test.ts` (15 integration tests)
- `.env.example` (placeholders only), `Dockerfile`, `docker-compose.yml`, `frontend/nginx.conf`

## Rewritten — frontend (`frontend/src/`)
`styles.css` (logo palette, light/dark), `ui.tsx`, `components.tsx`, `Shell.tsx` (top nav per sketch), `App.tsx` (role-guarded routes), `api.ts`, pages: Login, Dashboard (3 roles), Tickets (board + list), TicketDetail, People, Projects, Reports, Todos (tasks + requests/leave), Configuration (11 tabs), ActivityLog, Notifications, Profile, Chat.

## Logo + compact navbar
- `frontend/public/`: `hawmess-logo.png` (with tagline, login page), `hawmess-logo-nav.png` (no tagline, top bar), `hawmess-mark.png`, `favicon.png` regenerated from the new "Hawmess – All Your Tickets, In One Place" logo.
- `frontend/src/styles.css`: navbar height 78px → 54px (52px tablet, 48px phone), nav logo 62px → 40px, slimmer search box/icon buttons; sticky sidebar offset adjusted.

## Ticket acceptance, progress updates and reassignment
- `backend/migrations/021_ticket_acceptance.sql` — `tickets.acceptance / accepted_at / acceptance_note / progress`, new `ticket_updates` table.
- `backend/src/routes/tickets.routes.ts` — employees can be assignees; `POST /tickets/:id/accept`, `/decline`, `/updates`; reassignment resets acceptance, keeps the same ticket ID; new list views `awaiting_acceptance / accepted / declined`; new counts; employee assignees can only work a ticket after accepting.
- `backend/src/lib/access.ts` — employees can open tickets assigned to them.
- `backend/src/routes/dashboard.routes.ts` — acceptance KPIs, "Employee responses" feed, employee "to accept" list.
- `frontend/src/pages/TicketDetail.tsx`, `Tickets.tsx`, `Dashboard.tsx`, `styles.css` — Accept/Decline banner, Update-progress modal, Updates tab, acceptance badges, new tabs and dashboard cards.
- `backend/tests/helpdesk.test.ts` — new integration test (17 tests total, all passing).
- Ticket IDs now HW-T##ID## (migration 022_ticket_ref_ids.sql; DB-generated, retried on clash; existing tickets back-filled)


## Logo update (Glossy Neon Barid-IN)
- `frontend/public/`: `barid-logo.png`, `barid-logo-nav.png`, `barid-mark.png` and `favicon.png` regenerated from the new glossy neon Barid-IN logo (transparent background, cropped to content). No code changes needed — `Logo.tsx`, `Shell.tsx` and `Login.tsx` already reference these files.


## Employees can reassign too
- `backend/src/routes/tickets.routes.ts` — `assignTicket` now also accepts a call from the employee a ticket is assigned to, once they have **accepted** it: person only (no team change, no "unassigned"), a reason is required, same ticket ID, new assignee must accept, requester + admins + previous assignee are notified, and the employee loses access afterwards. New `GET /tickets/:id/reassign-targets` (active colleagues, excluding yourself) and `actions.can_reassign` on the ticket detail.
- `frontend/src/pages/TicketDetail.tsx` — the **Reassign** button now shows for the accepted assignee; the modal is simplified for employees (colleague picker + required reason) and returns them to the ticket list afterwards.
- `backend/tests/helpdesk.test.ts` — new checks inside the "assignment to employees" test.

## Fix: applying for leave
- `backend/src/routes/requests.routes.ts` — the leave form sends an empty title, which became `null` and failed validation (`title: Expected string, received null`). `title` now accepts null; the server fills in "<Type> leave". Regression check added in `tests/helpdesk.test.ts`.
