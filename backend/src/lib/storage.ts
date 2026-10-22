import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';

/** Attachments live OUTSIDE the web root and are only streamed through an authenticated, permission-checked endpoint. */
export const STORAGE_DIR = path.resolve(process.env.STORAGE_DIR || './storage');
const TICKET_DIR = path.join(STORAGE_DIR, 'tickets');
fs.mkdirSync(TICKET_DIR, { recursive: true });

const BLOCKED = /\.(exe|bat|cmd|com|scr|msi|sh|js|jar|vbs|ps1|php|html?|svg)$/i;
export const upload = multer({
  storage: multer.diskStorage({
    destination: (_r, _f, cb) => cb(null, TICKET_DIR),
    filename: (_r, _f, cb) => cb(null, crypto.randomUUID()),   // original name is never used on disk
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 5 },
  fileFilter: (_r, file, cb) => BLOCKED.test(file.originalname) ? cb(new Error('This file type is not allowed')) : cb(null, true),
});
export const filePath = (key: string) => path.join(TICKET_DIR, path.basename(key));
export const removeFile = (key: string) => fs.promises.unlink(filePath(key)).catch(() => {});
