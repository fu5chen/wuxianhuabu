// ============================================================
// canvas/minimap.js — 小地图预览 + 点击定位
// ============================================================
import { store } from '../store.js';
import { camera } from './camera.js';

let cv, ctx;
const W = 150, H = 100;

export function initMinimap() {
  cv = document.getElementById('minimapCanvas');
  ctx = cv.getContext('2d');
  cv.addEventListener('pointerdown', (e) => {
    const rect = cv.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const b = worldBounds();
    if (!b) return;
    const wx = b.minX + (mx / W) * b.w;
    const wy = b.minY + (my / H) * b.h;
    const vw = window.innerWidth / camera.scale, vh = window.innerHeight / camera.scale;
    camera.set(wx * camera.scale - window.innerWidth / 2, wy * camera.scale - window.innerHeight / 2);
    store.emit({ type: 'render' });
  });
}

export function renderMinimap() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#141414';
  ctx.fillRect(0, 0, W, H);

  const nodes = [...store.nodes.values()];
  if (!nodes.length) return;

  const pad = 60;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.position.x); minY = Math.min(minY, n.position.y);
    maxX = Math.max(maxX, n.position.x + n.width); maxY = Math.max(maxY, n.position.y + 360);
  }
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  const bw = maxX - minX, bh = maxY - minY;
  const s = Math.min(W / bw, H / bh);
  const ox = (W - bw * s) / 2, oy = (H - bh * s) / 2;

  for (const n of nodes) {
    const sel = store.selection.has(n.id);
    ctx.fillStyle = sel ? '#4da3ff' : (n.status === 'success' ? '#4cd47c' : '#555');
    ctx.fillRect(ox + (n.position.x - minX) * s, oy + (n.position.y - minY) * s, Math.max(4, n.width * s), Math.max(3, 320 * s));
  }

  // 视口框
  const vx = (-store.camera.x / store.camera.scale - minX) * s + ox;
  const vy = (-store.camera.y / store.camera.scale - minY) * s + oy;
  const vw = (window.innerWidth / store.camera.scale) * s;
  const vh = (window.innerHeight / store.camera.scale) * s;
  ctx.strokeStyle = 'rgba(255,255,255,.6)';
  ctx.strokeRect(vx, vy, vw, vh);
}

function worldBounds() {
  const nodes = [...store.nodes.values()];
  if (!nodes.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.position.x); minY = Math.min(minY, n.position.y);
    maxX = Math.max(maxX, n.position.x + n.width); maxY = Math.max(maxY, n.position.y + 360);
  }
  return { minX, minY, w: maxX - minX, h: maxY - minY };
}
