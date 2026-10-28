import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// ws: true lets the call-signalling WebSocket (/api/v1/realtime) through the dev / preview proxy
const proxy = { '/api': { target: process.env.API_PROXY || 'http://localhost:4000', ws: true } };
export default defineConfig({ plugins: [react()], server: { port: 3100, proxy }, preview: { port: 3100, proxy } });
