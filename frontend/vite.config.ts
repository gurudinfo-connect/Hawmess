import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
const proxy = { '/api': process.env.API_PROXY || 'http://localhost:4000' };
export default defineConfig({ plugins: [react()], server: { port: 3100, proxy }, preview: { port: 3100, proxy } });
