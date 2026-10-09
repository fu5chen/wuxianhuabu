// ============================================================
// canvas/interaction.js — 画布交互总控
// 平移 / 缩放 / 节点拖拽 / 框选 / 双击菜单 / 端口连线 / 右键菜单 / 快捷键
// ============================================================
import { store } from '../store.js';
import { camera } from './camera.js';
import { renderTempEdge, clearTempEdge, renderAlignGuides } from './edge/edgeRenderer.js';
import { NODE_TYPES, validateEdgeTypes, validateVideoRefs } from '../nodes/nodeRegistry.js';
import { getNodeEl, handleCanvasPick, removeEl } from '../nodes/nodeDom.js';

const wrap = () => document.getElementById('canvasWrap');

let drag = null; // 当前拖拽状态
let activeTool = 'move'; // 'move' | 'hand'（V / H 切换）
let spaceHeld = false;   // Space 按住 + 拖动 = 平移

function setTool(t) {
  activeTool = t;
  wrap().classList.toggle('tool-hand', t === 'hand');
  import('../main.js').then((m) => m.toast(t === 'hand' ? '抓手工具：按住任意位置拖动平移（按 V 切回移动工具）' : '移动工具：可框选、拖动节点（按 H 切换抓手）'));
}

export function initInteraction() {
  const el = wrap();

  el.addEventListener('wheel', onWheel, { passive: false });
  el.addEventListener('pointerdown', onPointerDown);
  el.addEventListener('dblclick', onDblClick);
  el.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
      e.preventDefault();
      spaceHeld = true;
      wrap().classList.add('panning');
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') { spaceHeld = false; if (!drag || drag.mode !== 'pan') wrap().classList.remove('panning'); }
  });

  // 连线点击删除
  document.getElementById('edgeLayer').addEventListener('click', (e) => {
    const edgeId = e.target.closest('[data-edge]')?.dataset.edge;
    if (!edgeId || edgeId === '__temp__') return;
    store.pushHistory();
    store.removeEdge(edgeId);
    import('../main.js').then((m) => m.toast('已删除连线'));
  });
}

/* ================= 滚轮缩放 ================= */
/* 鼠标位于可滚动元素（提示词输入框、面板等）之上时，滚轮交给原生滚动，不缩放画布 */
function overScrollable(e) {
  let n = e.target;
  const stop = wrap();
  while (n && n !== stop) {
    if (n.nodeType === 1) {
      const oy = getComputedStyle(n).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) return true;
    }
    n = n.parentElement;
  }
  return false;
}
function onWheel(e) {
  if (overScrollable(e)) return; // 不 preventDefault，让浏览器原生滚动
  e.preventDefault();
  const rect = wrap().getBoundingClientRect();
  camera.zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.12 : 1 / 1.12);
  store.emit({ type: 'render' });
}

/* ================= 指针按下 ================= */
function onPointerDown(e) {
  if (e.button === 2) return; // 右键交给 contextmenu
  const rect = wrap().getBoundingClientRect();
  const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
  const world = camera.screenToWorld(sx, sy);

  // 抓手工具：任意位置按住即平移；Space 按住 + 拖动同理
  if ((activeTool === 'hand' || spaceHeld) && e.button === 0 &&
      !e.target.closest('.minimap, .zoom-ctrl, .topbar, .ai-chat, .asset-panel, .prompt-panel, .node-menu, .search-panel')) {
    drag = { mode: 'pan', lastX: e.clientX, lastY: e.clientY };
    wrap().classList.add('panning');
    return;
  }

  // 1) 端口：开始拖线
  const portEl = e.target.closest('.node-port');
  if (portEl && e.button === 0) {
    const nodeEl = portEl.closest('.canvas-node');
    const node = store.getNode(nodeEl.dataset.id);
    const isOut = portEl.classList.contains('port-out');
    // 输出端口 → 以本节点为源；输入端口 → 一律以本节点为「目标端」，
    // 松手时把对方节点连进本节点输入（方向与拖拽一致，不反接、不劫持已有上游）。
    // 输入允许多条上游（多参考），无需"从上游拖出重连"
    const dir = isOut ? 'out' : 'in';
    drag = { mode: 'connect', dir, startScreen: { x: sx, y: sy }, srcNode: node };
    e.preventDefault();
    return;
  }

  // 2) 节点标题/卡片：选中 + 拖动（忽略面板内交互元素）
  const nodeEl = e.target.closest('.canvas-node');
  // 视频画面区域也可按住拖动节点；仅点在底部原生控制条（约 44px）时交给 <video>（播放/进度/音量）
  const vidEl = e.target.closest?.('video');
  const vidRect = vidEl?.getBoundingClientRect();
  const onVideoControls = !!(vidEl && vidRect && e.clientY - vidRect.top > vidRect.height - 44);
  if (nodeEl && !e.target.closest('.prompt-panel, textarea, select, input, button, audio, .card-history') && !onVideoControls) {
    const id = nodeEl.dataset.id;
    const node = store.getNode(id);
    if (!node) return;

    // 「从画布选择」模式
    if (handleCanvasPick(node)) return;

    // Alt + 拖动节点 / Ctrl+Alt + 拖动：复制节点（副本）并拖动副本
    if (e.altKey) {
      store.pushHistory();
      const copy = duplicateNode(node);
      store.selection.clear();
      store.selection.add(copy.id);
      store.emit({ type: 'selection' });
      drag = { mode: 'node', startWorld: world, origins: new Map([[copy.id, { ...copy.position }]]), moved: false, id: copy.id };
      e.preventDefault();
      return;
    }

    const additive = e.shiftKey || e.ctrlKey;
    let wasMulti = false;
    if (!store.selection.has(id)) {
      if (!additive) store.selection.clear();
      // 单击只选中该节点本身（组内节点也单独弹出提示词面板）；
      // 整组选中/移动走组框，Shift/Ctrl 可逐个加选
      store.selection.add(id);
      store.emit({ type: 'selection' });
    } else if (additive) {
      store.selection.delete(id);
      store.emit({ type: 'selection' });
      return;
    } else {
      // 已在多选中（如整组被选中后单击其中某个节点）：
      // 拖动仍整批移动；原地单击（未拖动）则收敛为只选中该节点，弹出其面板
      wasMulti = store.selection.size > 1;
    }

    const origins = new Map([...store.selection].map((sid) => [sid, { ...store.getNode(sid).position }]));
    drag = { mode: 'node', startWorld: world, origins, moved: false, id, additive, wasMulti };
    e.preventDefault();
    return;
  }

  // 3) 空白区域
  if (e.target.closest('.canvas-node') || e.target.closest('.minimap, .zoom-ctrl')) return;

  // 平移：中键 / Ctrl+左键 / Alt+左键 / 抓手工具 / Space+拖动
  if (e.button === 1 || e.altKey || (e.button === 0 && (e.ctrlKey || e.metaKey))) {
    drag = { mode: 'pan', lastX: e.clientX, lastY: e.clientY };
    wrap().classList.add('panning');
    return;
  }
  if (e.button === 0) {
    // 默认左键拖动 = 框选（Shift = 加选），松开时未拖动则清除选中
    drag = { mode: 'marquee', startX: sx, startY: sy, add: e.shiftKey, movedFar: false };
    const mq = document.getElementById('marquee');
    mq.classList.remove('hidden');
    mq.style.left = sx + 'px'; mq.style.top = sy + 'px'; mq.style.width = '0'; mq.style.height = '0';
  }
}

/* ================= 指针移动 ================= */
function onPointerMove(e) {
  if (!drag) return;
  const rect = wrap().getBoundingClientRect();

  if (drag.mode === 'pan') {
    camera.panBy(e.clientX - drag.lastX, e.clientY - drag.lastY);
    drag.lastX = e.clientX; drag.lastY = e.clientY;
    store.emit({ type: 'render' });
    return;
  }

  if (drag.mode === 'node') {
    const world = camera.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    const dx = world.x - drag.startWorld.x, dy = world.y - drag.startWorld.y;
    if (!drag.moved && Math.hypot(dx, dy) < 3 / camera.scale) return;
    drag.moved = true;
    const deltas = new Map();
    for (const [id, orig] of drag.origins) {
      deltas.set(id, { x: orig.x + dx, y: orig.y + dy });
    }
    // 对齐吸附：与其他节点的左/中/右、上/中/下对齐时吸住并画辅助线
    const snap = computeAlignSnap(drag.origins, deltas);
    if (snap) {
      for (const [id, p] of deltas) deltas.set(id, { x: p.x + snap.dx, y: p.y + snap.dy });
    }
    store.moveNodes(deltas);
    renderAlignGuides(snap?.guides || null);
    return;
  }

  if (drag.mode === 'marquee') {
    const mq = document.getElementById('marquee');
    const x = Math.min(drag.startX, e.clientX - rect.left), y = Math.min(drag.startY, e.clientY - rect.top);
    const w = Math.abs(e.clientX - rect.left - drag.startX), h = Math.abs(e.clientY - rect.top - drag.startY);
    mq.style.left = x + 'px'; mq.style.top = y + 'px'; mq.style.width = w + 'px'; mq.style.height = h + 'px';
    drag.rect = { x, y, w, h };
    return;
  }

  if (drag.mode === 'connect') {
    const cur = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    renderTempEdge(drag.startScreen, cur);
    return;
  }
}

/* ================= 拖动对齐吸附 ================= */
/** 节点世界坐标包围盒（宽取 node.width，高读 DOM 实际布局高度） */
function nodeWorldRect(n, pos) {
  const el = getNodeEl(n.id);
  const h = el ? el.offsetHeight / camera.scale : 340;
  return { x: pos.x, y: pos.y, w: n.width || 260, h };
}

/**
 * 计算拖动中的节点组与静态节点的对齐吸附：
 * 比对左/中/右（x）与上/中/下（y），阈值内取最近的一组，整批选中一起吸附。
 * 返回 { dx, dy, guides:[{axis,pos}] } 或 null。
 */
function computeAlignSnap(origins, deltas) {
  const TH = 6 / camera.scale; // 吸附阈值 6 屏幕像素
  const sel = new Set(deltas.keys());
  const dragged = [], statics = [];
  for (const n of store.nodes.values()) {
    if (sel.has(n.id)) dragged.push(nodeWorldRect(n, deltas.get(n.id)));
    else statics.push(nodeWorldRect(n, n.position));
  }
  if (!dragged.length || !statics.length) return null;

  const centers = (r) => ({ xs: [r.x, r.x + r.w / 2, r.x + r.w], ys: [r.y, r.y + r.h / 2, r.y + r.h] });
  let bestX = null, bestY = null; // {diff, guide, axis}
  const dCenters = dragged.map(centers);
  for (const s of statics) {
    const sc = centers(s);
    for (const dc of dCenters) {
      for (const dv of dc.xs) {
        for (const sv of sc.xs) {
          const diff = sv - dv;
          if (Math.abs(diff) <= TH && (!bestX || Math.abs(diff) < Math.abs(bestX.diff))) {
            bestX = { diff, guide: sv, axis: 'v' };
          }
        }
      }
      for (const dv of dc.ys) {
        for (const sv of sc.ys) {
          const diff = sv - dv;
          if (Math.abs(diff) <= TH && (!bestY || Math.abs(diff) < Math.abs(bestY.diff))) {
            bestY = { diff, guide: sv, axis: 'h' };
          }
        }
      }
    }
  }
  if (!bestX && !bestY) return null;
  const guides = [];
  if (bestX) guides.push({ axis: 'v', pos: bestX.guide });
  if (bestY) guides.push({ axis: 'h', pos: bestY.guide });
  return { dx: bestX?.diff || 0, dy: bestY?.diff || 0, guides };
}

/* ================= 指针抬起 ================= */
function onPointerUp(e) {
  if (!drag) return;
  const d = drag;
  drag = null;
  const rect = wrap().getBoundingClientRect();

  if (d.mode === 'pan') { wrap().classList.remove('panning'); return; }

  if (d.mode === 'node') {
    renderAlignGuides(null); // 清除对齐辅助线
    if (d.moved) store.pushHistory();
    else if (d.wasMulti && !d.additive) {
      // 多选中原地单击 = 收敛为单选该节点
      store.selection.clear();
      store.selection.add(d.id);
      store.emit({ type: 'selection' });
    }
    return;
  }

  if (d.mode === 'marquee') {
    const mq = document.getElementById('marquee');
    mq.classList.add('hidden');
    if (d.rect && (d.rect.w > 4 || d.rect.h > 4)) {
      if (!d.add) store.selection.clear();
      // 所见即所得：节点实际渲染矩形与选框相交才选中（不再用「左上角 + 固定扩展区」的粗略估算）
      for (const node of store.nodes.values()) {
        let nx, ny, nw, nh;
        const el = getNodeEl(node.id);
        if (el) {
          const r = el.getBoundingClientRect();
          nx = r.left - rect.left; ny = r.top - rect.top;
          nw = r.width; nh = r.height;
        } else {
          const p = camera.worldToScreen(node.position.x, node.position.y);
          nx = p.x; ny = p.y;
          nw = node.width * camera.scale; nh = 340 * camera.scale;
        }
        if (nx < d.rect.x + d.rect.w && nx + nw > d.rect.x &&
            ny < d.rect.y + d.rect.h && ny + nh > d.rect.y) {
          store.selection.add(node.id);
        }
      }
      store.emit({ type: 'selection' });
    } else if (!d.add && store.selection.size) {
      // 空白处单击（未形成选框）= 取消选中
      store.selection.clear();
      store.emit({ type: 'selection' });
    }
    return;
  }

  if (d.mode === 'connect') {
    clearTempEdge();
    const targetEl = document.elementFromPoint(e.clientX, e.clientY)?.closest('.canvas-node');
    if (targetEl) {
      const target = store.getNode(targetEl.dataset.id);
      // 从输入端口拖出 → 拖拽方向即连线方向：对方节点 → 起始节点输入
      if (d.dir === 'in') tryConnect(target, d.srcNode);
      else tryConnect(d.srcNode, target);
      return;
    }
    // 拖到空白 → 弹出添加节点菜单（截图 6），选中类型后自动连线
    const world = camera.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    import('../main.js').then((m) => {
      m.openNodeMenu({
        x: e.clientX, y: e.clientY,
        title: '添加节点',
        highlight: d.dir === 'in'
          ? Object.keys(NODE_TYPES).filter((t) => validateEdgeTypes(t, d.srcNode.type).ok)
          : suggestTypes(d.srcNode),
        onPick: (type) => {
          store.pushHistory();
          const node = store.addNode(type, { x: world.x, y: world.y });
          if (d.dir === 'in') tryConnect(node, d.srcNode, true);
          else tryConnect(d.srcNode, node, true);
          // 新建后自动选中，立即显示提示词面板
          store.selection.clear();
          store.selection.add(node.id);
          store.emit({ type: 'selection' });
          return node;
        },
      });
    });
  }
}

function suggestTypes(srcNode) {
  if (!srcNode) return [];
  return Object.keys(NODE_TYPES).filter((t) => validateEdgeTypes(srcNode.type, t, srcNode).ok);
}

function tryConnect(srcNode, targetNode, silent = false) {
  if (!srcNode || !targetNode || srcNode.id === targetNode.id) return;
  const v = validateEdgeTypes(srcNode.type, targetNode.type, srcNode);
  if (!v.ok) {
    if (!silent) import('../main.js').then((m) => m.toast(v.reason, 'err'));
    else import('../main.js').then((m) => m.toast(`已创建节点，但连线被拒绝：${v.reason}`, 'err'));
    return;
  }
  // 视频模型参考上限（2.0：图≤9/音≤3且≤15s；2.5：图≤50/音≤60s）
  const vr = validateVideoRefs(targetNode, [srcNode], store.upstreamOf(targetNode.id));
  if (!vr.ok) {
    import('../main.js').then((m) => m.toast(vr.reason, 'err'));
    return;
  }
  store.pushHistory();
  store.addEdge(srcNode.id, targetNode.id);
  if (!silent) import('../main.js').then((m) => m.toast('连线成功', 'ok'));
}

/* ================= 双击：新建节点菜单 ================= */
function onDblClick(e) {
  if (e.target.closest('.canvas-node, .minimap, .zoom-ctrl, .topbar, .ai-chat, .asset-panel, .prompt-panel, .group-frame')) return;
  const rect = wrap().getBoundingClientRect();
  const world = camera.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
  import('../main.js').then((m) => {
    m.openNodeMenu({
      x: e.clientX, y: e.clientY,
      title: '新建节点',
      onPick: (type) => {
        store.pushHistory();
        const node = store.addNode(type, { x: world.x - (NODE_TYPES[type]?.width || 320) / 2, y: world.y - 100 });
        store.selection.clear();
        store.selection.add(node.id);
        store.emit({ type: 'selection' });
        return node;
      },
    });
  });
}

/* ================= 右键菜单 ================= */
function onContextMenu(e) {
  e.preventDefault();
  const onNode = e.target.closest('.canvas-node');
  const items = [];
  if (onNode) {
    const id = onNode.dataset.id;
    if (!store.selection.has(id)) { store.selection.clear(); store.selection.add(id); store.emit({ type: 'selection' }); }
    items.push(
      { label: '复制节点', act: () => copySelection() },
      { label: '删除节点', act: () => confirmRemoveNodes([...store.selection]) },
    );
  } else {
    items.push(
      { label: '新建节点', act: () => onDblClick(e) },
      { label: '粘贴', act: () => pasteClipboard(e.clientX, e.clientY) },
      { label: '全选', act: () => { store.nodes.forEach((n) => store.selection.add(n.id)); store.emit({ type: 'selection' }); } },
      { label: '清空画布', act: () => confirmClearCanvas() },
      { label: '重置视图', act: () => { camera.set(0, 0, 1); store.emit({ type: 'render' }); } },
    );
  }
  import('../main.js').then((m) => m.openCtxMenu(e.clientX, e.clientY, items));
}

/* ================= 键盘快捷键 ================= */
let clipboard = null;

function copySelection() {
  clipboard = [...store.selection].map((id) => JSON.parse(JSON.stringify(store.getNode(id)))).filter(Boolean);
  if (clipboard.length) {
    import('../main.js').then((m) => m.toast(`已复制 ${clipboard.length} 个节点`));
    // 同时在系统剪贴板写入标记：之后 Ctrl+V 时 paste 事件据此识别「粘贴节点」，
    // 避免系统剪贴板里残留的截图/图片被误上传成素材节点
    try {
      navigator.clipboard?.writeText('__WB_CANVAS_NODES__')
        .then(() => { window.__wbNodeCopyAt = Date.now(); })
        .catch(() => {});
    } catch { /* 忽略 */ }
  }
}

/** 副本命名：去掉已有的「副本」后缀后重新编号（视频 1 → 视频 1 副本；再复制 → 视频 1 副本 2） */
export function copyName(name) {
  const base = (name.replace(/\s*副本\s*\d*$/, '').trim()) || name;
  const existing = new Set([...store.nodes.values()].map((n) => n.name));
  let candidate = `${base} 副本`, k = 2;
  while (existing.has(candidate)) candidate = `${base} 副本 ${k++}`;
  return candidate;
}

/** Ctrl+D / 复制粘贴共用：把选中节点原样复制一份（一模一样，仅名字加「副本」、位置错开 36px），
 *  内部互连与上游连线一并复制，副本保持选中 */
function duplicateSelection() {
  if (!store.selection.size) return;
  store.pushHistory();
  const idMap = new Map();
  let i = 0;
  for (const id of store.selection) {
    const src = store.getNode(id);
    if (!src) continue;
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = `n_${crypto.randomUUID().slice(0, 8)}`;
    copy.position = { x: src.position.x + 36, y: src.position.y + 36 + i++ * 8 };
    // 一模一样：状态、结果输出、参数（提示词/@引用/参考图）全部保留；仅名字不同
    copy.name = copyName(src.name);
    if (copy.status === 'success') copy.progress = 100;
    idMap.set(id, copy.id);
    store.nodes.set(copy.id, copy);
    store.emit({ type: 'node_added', node: copy });
  }
  // 连线一并复制：内部互连（副本↔副本）+ 上游连线（外部上游复用原节点）
  for (const e of store.edges.values()) {
    const t = idMap.get(e.target);
    if (!t) continue;
    const s = idMap.get(e.source) || (store.getNode(e.source) ? e.source : null);
    if (s) store.addEdge(s, t, e.sourcePort, e.targetPort);
  }
  store.emit({ type: 'reload' });
  store.pushHistory();
  // 副本设为当前选中，直接弹出提示词面板
  store.selection.clear();
  for (const id of idMap.values()) store.selection.add(id);
  store.emit({ type: 'selection' });
  import('../main.js').then((m) => m.toast(`已复制 ${idMap.size} 个节点副本`, 'ok'));
}

/** 复制单个节点（Alt+拖动 / Ctrl+D / 右键菜单）：一模一样的副本 —— 保留提示词、@引用、参考图、结果输出，
 *  并把原节点收到的上游连线也接到副本上（连接上一级的线一起复制） */
export function duplicateNode(src) {
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = `n_${crypto.randomUUID().slice(0, 8)}`;
  copy.position = { x: src.position.x + 36, y: src.position.y + 36 };
  copy.status = src.status === 'success' ? 'success' : 'idle';
  copy.progress = src.status === 'success' ? 100 : 0;
  copy.outputs = JSON.parse(JSON.stringify(src.outputs || [{ name: 'out' }]));
  copy.params = JSON.parse(JSON.stringify(src.params || {}));
  if (copy.params.pinned) copy.params.pinned = false;
  copy.name = copyName(src.name);
  store.nodes.set(copy.id, copy);
  store.emit({ type: 'node_added', node: copy });
  // 上游连线一并复制（副本引用同一批上游节点）
  for (const e of store.edges.values()) {
    if (e.target === src.id) store.addEdge(e.source, copy.id, e.sourcePort, e.targetPort);
  }
  return copy;
}

function pasteClipboard(sx, sy) {
  if (!clipboard?.length) return;
  store.pushHistory();
  const hasCursor = sx != null && sy != null;
  let world = null;
  if (hasCursor) {
    const rect = wrap().getBoundingClientRect();
    world = camera.screenToWorld(sx - rect.left, sy - rect.top);
  }
  const idMap = new Map();
  let i = 0;
  for (const n of clipboard) {
    // 一模一样的副本：提示词 / @引用 / 参考图 / 结果输出 全部保留
    const copy = JSON.parse(JSON.stringify(n));
    copy.id = `n_${crypto.randomUUID().slice(0, 8)}`;
    // 名字加「副本」后缀（自动编号）：避免与原节点重名导致 @引用/下载文件名混乱
    copy.name = copyName(n.name);
    // 位置：右键粘贴到指定处（多个依次错开）；Ctrl+V 则贴着原节点错开，保持相对布局
    copy.position = hasCursor
      ? { x: world.x + i * 36, y: world.y + i * 36 }
      : { x: n.position.x + 36, y: n.position.y + 36 + i * 8 };
    if (copy.status !== 'success') { copy.status = 'idle'; copy.progress = 0; }
    else copy.progress = 100;
    i++;
    idMap.set(n.id, copy.id);
    store.nodes.set(copy.id, copy);
    store.emit({ type: 'node_added', node: copy });
  }
  // 保留剪贴板内部连线；指向外部上游节点的连线也一并接回（连接上一级）
  for (const e of store.edges.values()) {
    const t = idMap.get(e.target);
    if (!t) continue;
    const s = idMap.get(e.source) || (store.getNode(e.source) ? e.source : null);
    if (s) store.addEdge(s, t, e.sourcePort, e.targetPort);
  }
  store.emit({ type: 'reload' });
  store.pushHistory();
}

/** 供 main.js 的 paste 事件使用：是否有待粘贴的节点副本 */
export function hasNodeClipboard() { return !!(clipboard?.length); }
/** 粘贴节点副本（Ctrl+V 的 paste 事件兜底入口） */
export function pasteNodes() { pasteClipboard(); }

function onKeyDown(e) {
  const tag = document.activeElement?.tagName;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || document.activeElement?.isContentEditable) {
    if (e.key === 'Escape') document.activeElement.blur();
    return;
  }
  const ctrl = e.ctrlKey || e.metaKey;

  if (ctrl && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? store.redo() : store.undo(); store.emit({ type: 'reload' }); return; }
  if (ctrl && e.key.toLowerCase() === 'y') { e.preventDefault(); store.redo(); store.emit({ type: 'reload' }); return; }
  if (ctrl && e.key.toLowerCase() === 'c') { copySelection(); return; }
  // Ctrl+V：内部节点剪贴板有内容 → 粘贴节点副本（不再把系统剪贴板里的截图误传成素材；
  // 复制图片上传只在没有待粘贴节点时由 paste 事件处理）
  if (ctrl && e.key.toLowerCase() === 'v') {
    if (clipboard?.length) { window.__wbNodePasteAt = Date.now(); pasteClipboard(); }
    return;
  }
  // Ctrl+D：原地复制选中节点 —— 与原节点一模一样，仅名字加「副本」，位置贴着原节点错开
  if (ctrl && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelection(); return; }
  if (ctrl && e.key.toLowerCase() === 'a') { e.preventDefault(); store.nodes.forEach((n) => store.selection.add(n.id)); store.emit({ type: 'selection' }); return; }
  if (ctrl && e.key.toLowerCase() === 's') { e.preventDefault(); import('../main.js').then((m) => m.saveProject()); return; }
  if (ctrl && e.key === 'Enter') { e.preventDefault(); import('../main.js').then((m) => m.runWorkflow()); return; }
  // Ctrl+L：按选中顺序依次连线（浏览器可能占用 Ctrl+L，故同时支持选中后直接按 L）
  if (ctrl && e.key.toLowerCase() === 'l') { e.preventDefault(); connectSelected(); return; }
  if (!ctrl && !e.altKey && e.key.toLowerCase() === 'l' && store.selection.size >= 2) { e.preventDefault(); connectSelected(); return; }
  // Ctrl+G 成组 / Ctrl+Shift+G 解组
  if (ctrl && e.key.toLowerCase() === 'g') {
    e.preventDefault();
    e.shiftKey ? ungroupSelection() : groupSelection();
    return;
  }
  // Ctrl+0 适应画布；Ctrl+= / Ctrl++ 放大；Ctrl+- 缩小
  if (ctrl && (e.key === '0' || e.key === '=' || e.key === '+' || e.key === '-')) {
    e.preventDefault();
    if (e.key === '0') { fitView(); return; }
    const rect = wrap().getBoundingClientRect();
    camera.zoomAt(rect.width / 2, rect.height / 2, e.key === '-' ? 1 / 1.2 : 1.2);
    store.emit({ type: 'render' });
    return;
  }
  // Alt+Shift+F 整理画布（按依赖关系自动布局）
  if (e.altKey && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); tidyCanvas(); return; }
  // Ctrl+F 节点搜索
  if (ctrl && e.key.toLowerCase() === 'f') { e.preventDefault(); import('../main.js').then((m) => m.openNodeSearch()); return; }
  // Tab：新建节点菜单（画布中心）
  if (e.key === 'Tab') { e.preventDefault(); openCreateMenuAtCenter(); return; }
  // V 移动工具 / H 抓手工具
  if (!ctrl && e.key.toLowerCase() === 'v') { setTool('move'); return; }
  if (!ctrl && e.key.toLowerCase() === 'h') { setTool('hand'); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (store.selection.size) { e.preventDefault(); confirmRemoveNodes([...store.selection]); }
    return;
  }
  if (e.key === 'Escape') { store.selection.clear(); store.emit({ type: 'selection' }); }
}

/* ================= 快捷键动作 ================= */

/** 删除节点前弹确认框（列出名称，相关连线一并删除）；右键菜单复用 */
export async function removeNodeWithConfirm(id) {
  return confirmRemoveNodes([id]);
}
async function confirmRemoveNodes(ids) {
  const nodes = ids.map((id) => store.getNode(id)).filter(Boolean);
  if (!nodes.length) return;
  const { confirmDialog } = await import('../main.js');
  const preview = nodes.slice(0, 3).map((n) => `「${n.name}」`).join('、');
  const message = nodes.length > 3
    ? `确定删除 ${preview} 等 ${nodes.length} 个节点吗？相关连线将一并删除。`
    : `确定删除 ${preview}吗？相关连线将一并删除。`;
  const ok = await confirmDialog({ title: '删除节点', message });
  if (!ok) return;
  store.pushHistory();
  store.removeNodes(ids);
}

/** 清空画布前弹确认框 */
async function confirmClearCanvas() {
  if (!store.nodes.size) return;
  const { confirmDialog } = await import('../main.js');
  const ok = await confirmDialog({ title: '清空画布', message: `确定清空画布上的 ${store.nodes.size} 个节点吗？此操作可用 Ctrl+Z 撤销。`, confirmText: '清空' });
  if (!ok) return;
  store.pushHistory();
  store.clear();
}
function connectSelected() {
  const ids = [...store.selection];
  if (ids.length < 2) {
    import('../main.js').then((m) => m.toast('请先按住 Ctrl/Shift 选中多个节点（按顺序连线）', 'err'));
    return;
  }
  store.pushHistory();
  let ok = 0, fail = 0;
  for (let i = 0; i < ids.length - 1; i++) {
    const a = store.getNode(ids[i]), b = store.getNode(ids[i + 1]);
    if (!a || !b) continue;
    // 两个方向都尝试，取类型合法的方向
    if (validateEdgeTypes(a.type, b.type, a).ok) { store.addEdge(a.id, b.id); ok++; }
    else if (validateEdgeTypes(b.type, a.type, b).ok) { store.addEdge(b.id, a.id); ok++; }
    else fail++;
  }
  import('../main.js').then((m) => m.toast(
    ok ? `已连线 ${ok} 段${fail ? `，${fail} 段因类型不兼容被跳过` : ''}` : '连线失败：类型不兼容',
    ok ? 'ok' : 'err'));
}

function groupSelection() {
  const ids = [...store.selection];
  if (ids.length < 2) {
    import('../main.js').then((m) => m.toast('选中至少两个节点再成组（Ctrl/Shift 多选）', 'err'));
    return;
  }
  store.pushHistory();
  const gid = store.groupNodes(ids);
  const name = store.groupNames?.get(gid) || 'Group';
  import('../main.js').then((m) => {
    m.logOp('成组', `${name}（${ids.length} 个节点）`);
    m.toast(`已创建「${name}」（${ids.length} 个节点）：拖组框整组移动，双击组名重命名，Ctrl+Shift+G 解组`, 'ok');
  });
}

function ungroupSelection() {
  if (!store.selection.size) return;
  store.pushHistory();
  store.ungroupNodes([...store.selection]);
  import('../main.js').then((m) => { m.logOp('解组', `${store.selection.size} 个节点`); m.toast('已解组', 'ok'); });
}

/** 适应画布：缩放并居中到所有节点 */
function fitView() {
  const rect = wrap().getBoundingClientRect();
  if (!store.nodes.size) { camera.set(0, 0, 1); store.emit({ type: 'render' }); return; }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of store.nodes.values()) {
    minX = Math.min(minX, n.position.x);
    minY = Math.min(minY, n.position.y);
    maxX = Math.max(maxX, n.position.x + (n.width || 320));
    maxY = Math.max(maxY, n.position.y + 420);
  }
  const pad = 80;
  const scale = Math.min(3, Math.max(0.15, Math.min((rect.width - pad * 2) / Math.max(1, maxX - minX), (rect.height - pad * 2) / Math.max(1, maxY - minY))));
  camera.set(rect.width / 2 - ((minX + maxX) / 2) * scale, rect.height / 2 - ((minY + maxY) / 2) * scale, scale);
  store.emit({ type: 'render' });
}

/** 整理画布：按连线依赖拓扑分层，从左到右自动布局 */
function tidyCanvas() {
  if (!store.nodes.size) return;
  const nodes = [...store.nodes.values()];
  const ids = new Set(nodes.map((n) => n.id));
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of store.edges.values()) {
    if (ids.has(e.source) && ids.has(e.target)) indeg.set(e.target, indeg.get(e.target) + 1);
  }
  const layer = new Map();
  const q = [];
  for (const n of nodes) if (!indeg.get(n.id)) { layer.set(n.id, 0); q.push(n.id); }
  while (q.length) {
    const id = q.shift();
    for (const e of store.edges.values()) {
      if (e.source !== id || !ids.has(e.target)) continue;
      layer.set(e.target, Math.max(layer.get(e.target) ?? 0, (layer.get(id) ?? 0) + 1));
      indeg.set(e.target, indeg.get(e.target) - 1);
      if (indeg.get(e.target) === 0) q.push(e.target);
    }
  }
  const cols = new Map();
  for (const n of nodes) {
    const L = layer.get(n.id) ?? 0;
    if (!cols.has(L)) cols.set(L, []);
    cols.get(L).push(n.id);
  }
  store.pushHistory();
  const deltas = new Map();
  for (const [L, list] of cols) {
    list.forEach((id, i) => deltas.set(id, { x: L * 420, y: i * 480 }));
  }
  store.moveNodes(deltas);
  store.emit({ type: 'render' });
  fitView();
  import('../main.js').then((m) => m.toast('画布已按依赖关系整理', 'ok'));
}

/** Tab：在画布中心打开新建节点菜单 */
function openCreateMenuAtCenter() {
  const rect = wrap().getBoundingClientRect();
  import('../main.js').then((m) => m.openNodeMenu({
    x: rect.width / 2 - 100, y: rect.height / 2 - 160,
    title: '新建节点',
    onPick: (type) => {
      const world = camera.screenToWorld(rect.width / 2, rect.height / 2);
      store.pushHistory();
      const node = store.addNode(type, { x: world.x - (NODE_TYPES[type]?.width || 320) / 2, y: world.y - 100 });
      store.selection.clear();
      store.selection.add(node.id);
      store.emit({ type: 'selection' });
      return node;
    },
  }));
}
