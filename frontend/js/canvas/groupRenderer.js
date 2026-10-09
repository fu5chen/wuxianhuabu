// ============================================================
// canvas/groupRenderer.js — 分组可视化
// 成员包围盒边框 + 可改组名标题 + 整组选中/拖动 + 边框拖拽调节大小 + 右键解组
// ============================================================
import { store } from '../store.js';
import { camera } from './camera.js';
import { api } from '../services/api.js';

let layer = null;
const DEFAULT_PAD = { l: 16, t: 16, r: 16, b: 16 };
const MIN_PAD = 10;

export function initGroupLayer() {
  layer = document.createElement('div');
  layer.id = 'groupLayer';
  layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
  const wrapEl = document.getElementById('canvasWrap');
  const nodeLayer = document.getElementById('nodeLayer');
  wrapEl.insertBefore(layer, nodeLayer); // 组框在节点层之下
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function screenToWorld(e) {
  const rect = document.getElementById('canvasWrap').getBoundingClientRect();
  return camera.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
}

/** 组成员包围盒（世界坐标）→ 组框屏幕矩形（含四周扩展边距） */
function groupScreenRect(members) {
  const s = store.camera.scale, cx = store.camera.x, cy = store.camera.y;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of members) {
    const el = document.querySelector(`.canvas-node[data-id="${n.id}"]`);
    const w = el ? el.offsetWidth : (n.width || 320);
    const h = el ? el.offsetHeight : 420;
    minX = Math.min(minX, n.position.x);
    minY = Math.min(minY, n.position.y);
    maxX = Math.max(maxX, n.position.x + w);
    maxY = Math.max(maxY, n.position.y + h);
  }
  const bboxW = (maxX - minX) * s, bboxH = (maxY - minY) * s;
  return { minX, minY, bboxW, bboxH, x: minX * s + cx, y: minY * s + cy };
}

/** 渲染所有分组边框（挂到 applyPositions，所有渲染路径都会刷新） */
export function renderGroups() {
  if (!layer) return;
  // 清理失效组（成员被删除后剩余 <2 个则解散）
  for (const [gid, set] of [...store.groups]) {
    const alive = [...set].filter((id) => store.getNode(id));
    if (alive.length < 2) {
      store.groups.delete(gid);
      store.groupNames?.delete(gid);
      store.groupPads?.delete(gid);
      if (alive.length) store.dirty = true;
    } else if (alive.length !== set.size) {
      store.groups.set(gid, new Set(alive));
      store.dirty = true;
    }
  }
  if (!store.groups.size) { layer.innerHTML = ''; return; }

  layer.innerHTML = '';
  for (const [gid, set] of store.groups) {
    const members = [...set].map((id) => store.getNode(id)).filter(Boolean);
    if (members.length < 2) continue;
    const r = groupScreenRect(members);
    const pads = { ...DEFAULT_PAD, ...(store.groupPads?.get(gid) || {}) };
    const x = r.x - pads.l, y = r.y - pads.t;
    const w = r.bboxW + pads.l + pads.r, h = r.bboxH + pads.t + pads.b;
    const active = members.every((m) => store.selection.has(m.id));

    const frame = document.createElement('div');
    frame.className = 'group-frame' + (active ? ' active' : '');
    frame.dataset.gid = gid;
    frame.style.left = x + 'px';
    frame.style.top = y + 'px';
    frame.style.width = w + 'px';
    frame.style.height = h + 'px';
    frame.innerHTML = `
      <div class="gf-title">${escapeHtml(store.groupNames?.get(gid) || 'Group')}</div>
      <button class="gf-dl" title="下载分组内容（打包为 zip）">⬇</button>
      <div class="gf-handle gf-h-r" data-dir="r" title="拖拽调节宽度"></div>
      <div class="gf-handle gf-h-b" data-dir="b" title="拖拽调节高度"></div>
      <div class="gf-handle gf-h-br" data-dir="br" title="拖拽调节大小"></div>`;
    frame.addEventListener('pointerdown', (e) => onFrameDown(e, members));
    const dlBtn = frame.querySelector('.gf-dl');
    dlBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    dlBtn.addEventListener('dblclick', (e) => e.stopPropagation());
    dlBtn.addEventListener('click', (e) => { e.stopPropagation(); exportGroupZip(gid, members); });
    frame.querySelector('.gf-title').addEventListener('dblclick', (e) => { e.stopPropagation(); startGroupRename(frame, gid); });
    frame.querySelectorAll('.gf-handle').forEach((h) => {
      h.addEventListener('pointerdown', (e) => onHandleDown(e, gid, members, h.dataset.dir));
    });
    frame.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      import('../main.js').then((m) => m.openCtxMenu(e.clientX, e.clientY, [
        { label: '重命名分组', act: () => startGroupRename(frame, gid) },
        { label: '重置大小', act: () => { store.pushHistory(); store.resizeGroup(gid, { ...DEFAULT_PAD }); renderGroups(); } },
        { label: '解组', act: () => { store.pushHistory(); store.ungroupNodes([...set]); } },
      ]));
    });
    layer.appendChild(frame);
  }
}

/** 分组打包下载：收集组内全部节点的产出（生成结果优先，无结果时带上传参考图）→ 统一转 .png/.mp4 → 服务端打 zip */
async function exportGroupZip(gid, members) {
  const groupName = store.groupNames?.get(gid) || '分组';
  const m = await import('../main.js');
  const files = [];
  const used = new Set();
  const uniqueName = (base) => {
    let name = base, i = 2;
    while (used.has(name)) name = `${base} (${i++})`;
    used.add(name);
    return name;
  };
  /** 把一个产出转成统一格式（图→png、视频→mp4/webm、其余原样），base64 编码进 files */
  const pushOutput = async (node, out, base) => {
    if (!out?.url) return;
    const { blob, ext } = await m.prepareOutputBlob(node, out);
    const data = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
      fr.onerror = () => reject(new Error('读取文件失败'));
      fr.readAsDataURL(blob);
    });
    files.push({ name: uniqueName(base), data, ext: ext || 'bin' });
  };
  for (const n of members) {
    const outs = (n.outputs || []).filter((o) => o.resourceId);
    if (outs.length) {
      for (let idx = 0; idx < outs.length; idx++) {
        const multi = outs.length > 1 ? ` ${idx + 1}` : '';
        await pushOutput(n, outs[idx], `${n.name || '节点'}${multi}`);
      }
    } else if (n.params?.refResourceId) {
      // 无生成结果时带上传参考图：按节点类型给 kind，便于统一转 png
      await pushOutput(n, { url: `/api/assets/${n.params.refResourceId}`, kind: n.type === 'video' ? 'video' : 'image' }, `${n.name || '节点'} 参考`);
    }
  }
  if (!files.length) {
    m.toast('分组内没有可下载的文件（先运行生成）', 'err');
    return;
  }
  m.toast(`正在打包「${groupName}」内 ${files.length} 个文件…`);
  try {
    const blob = await api.exportGroup({ groupName, files });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${groupName}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) {
    m.toast('打包下载失败：' + e.message, 'err');
  }
}

/** 点击组框：整组选中；拖动组框：整组移动 */
function onFrameDown(e, members) {
  if (e.button !== 0 || e.target.closest('input, .gf-handle')) return;
  e.stopPropagation();
  store.selection.clear();
  for (const m of members) store.selection.add(m.id);
  store.emit({ type: 'selection' });

  const startWorld = screenToWorld(e);
  const origins = new Map(members.map((m) => [m.id, { ...m.position }]));
  let moved = false;
  const onMove = (ev) => {
    const w = screenToWorld(ev);
    const dx = w.x - startWorld.x, dy = w.y - startWorld.y;
    if (!moved && Math.hypot(dx, dy) * camera.scale < 3) return;
    moved = true;
    const deltas = new Map([...origins].map(([id, o]) => [id, { x: o.x + dx, y: o.y + dy }]));
    store.moveNodes(deltas);
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (moved) store.pushHistory();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

/** 拖拽手柄调节组框大小（右边缘 / 下边缘 / 右下角），只扩展边距、不动节点 */
function onHandleDown(e, gid, members, dir) {
  if (e.button !== 0) return;
  e.stopPropagation();
  e.preventDefault();
  const startPads = { ...DEFAULT_PAD, ...(store.groupPads?.get(gid) || {}) };
  const startX = e.clientX, startY = e.clientY;
  const onMove = (ev) => {
    const dx = ev.clientX - startX, dy = ev.clientY - startY;
    const p = { ...startPads };
    if (dir !== 'b') p.r = Math.max(MIN_PAD, Math.round(startPads.r + dx));
    if (dir !== 'r') p.b = Math.max(MIN_PAD, Math.round(startPads.b + dy));
    store.resizeGroup(gid, p);
    renderGroups();
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    store.pushHistory();
    document.body.style.cursor = '';
  };
  document.body.style.cursor = dir === 'b' ? 's-resize' : dir === 'r' ? 'e-resize' : 'nwse-resize';
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

/** 双击组名 / 右键重命名：行内输入 */
function startGroupRename(frame, gid) {
  const title = frame.querySelector('.gf-title');
  if (title.querySelector('input')) return;
  const old = store.groupNames?.get(gid) || 'Group';
  title.innerHTML = `<input value="${escapeHtml(old)}" spellcheck="false" />`;
  const input = title.querySelector('input');
  input.focus();
  input.select();
  input.addEventListener('pointerdown', (e) => e.stopPropagation());
  input.addEventListener('dblclick', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') input.blur();
    else if (e.key === 'Escape') { input.value = old; input.blur(); }
  });
  input.addEventListener('blur', () => {
    const v = input.value.trim() || old;
    title.textContent = v;
    store.renameGroup(gid, v);
  });
}
