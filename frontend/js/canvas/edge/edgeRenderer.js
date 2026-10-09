// ============================================================
// canvas/edge/edgeRenderer.js — 贝塞尔曲线连线渲染（SVG）
// 坐标随相机变换重算；悬停/删除走事件委托
// ============================================================
import { store } from '../../store.js';
import { camera } from '../camera.js';

let svg;

export function initEdges() {
  svg = document.getElementById('edgeLayer');
}

function portPos(node, side) {
  // 端口在节点卡片左右中点（世界坐标）
  const x = side === 'out' ? node.position.x + node.width : node.position.x;
  const y = node.position.y + 34 + 150; // 标题高 + 卡片中点（近似）
  return { x, y };
}

function bezierPath(x1, y1, x2, y2) {
  const dx = Math.max(40, Math.abs(x2 - x1) * 0.5);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

let lastSig = '';

export function renderEdges() {
  const scale = store.camera.scale;
  const camX = store.camera.x, camY = store.camera.y;
  const items = [];

  const portCache = new Map();
  const getPort = (nodeId, side) => {
    const key = nodeId + side;
    let p = portCache.get(key);
    if (!p) {
      const n = store.getNode(nodeId);
      p = n ? portPos(n, side) : { x: 0, y: 0 };
      portCache.set(key, p);
    }
    return p;
  };

  for (const e of store.edges.values()) {
    const a = getPort(e.source, 'out');
    const b = getPort(e.target, 'in');
    const x1 = a.x * scale + camX, y1 = a.y * scale + camY;
    const x2 = b.x * scale + camX, y2 = b.y * scale + camY;
    const d = bezierPath(x1, y1, x2, y2);
    // 选中节点 → 与之相连的连线高亮流动；有选中时的其余连线压暗为淡白
    const related = store.selection.has(e.source) || store.selection.has(e.target);
    const cls = related ? 'edge-path edge-active' : (store.selection.size ? 'edge-path edge-dim' : 'edge-path');
    items.push({ id: e.id, d, cls, flow: related });
  }

  // 结构（边的集合/分类）变化才重建 DOM，否则只更新坐标 —— 避免拖动/缩放时流动动画被重置
  const sig = items.map((i) => i.id + i.cls + (i.flow ? 'F' : '')).join('|');
  if (sig !== lastSig) {
    lastSig = sig;
    const parts = [];
    for (const i of items) {
      parts.push(`<path class="edge-hit" data-edge="${i.id}" d="${i.d}"/>`);
      parts.push(`<path class="${i.cls}" data-edge="${i.id}" d="${i.d}"/>`);
      if (i.flow) parts.push(`<path class="edge-flow" data-edge="${i.id}" d="${i.d}"/>`);
    }
    svg.innerHTML = parts.join('');
  } else {
    for (const i of items) {
      svg.querySelector(`.edge-hit[data-edge="${i.id}"]`)?.setAttribute('d', i.d);
      svg.querySelector(`.edge-path[data-edge="${i.id}"]`)?.setAttribute('d', i.d);
      if (i.flow) svg.querySelector(`.edge-flow[data-edge="${i.id}"]`)?.setAttribute('d', i.d);
    }
  }
}

/** 拖拽连线时的临时预览线 */
export function renderTempEdge(fromScreen, toScreen) {
  const id = '__temp__';
  let el = svg.querySelector(`[data-edge="${id}"]`);
  const d = bezierPath(fromScreen.x, fromScreen.y, toScreen.x, toScreen.y);
  if (!el) {
    el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    el.setAttribute('data-edge', id);
    el.setAttribute('class', 'edge-temp');
    svg.appendChild(el);
  }
  el.setAttribute('d', d);
}
export function clearTempEdge() {
  svg.querySelector(`[data-edge="__temp__"]`)?.remove();
}

/** 拖动对齐辅助线：guides = [{axis:'v'|'h', pos(world坐标)}]，传空清除；铺满当前视口 */
export function renderAlignGuides(guides) {
  svg.querySelectorAll('.align-guide').forEach((el) => el.remove());
  if (!guides || !guides.length) return;
  const { scale, x: camX, y: camY } = store.camera;
  const W = svg.clientWidth || svg.parentElement?.clientWidth || 0;
  const H = svg.clientHeight || svg.parentElement?.clientHeight || 0;
  for (const g of guides) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('class', 'align-guide');
    if (g.axis === 'v') {
      const x = g.pos * scale + camX;
      line.setAttribute('x1', x); line.setAttribute('x2', x);
      line.setAttribute('y1', 0); line.setAttribute('y2', H);
    } else {
      const y = g.pos * scale + camY;
      line.setAttribute('y1', y); line.setAttribute('y2', y);
      line.setAttribute('x1', 0); line.setAttribute('x2', W);
    }
    svg.appendChild(line);
  }
}
