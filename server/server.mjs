// ============================================================
// 无限画布（AI 节点式工作台）— 后端入口
// 零依赖 Node HTTP 服务：静态托管前端 + REST API + SSE 任务状态推送
// 运行: node server/server.mjs  (默认 http://localhost:3210)
// ============================================================
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

import { handleProjectApi } from './api/projects.js';
import { handleAssetApi } from './api/assets.js';
import { handleTaskApi } from './api/tasks.js';
import { handleVideoApi } from './api/videos.js';
import { handleExportApi } from './api/export.js';
import { handleArkAssetApi } from './api/arkAssets.js';
import { startTunnel, stopTunnel, tunnelStatus, guardRequest } from './tunnel/ngrok.js';
import { EventBus } from './scheduler/eventBus.js';
import { logger } from './logger.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, '../frontend');
const PORT = process.env.PORT ? Number(process.env.PORT) : 3210;

export const eventBus = new EventBus();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 80 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------- 静态文件 ----------
function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(FRONTEND_DIR, rel));
  if (!filePath.startsWith(FRONTEND_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not Found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// ---------- SSE ----------
const sseClients = new Set();
eventBus.onBroadcast((evt) => {
  const payload = `data: ${JSON.stringify(evt)}\n\n`;
  for (const client of sseClients) {
    try { client.res.write(payload); } catch { sseClients.delete(client); }
  }
});

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const p = u.pathname;

  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  try {
    // 隧道安全开关：经 ngrok 进来的公网请求必须携带令牌（?k= 或 x-tunnel-token），
    // 本机/局域网直连（无 X-Forwarded-For）不受影响
    if (guardRequest(req, u)) {
      sendJson(res, 403, { error: '隧道访问需要令牌（?k=<token>）' });
      return;
    }

    // SSE 事件流
    if (p === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(': connected\n\n');
      const client = { res };
      sseClients.add(client);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* noop */ } }, 25000);
      req.on('close', () => { clearInterval(ping); sseClients.delete(client); });
      return;
    }

    // REST API
    if (p.startsWith('/api/')) {
      const t0 = Date.now();
      res.on('finish', () => {
        if (p !== '/api/events') logger.info(`${req.method} ${p} -> ${res.statusCode} (${Date.now() - t0}ms)`);
      });

      // 日志查看 / 前端操作上报
      if (p === '/api/logs' && req.method === 'GET') {
        const kind = u.searchParams.get('type') === 'info' ? 'info' : 'operation';
        const lines = Math.min(1000, Number(u.searchParams.get('lines')) || 200);
        return sendJson(res, 200, { kind, lines: logger.tail(kind, lines) });
      }
      if (p === '/api/logs/client' && req.method === 'POST') {
        const raw = await readBody(req);
        let payload = {};
        try { payload = JSON.parse(raw.toString('utf-8') || '{}'); } catch { /* 忽略 */ }
        logger.op(`[前端] ${payload?.action || 'unknown'}`, typeof payload?.detail === 'string' ? payload.detail : JSON.stringify(payload?.detail ?? ''));
        return sendJson(res, 200, { ok: true });
      }

      const body = (req.method === 'POST' || req.method === 'PUT')
        ? JSON.parse((await readBody(req)).toString('utf-8') || '{}')
        : null;
      const ctx = { req, res, u, body, sendJson, eventBus };
      if (p.startsWith('/api/projects')) return await handleProjectApi(ctx);
      if (p.startsWith('/api/assets')) return await handleAssetApi(ctx, readBody);
      if (p.startsWith('/api/videos')) return await handleVideoApi(ctx);
      if (p.startsWith('/api/tasks') || p === '/api/user') return await handleTaskApi(ctx);
      if (p.startsWith('/api/export')) return await handleExportApi(ctx);
      if (p.startsWith('/api/ark-asset')) return await handleArkAssetApi(ctx);
      // 临时隧道（ngrok）安全开关：GET 状态 / POST 开启 / POST 关闭
      if (p === '/api/tunnel' && req.method === 'GET') return sendJson(res, 200, tunnelStatus());
      if (p === '/api/tunnel/start' && req.method === 'POST') {
        try { return sendJson(res, 200, { ok: true, ...await startTunnel() }); }
        catch (e) { return sendJson(res, 200, { ok: false, error: e.message }); }
      }
      if (p === '/api/tunnel/stop' && req.method === 'POST') return sendJson(res, 200, { ok: true, ...stopTunnel() });
      return sendJson(res, 404, { error: 'unknown api' });
    }

    return serveStatic(req, res, p);
  } catch (err) {
    console.error('[server] error:', err);
    if (!res.headersSent) sendJson(res, 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, () => {
  logger.info(`服务启动 http://localhost:${PORT}（日志目录 ${logger.LOG_DIR}）`);
  console.log(`\n  无限画布 AI 节点式工作台`);
  console.log(`  ➜  http://localhost:${PORT}\n`);
});

process.on('uncaughtException', (e) => logger.info(`未捕获异常: ${e.stack || e}`));
process.on('unhandledRejection', (e) => logger.info(`未处理的 Promise 拒绝: ${e?.stack || e}`));
