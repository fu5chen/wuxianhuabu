// ============================================================
// storage/videos.js — 生成视频专用存储（对应项目下的视频文件夹）
// 文件落盘 server/data/videos/<时间戳>_<taskId>.<ext>，
// 清单持久化到 manifest.json，用于专门的视频管理。
// 同时注册进素材库（assets metaMap），方便画布直接引用/下载。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerExternalAsset, deleteAsset, deleteHooks } from './assets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIDEO_DIR = path.join(__dirname, '../data/videos');
const MANIFEST = path.join(VIDEO_DIR, 'manifest.json');
fs.mkdirSync(VIDEO_DIR, { recursive: true });

const MIME = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' };

/** 视频清单（进程内索引 + 落盘；生产环境应放数据库） */
let manifest = [];
try { manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf-8')); } catch { manifest = []; }

// 服务重启后：把已有视频重新注册回素材库索引（否则 /api/assets/<id> 失效）
for (const entry of manifest) {
  if (entry.file && fs.existsSync(entry.file)) {
    const am = registerExternalAsset({ id: entry.assetId || entry.id, file: entry.file, mime: entry.mime, name: `${entry.name}${path.extname(entry.file)}` });
    entry.assetId = am.id;
    entry.assetUrl = `/api/assets/${am.id}${am.ext || ".mp4"}`;
  }
}

function persist() {
  try { fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2)); } catch { /* noop */ }
}

/**
 * 保存一段生成完成的视频
 * @param {{taskId:string, buffer:Buffer, ext?:string, meta?:object}} p
 * @returns {{id, taskId, name, url, file, size, createdAt}}
 */
export function saveVideo({ taskId, buffer, ext = '.mp4', meta = {} }) {
  const id = `v_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const fileName = `${Date.now()}_${taskId}${ext}`;
  const file = path.join(VIDEO_DIR, fileName);
  fs.writeFileSync(file, buffer);
  const entry = {
    id, taskId,
    name: meta.name || taskId,
    model: meta.model || '',
    taskType: meta.taskType || '',
    duration: meta.duration ?? null,
    nodeId: meta.nodeId || '',
    fileName,
    file,
    url: `/api/videos/file/${fileName}`,
    mime: MIME[ext] || 'video/mp4',
    size: buffer.length,
    createdAt: Date.now(),
  };
  manifest.unshift(entry);
  persist();
  // 同步注册到素材库，画布/下载/资产库直接可用
  const asset = registerExternalAsset({ id, file, mime: entry.mime, name: `${entry.name}${ext}` });
  entry.assetId = asset.id;
  entry.assetUrl = `/api/assets/${asset.id}${asset.ext || ".mp4"}`;
  persist();
  return entry;
}

export function listVideos() {
  return manifest.map(({ file, ...rest }) => rest);
}

export function getVideo(id) {
  return manifest.find((v) => v.id === id || v.taskId === id) || null;
}

export function resolveVideoFile(fileName) {
  const full = path.resolve(VIDEO_DIR, path.basename(fileName));
  if (!full.startsWith(path.resolve(VIDEO_DIR))) return null;
  return fs.existsSync(full) ? full : null;
}

/** 删除视频：删文件 + 清清单 + 清素材库 */
export function deleteVideo(id) {
  const idx = manifest.findIndex((v) => v.id === id || v.taskId === id);
  if (idx < 0) return false;
  const entry = manifest[idx];
  manifest.splice(idx, 1);
  persist();
  deleteAsset(entry.assetId || id); // 触发文件删除 + 素材库清理
  return true;
}

// 素材库删除时同步清理视频清单（避免孤儿记录）
deleteHooks.add((assetId) => {
  const idx = manifest.findIndex((v) => v.assetId === assetId);
  if (idx >= 0) { manifest.splice(idx, 1); persist(); }
});
