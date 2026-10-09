// ============================================================
// api/videos.js — 视频文件夹管理接口
//   GET    /api/videos            视频清单（专门的视频管理）
//   GET    /api/videos/file/<名>  视频文件流（mp4/mov/webm）
//   DELETE /api/videos/<id>       删除视频（文件+清单+素材库同步清理）
// ============================================================
import fs from 'node:fs';
import { listVideos, deleteVideo, resolveVideoFile } from '../storage/videos.js';

const MIME = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' };

export async function handleVideoApi({ req, res, u, sendJson }) {
  const p = u.pathname;

  if (p === '/api/videos' && req.method === 'GET') {
    return sendJson(res, 200, { videos: listVideos() });
  }

  const fileMatch = p.match(/^\/api\/videos\/file\/(.+)$/);
  if (fileMatch && req.method === 'GET') {
    const full = resolveVideoFile(decodeURIComponent(fileMatch[1]));
    if (!full) return sendJson(res, 404, { error: 'video not found' });
    const ext = full.slice(full.lastIndexOf('.'));
    const stat = fs.statSync(full);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'video/mp4',
      'Content-Length': stat.size,
      'Accept-Ranges': 'none',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(full).pipe(res);
    return;
  }

  const delMatch = p.match(/^\/api\/videos\/([^/]+)$/);
  if (delMatch && req.method === 'DELETE') {
    const ok = deleteVideo(decodeURIComponent(delMatch[1]));
    return sendJson(res, ok ? 200 : 404, { ok });
  }

  return sendJson(res, 404, { error: 'not found' });
}
