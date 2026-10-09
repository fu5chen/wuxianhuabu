// ============================================================
// storage/assets.js — 素材资产存储（对应对象存储封装，本地磁盘模拟 OSS）
// 文件落盘 server/data/assets/<id>.<ext>，元数据内存索引
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = path.join(__dirname, '../data/assets');
fs.mkdirSync(ASSET_DIR, { recursive: true });

/** resourceId -> meta（进程内索引；生产环境应放数据库） */
const metaMap = new Map();

/* ---------- 持久化扩展元数据（sourceUrl / arkAssetId 等，重启不丢） ---------- */
const META_FILE = path.join(__dirname, '../data/asset-meta.json');
let metaOverlay = {};
try { metaOverlay = JSON.parse(fs.readFileSync(META_FILE, 'utf8')); } catch { /* 首次无文件 */ }
function persistOverlay() {
  try { fs.writeFileSync(META_FILE, JSON.stringify(metaOverlay, null, 2)); } catch { /* 忽略写失败 */ }
}
/** 给素材追加/更新扩展字段（与磁盘索引合并，重启后仍在） */
export function updateAssetMeta(id, patch) {
  const m = metaMap.get(id);
  if (!m) return null;
  Object.assign(m, patch);
  metaOverlay[id] = { ...(metaOverlay[id] || {}), ...patch };
  persistOverlay();
  return m;
}

const EXT_MIME = {
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.webm': 'video/webm', '.mp4': 'video/mp4',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.json': 'application/json',
};

// 启动时扫描已有文件重建索引
for (const f of fs.readdirSync(ASSET_DIR)) {
  const full = path.join(ASSET_DIR, f);
  const ext = path.extname(f);
  const id = path.basename(f, ext);
  metaMap.set(id, {
    id,
    file: full,
    ext,
    mime: EXT_MIME[ext] || 'application/octet-stream',
    name: f,
    size: fs.statSync(full).size,
    createdAt: fs.statSync(full).mtimeMs,
    ...(metaOverlay[id] || {}),
  });
}

export function createAsset({ name, ext, data }) {
  const id = crypto.randomUUID();
  const e = ext.startsWith('.') ? ext : '.' + ext;
  const file = path.join(ASSET_DIR, id + e);
  fs.writeFileSync(file, data);
  const meta = {
    id, file, ext: e,
    mime: EXT_MIME[e] || 'application/octet-stream',
    name: name || id + e,
    size: data.length,
    createdAt: Date.now(),
  };
  metaMap.set(id, meta);
  return meta;
}

export function getAsset(id) {
  return metaMap.get(id) || null;
}

/** 注册一个外部文件为素材（文件已在磁盘其他位置，如生成视频文件夹） */
export function registerExternalAsset({ id, file, mime, name }) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { /* noop */ }
  const meta = {
    id, file, ext: path.extname(file), mime: mime || 'application/octet-stream',
    name: name || path.basename(file), size, createdAt: Date.now(),
  };
  metaMap.set(id, meta);
  return meta;
}

/** 素材被删除时的联动钩子（如视频清单同步清理） */
export const deleteHooks = new Set();

export function deleteAsset(id) {
  const meta = metaMap.get(id);
  if (!meta) return false;
  try { fs.unlinkSync(meta.file); } catch { /* noop */ }
  metaMap.delete(id);
  for (const hook of deleteHooks) { try { hook(id); } catch { /* noop */ } }
  return true;
}

export function assetUrl(id, ext = '') {
  return `/api/assets/${id}${ext}`;
}

export function listAssets() {
  return [...metaMap.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((m) => ({ id: m.id, name: m.name, mime: m.mime, size: m.size, url: assetUrl(m.id, m.ext), createdAt: m.createdAt }));
}
