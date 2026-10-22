import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool';
import { requireAuth, logAudit } from '../lib/auth';
import { isAdmin, isStaff, UUID_RE } from '../lib/access';
import { bad, forbidden, notFound, pageParams, parse } from '../lib/http';

/** Knowledge base. Everyone reads published articles; admin/HR write them (drafts are visible to staff only). */
const router = Router();
router.use(requireAuth);

const schema = z.object({
  title: z.string().trim().min(3).max(200), summary: z.string().trim().max(500).optional().nullable(),
  body: z.string().trim().min(3).max(50000), category: z.string().trim().min(1).max(80).default('General'), is_published: z.boolean().default(true),
});

router.get('/', async (req, res) => {
  const u = req.user!; const params: any[] = [u.company_id]; const conds = ['a.company_id=$1'];
  if (!isStaff(u)) conds.push('a.is_published');
  const cat = String(req.query.category || ''); if (cat) { params.push(cat); conds.push(`a.category=$${params.length}`); }
  const s = String(req.query.search || '').trim(); if (s) { params.push(`%${s}%`); const n = `$${params.length}`; conds.push(`(a.title ILIKE ${n} OR a.summary ILIKE ${n} OR a.body ILIKE ${n})`); }
  const { page, pageSize, offset } = pageParams(req.query); const where = conds.join(' AND ');
  const total = (await query<any>(`SELECT COUNT(*)::int n FROM knowledge_articles a WHERE ${where}`, params))[0].n;
  const data = await query(`SELECT a.id, a.title, a.summary, a.category, a.is_published, a.views, a.created_at, a.updated_at, u.name AS author_name
    FROM knowledge_articles a LEFT JOIN users u ON u.id=a.author_id WHERE ${where} ORDER BY a.updated_at DESC LIMIT ${pageSize} OFFSET ${offset}`, params);
  const categories = await query(`SELECT category AS name, COUNT(*)::int AS n FROM knowledge_articles a WHERE a.company_id=$1 ${isStaff(u) ? '' : 'AND a.is_published'} GROUP BY category ORDER BY category`, [u.company_id]);
  res.json({ data, total, page, pageSize, categories });
});

router.get('/:id', async (req, res) => {
  const u = req.user!; if (!UUID_RE.test(req.params.id)) throw notFound();
  const a = (await query<any>(`SELECT a.*, u.name AS author_name FROM knowledge_articles a LEFT JOIN users u ON u.id=a.author_id WHERE a.id=$1 AND a.company_id=$2`, [req.params.id, u.company_id]))[0];
  if (!a || (!a.is_published && !isStaff(u))) throw notFound('Article not found');
  await query(`UPDATE knowledge_articles SET views=views+1 WHERE id=$1`, [a.id]); a.views += 1;
  res.json(a);
});

router.post('/', async (req, res) => {
  const u = req.user!; if (!isStaff(u)) throw forbidden('Only staff can write articles'); const d = parse(schema, req.body);
  const a = (await query<any>(`INSERT INTO knowledge_articles (company_id, title, summary, body, category, author_id, is_published) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [u.company_id, d.title, d.summary || null, d.body, d.category, u.id, d.is_published]))[0];
  await logAudit({ company_id: u.company_id, user_id: u.id, action: 'create', entity_type: 'knowledge', entity_id: a.id, module: 'knowledge', description: `${u.name} created knowledge article "${a.title}"` });
  res.status(201).json(a);
});

router.put('/:id', async (req, res) => {
  const u = req.user!; if (!isStaff(u)) throw forbidden('Only staff can edit articles'); if (!UUID_RE.test(req.params.id)) throw notFound(); const d = parse(schema, req.body);
  const a = (await query<any>(`UPDATE knowledge_articles SET title=$3, summary=$4, body=$5, category=$6, is_published=$7, updated_at=now() WHERE id=$1 AND company_id=$2 RETURNING *`,
    [req.params.id, u.company_id, d.title, d.summary || null, d.body, d.category, d.is_published]))[0];
  if (!a) throw notFound('Article not found');
  await logAudit({ company_id: u.company_id, user_id: u.id, action: 'update', entity_type: 'knowledge', entity_id: a.id, module: 'knowledge', description: `${u.name} updated knowledge article "${a.title}"` });
  res.json(a);
});

router.delete('/:id', async (req, res) => {
  const u = req.user!; if (!isAdmin(u)) throw forbidden('Only admins can delete articles'); if (!UUID_RE.test(req.params.id)) throw notFound();
  const a = (await query<any>(`DELETE FROM knowledge_articles WHERE id=$1 AND company_id=$2 RETURNING title`, [req.params.id, u.company_id]))[0]; if (!a) throw notFound('Article not found');
  await logAudit({ company_id: u.company_id, user_id: u.id, action: 'delete', entity_type: 'knowledge', entity_id: req.params.id, module: 'knowledge', description: `${u.name} deleted knowledge article "${a.title}"` });
  res.json({ ok: true });
});

export default router;
