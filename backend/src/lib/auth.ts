import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';
import { query } from '../db/pool';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  company_id: string;
  role: 'admin' | 'hr' | 'employee';   // legacy role names from the old accounting app are treated as employee
  permissions: string[];
}

export const normRole = (r: string): 'admin' | 'hr' | 'employee' => (r === 'admin' ? 'admin' : r === 'hr' ? 'hr' : 'employee');

export function signToken(payload: AuthUser): string {
  // The token only identifies the user; role/permissions/active state are re-read from the database on every request,
  // so a role change or deactivation takes effect immediately.
  return jwt.sign({ id: payload.id }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN as any });
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

// request context (client IP) so logAudit can record it without every caller passing it
const ctx = new AsyncLocalStorage<{ ip?: string }>();
export function requestContext(req: Request, _res: Response, next: NextFunction) { ctx.run({ ip: req.ip }, next); }

/** Resolves a bearer token to the CURRENT user record (role / active state are always re-read from the database). Shared by the REST middleware and the Socket.IO handshake. */
export async function authenticateToken(token: string): Promise<{ user: AuthUser; exp?: number } | { error: string; status: 401 | 403 }> {
  let decoded: any;
  try { decoded = jwt.verify(token, JWT_SECRET); } catch { return { error: 'Invalid or expired token', status: 401 }; }
  const rows = await query<any>(
    `SELECT u.id, u.email, u.name, u.is_active, cu.company_id, r.name AS role, r.permissions
     FROM users u JOIN company_users cu ON cu.user_id = u.id JOIN roles r ON r.id = cu.role_id
     WHERE u.id = $1 LIMIT 1`, [decoded.id]);
  if (rows.length === 0) return { error: 'Invalid or expired token', status: 401 };
  if (!rows[0].is_active) return { error: 'Account is deactivated', status: 403 };
  return { exp: typeof decoded.exp === 'number' ? decoded.exp : undefined, user: { id: rows[0].id, email: rows[0].email, name: rows[0].name, company_id: rows[0].company_id, role: normRole(rows[0].role), permissions: rows[0].permissions } };
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    const r = await authenticateToken(header.slice(7));
    if ('error' in r) return res.status(r.status).json({ error: r.error });
    req.user = r.user;
    next();
  } catch (e) { next(e); }
}

/** Permission-based RBAC. Enforced server-side — never trust the frontend. */
export function requirePermission(...perms: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const has = perms.some(p => req.user!.permissions.includes(p) || req.user!.permissions.includes('*'));
    if (!has) {
      return res.status(403).json({ error: `Forbidden: requires permission [${perms.join(' or ')}]` });
    }
    next();
  };
}

/** Role gate, e.g. requireRole('admin') for user management. */
export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: `Forbidden: requires role ${roles.join(' or ')}` });
    next();
  };
}

export async function logAudit(params: {
  company_id: string;
  user_id?: string | null;
  action: string;
  entity_type: string;
  entity_id?: string | null;
  old_value?: any;
  new_value?: any;
  ip_address?: string | null;
  description?: string;
  module?: string;
}) {
  let role: string | null = null;
  if (params.user_id) {
    const r = await query<any>(`SELECT r.name FROM company_users cu JOIN roles r ON r.id=cu.role_id WHERE cu.user_id=$1 AND cu.company_id=$2`, [params.user_id, params.company_id]);
    role = r[0]?.name || null;
  }
  const label = (s: string) => s.replace(/_/g, ' ');
  await query(
    `INSERT INTO audit_logs (company_id, user_id, action, entity_type, entity_id, old_value, new_value, ip_address, role, module, description)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      params.company_id,
      params.user_id || null,
      params.action,
      params.entity_type,
      params.entity_id || null,
      params.old_value ? JSON.stringify(params.old_value) : null,
      params.new_value ? JSON.stringify(params.new_value) : null,
      params.ip_address || ctx.getStore()?.ip || null,
      role,
      params.module || params.entity_type,
      params.description || `${role ? label(role) : 'user'} ${label(params.action)} ${label(params.entity_type)}`,
    ]
  );
}
