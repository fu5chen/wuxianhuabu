// ============================================================
// api/export.js — 分组打包下载
// POST /api/export/group  body: { groupName, files: [{ name, resourceId }] }
// 按 resourceId 从素材库取文件，打包为 zip 返回（附件下载）
// ============================================================
import fs from 'node:fs';
import { getAsset } from '../storage/assets.js';
import { createZip } from '../storage/zip.js';

function sanitizeName(s, fallback = '文件') {
  const cleaned = String(s || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || fallback;
}

export async function handleExportApi(ctx) {
  const { req, res, u, body, sendJson } = ctx;
  if (u.pathname !== '/api/export/group') return sendJson(res, 404, { error: 'not found' });
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });

  const list = Array.isArray(body?.files) ? body.files : [];
  if (!list.length) return sendJson(res, 400, { error: '没有可打包的文件' });

  const entries = [];
  const used = new Set();
  for (const f of list.slice(0, 200)) {
    let data = null;
    let suffix = '';
    if (typeof f?.data === 'string' && f.data.length) {
      // 前端已统一转好格式（图片 png / 视频 mp4/webm）的 base64 数据，直接用
      try { data = Buffer.from(f.data, 'base64'); } catch { continue; }
      if (!data.length) continue;
      const ext = sanitizeName(f?.ext, '').replace(/^\.+/, '').replace(/[\\/:*?"<>|]/g, '');
      suffix = ext ? `.${ext}` : '';
    } else if (f?.resourceId) {
      const meta = getAsset(f.resourceId);
      if (!meta) continue;
      try { data = fs.readFileSync(meta.file); } catch { continue; }
      suffix = meta.ext || '';
    }
    if (!data?.length) continue;
    const base = sanitizeName(f.name, '文件');
    let name = base + suffix;
    let i = 2;
    while (used.has(name)) name = `${base} (${i++})${suffix}`;
    used.add(name);
    entries.push({ name, data });
  }
  if (!entries.length) return sendJson(res, 400, { error: '分组内没有可下载的文件' });

  const groupName = sanitizeName(body?.groupName, '分组');
  const zip = createZip(entries);
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="group.zip"; filename*=UTF-8''${encodeURIComponent(groupName)}.zip`,
    'Content-Length': zip.length,
  });
  res.end(zip);
}
