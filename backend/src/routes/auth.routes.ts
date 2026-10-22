import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../db/pool';
import { signToken, requireAuth, logAudit, normRole } from '../lib/auth';
import { z } from 'zod';

const router = Router();
export const HOME: Record<string, string> = { admin: '/admin/dashboard', hr: '/hr/dashboard', employee: '/employee/dashboard' };
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

// brute-force guard: 10 attempts / minute / IP+email (in-memory; use a shared store behind several instances)
const attempts = new Map<string, { n: number; reset: number }>();
function throttled(key: string) { const now = Date.now(); const e = attempts.get(key); if (!e || now > e.reset) { attempts.set(key, { n: 1, reset: now + 60_000 }); return false; } e.n++; return e.n > 10; }

router.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Enter a valid email and password' });
  const email = parsed.data.email.toLowerCase(); const { password } = parsed.data;
  if (throttled(`${req.ip}|${email}`)) return res.status(429).json({ error: 'Too many sign-in attempts. Wait a minute and try again.' });
  const users = await query<any>(`SELECT id, name, email, password_hash, is_active, theme FROM users WHERE lower(email)=$1`, [email]);
  const user = users[0];
  const match = user ? await bcrypt.compare(password, user.password_hash) : false;
  if (!user || !match) {
    if (user) { const c = (await query<any>(`SELECT company_id FROM company_users WHERE user_id=$1 LIMIT 1`, [user.id]))[0]; if (c) await logAudit({ company_id: c.company_id, user_id: user.id, action: 'login_failed', entity_type: 'user', entity_id: user.id, module: 'auth', description: `Failed sign-in for ${user.email}` }); }
    return res.status(401).json({ error: 'Incorrect email or password' });
  }
  if (!user.is_active) return res.status(403).json({ error: 'This account is deactivated. Contact your administrator.' });
  const cu = (await query<any>(`SELECT cu.company_id, r.name AS role, r.permissions, c.name AS company_name FROM company_users cu JOIN roles r ON r.id=cu.role_id JOIN companies c ON c.id=cu.company_id WHERE cu.user_id=$1 LIMIT 1`, [user.id]))[0];
  if (!cu) return res.status(403).json({ error: 'This user is not assigned to a company' });
  const role = normRole(cu.role);
  const token = signToken({ id: user.id, email: user.email, name: user.name, company_id: cu.company_id, role, permissions: cu.permissions });
  await query(`UPDATE users SET last_login_at=now() WHERE id=$1`, [user.id]);
  await logAudit({ company_id: cu.company_id, user_id: user.id, action: 'login', entity_type: 'user', entity_id: user.id, module: 'auth', description: `${user.name} signed in` });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role, home: HOME[role], company: cu.company_name, company_id: cu.company_id, theme: user.theme } });
});

router.post('/logout', requireAuth, async (req, res) => {
  await logAudit({ company_id: req.user!.company_id, user_id: req.user!.id, action: 'logout', entity_type: 'user', entity_id: req.user!.id, module: 'auth', description: `${req.user!.name} signed out` });
  res.json({ ok: true });
});
export default router;
