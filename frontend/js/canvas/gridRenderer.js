// ============================================================
// canvas/gridRenderer.js — 点阵网格背景（Canvas 绘制，仅渲染视口内）
// ============================================================
import { store } from '../store.js';

let canvas, ctx;

export function initGrid() {
  canvas = document.getElementById('gridCanvas');
  ctx = canvas.getContext('2d');
  const resize = () => {
    canvas.width = canvas.clientWidth * devicePixelRatio;
    canvas.height = canvas.clientHeight * devicePixelRatio;
    drawGrid();
  };
  window.addEventListener('resize', resize);
  resize();
  return { drawGrid };
}

export function drawGrid() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const scale = store.camera.scale;
  const baseGap = 26;
  let gap = baseGap * scale;
  // 缩小到一定程度时网格稀疏化，保持视觉密度稳定
  while (gap < 14) gap *= 2;

  const startX = ((store.camera.x % gap) + gap) % gap;
  const startY = ((store.camera.y % gap) + gap) % gap;

  ctx.fillStyle = 'rgba(255,255,255,0.16)';
  const r = scale > 0.6 ? 1 : 0.7;
  for (let x = startX; x < w; x += gap) {
    for (let y = startY; y < h; y += gap) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
