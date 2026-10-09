// ============================================================
// api/assets.js — 素材上传 / 列表 / 读取 / 删除
// 本地上传：前端以 multipart-free 方式 POST base64 JSON（简化实现）
// ============================================================
import { createAsset, getAsset, assetUrl, deleteAsset, listAssets } from '../storage/assets.js';
import { logger } from '../logger.mjs';
import fs from 'node:fs';

export async function handleAssetApi(ctx, readBody) {
  const { req, res, u, sendJson } = ctx;
  const parts = u.pathname.split('/').filter(Boolean); // ['api','assets', id(.ext)?]
  // id 可带扩展名后缀（/api/assets/<id>.svg），便于前端按扩展名识别类型
  const id = parts[2] ? parts[2].replace(/\.(png|jpe?g|gif|webp|svg|mp4|webm|mov|mp3|wav|json|bin)$/i, '') : parts[2];

  if (req.method === 'GET' && !id) return sendJson(res, 200, { assets: listAssets() });

  if (req.method === 'POST' && !id) {
    // 支持 JSON base64 上传（注意：请求体已在 server.mjs 中读取并解析为 ctx.body，不可重复读取流）
    const body = ctx.body || {};
    const buf = Buffer.from(body.dataBase64 || '', 'base64');
    if (!buf.length) return sendJson(res, 400, { error: '空文件' });
    const ext = extOf(body.name || body.mime || '');
    const meta = createAsset({ name: body.name, ext, data: buf });
    logger.op('上传素材', `${meta.name} (${meta.mime}, ${(meta.size / 1024).toFixed(1)}KB)`);
    return sendJson(res, 200, { id: meta.id, resourceId: meta.id, url: assetUrl(meta.id, meta.ext), name: meta.name, mime: meta.mime, size: meta.size });
  }

  if (id && (req.method === 'GET' || req.method === 'HEAD')) {
    const meta = getAsset(id);
    if (!meta || !fs.existsSync(meta.file)) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': meta.mime, 'Cache-Control': 'public, max-age=31536000, immutable', 'Access-Control-Allow-Origin': '*' });
    if (req.method === 'HEAD') { res.end(); return; } // HEAD 只探类型，不传体（前端旧数据类型探测用）
    fs.createReadStream(meta.file).pipe(res);
    return;
  }

  if (id && req.method === 'DELETE') return sendJson(res, 200, { ok: deleteAsset(id) });

  return sendJson(res, 404, { error: 'not found' });
}

function extOf(nameOrMime) {
  const m = String(nameOrMime).match(/\.(png|jpe?g|gif|webp|svg|mp4|webm|mp3|wav)$/i);
  if (m) return '.' + m[1].toLowerCase();
  if (/png/i.test(nameOrMime)) return '.png';
  if (/jpe?g/i.test(nameOrMime)) return '.jpg';
  if (/webp/i.test(nameOrMime)) return '.webp';
  if (/svg/i.test(nameOrMime)) return '.svg';
  if (/mp4/i.test(nameOrMime)) return '.mp4';
  if (/wav/i.test(nameOrMime)) return '.wav';
  return '.bin';
}
