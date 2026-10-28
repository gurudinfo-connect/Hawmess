import 'express-async-errors';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import http from 'node:http';
import dotenv from 'dotenv';
dotenv.config();

import authRoutes from './routes/auth.routes';
import usersRoutes from './routes/users.routes';
import ticketsRoutes from './routes/tickets.routes';
import configRoutes from './routes/config.routes';
import projectsRoutes from './routes/projects.routes';
import tasksRoutes from './routes/tasks.routes';
import requestsRoutes from './routes/requests.routes';
import dashboardRoutes from './routes/dashboard.routes';
import reportsRoutes from './routes/reports.routes';
import chatRoutes from './routes/chat.routes';
import callsRoutes from './routes/calls.routes';
import knowledgeRoutes from './routes/knowledge.routes';
import meetingsRoutes from './routes/meetings.routes';
import miscRoutes from './routes/misc.routes';
import { requestContext } from './lib/auth';
import { HttpError } from './lib/http';
import { startReminders } from './lib/reminders';
import { attachCalls } from './lib/callSocket';

if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)) {
  console.error('Refusing to start: set JWT_SECRET to a random string of at least 32 characters.'); process.exit(1);
}

const app = express();
app.use(helmet());
const allowedOrigins = [
  "https://hawmess-frontend.onrender.com",
];

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));
app.set('trust proxy', 1);
app.use(requestContext);

// Basic per-IP rate limit (in-memory — use a shared store if you run several API instances)
const hits = new Map<string, { count: number; reset: number }>();
app.use((req, res, next) => {
  const key = req.ip || 'unknown'; const now = Date.now(); const e = hits.get(key);
  if (!e || now > e.reset) hits.set(key, { count: 1, reset: now + 60_000 });
  else if (++e.count > 600) return res.status(429).json({ error: 'Too many requests' });
  next();
});

app.get('/api/v1/health', (_req, res) => res.json({ ok: true, service: 'Barid-IN API' }));
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/users', usersRoutes);
app.use('/api/v1/tickets', ticketsRoutes);
app.use('/api/v1/config', configRoutes);
app.use('/api/v1/projects', projectsRoutes);
app.use('/api/v1/tasks', tasksRoutes);
app.use('/api/v1/requests', requestsRoutes);
app.use('/api/v1/dashboard', dashboardRoutes);
app.use('/api/v1/reports', reportsRoutes);
app.use('/api/v1/chat', chatRoutes);
app.use('/api/v1/calls', callsRoutes);
app.use('/api/v1/knowledge', knowledgeRoutes);
app.use('/api/v1/meetings', meetingsRoutes);
app.use('/api/v1', miscRoutes);   // /notifications /audit-logs /search
app.use('/api/v1', (_req, res) => res.status(404).json({ error: 'Not found' }));

// Central error handler — never leaks stack traces
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err?.name === 'MulterError') return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Each file can be at most 10 MB' : err.message });
  if (err?.message === 'This file type is not allowed') return res.status(400).json({ error: err.message });
  if (err?.code === '22P02') return res.status(400).json({ error: 'Invalid identifier or value' });
  console.error(err); res.status(500).json({ error: 'Something went wrong on the server' });
});

const port = Number(process.env.PORT || 4000);
const server = http.createServer(app);
const calls = attachCalls(server, allowedOrigins);   // Socket.IO signalling for internal audio / video calls (same JWT auth, path /api/v1/realtime)
server.listen(port, () => { console.log(`Barid-IN API listening on port ${port}`); startReminders(); });

// Graceful shutdown: close open calls (so call history is accurate) before the process exits.
let stopping = false;
const stop = async () => { if (stopping) return; stopping = true; setTimeout(() => process.exit(0), 5000).unref(); try { await calls.close(); } catch (e) { console.error(e); } server.close(() => process.exit(0)); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
