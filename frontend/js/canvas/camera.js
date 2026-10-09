// ============================================================
// canvas/camera.js — 视口相机：{x,y,scale}，屏幕坐标 ↔ 世界坐标
// ============================================================
import { store } from '../store.js';

export const camera = {
  get x() { return store.camera.x; },
  get y() { return store.camera.y; },
  get scale() { return store.camera.scale; },

  set(x, y, scale) {
    store.camera.x = x; store.camera.y = y;
    if (scale != null) store.camera.scale = Math.min(3, Math.max(0.15, scale));
  },

  /** 以鼠标屏幕位置为锚点缩放 */
  zoomAt(screenX, screenY, factor) {
    const s0 = store.camera.scale;
    const s1 = Math.min(3, Math.max(0.15, s0 * factor));
    if (s1 === s0) return;
    const wx = (screenX - store.camera.x) / s0;
    const wy = (screenY - store.camera.y) / s0;
    store.camera.x = screenX - wx * s1;
    store.camera.y = screenY - wy * s1;
    store.camera.scale = s1;
  },

  panBy(dx, dy) {
    store.camera.x += dx;
    store.camera.y += dy;
  },

  screenToWorld(sx, sy) {
    return { x: (sx - store.camera.x) / store.camera.scale, y: (sy - store.camera.y) / store.camera.scale };
  },
  worldToScreen(wx, wy) {
    return { x: wx * store.camera.scale + store.camera.x, y: wy * store.camera.scale + store.camera.y };
  },
};
