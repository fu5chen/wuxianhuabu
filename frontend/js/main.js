// ============================================================
// main.js — 应用入口：工具栏 / 菜单 / 工作流运行 / SSE / 项目系统 / 资产库
// ============================================================
import { store } from './store.js';
import { camera } from './canvas/camera.js';
import { initGrid, drawGrid } from './canvas/gridRenderer.js';
import { initEdges, renderEdges } from './canvas/edge/edgeRenderer.js';
import { initMinimap, renderMinimap } from './canvas/minimap.js';
import { initInteraction, copyName } from './canvas/interaction.js';
import { initGroupLayer } from './canvas/groupRenderer.js';
import { NODE_TYPES, icon, validateEdgeTypes } from './nodes/nodeRegistry.js';
import { fullRender, renderOne, applyPositions, removeEl } from './nodes/nodeDom.js';
import { api, openEventStream } from './services/api.js';
import { topoSort, resolveReferences, validateGraph, collectSubgraph } from './dag/graph.js';
import { interpret } from './aiChat/chat.js';

/* ============ 工具 ============ */
let toastTimer;
export function toast(msg, kind = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}

/* ============ 初始化 ============ */
let es;

function init() {
  initGrid();
  initEdges();
  initMinimap();
  initInteraction();
  initGroupLayer();
  buildToolbar();
  buildNodeMenu();
  bindTopbar();
  bindAiChat();
  bindAssetPanel();
  bindShortcutPanel();
  bindPasteDrop();

  store.subscribe(onStoreEvent);

  // 拉取用户/模型信息
  api.getUser().then((d) => {
    window.__MODELS = d.models;
    document.getElementById('creditsNum').textContent = d.user.credits;
  }).catch(() => {});

  // 自动接着上次打开的项目继续（自动保存写回同一项目，而不是每次都另存新项目）
  void autoLoadLastProject();

  // SSE 事件流
  es = openEventStream(onTaskEvent);

  fullRender();
  renderEdges();
  drawGrid();
  renderMinimap();
}

/* ============ 状态事件 → 渲染 ============ */
function onStoreEvent(evt) {
  // 自动保存：有未保存改动时，任何画布操作都会重置 1 秒计时
  if (store.dirty) scheduleAutosave();
  switch (evt.type) {
    case 'reload':
      fullRender();
      renderEdges();
      drawGrid();
      renderMinimap();
      break;
    case 'node_added':
      if (evt.node.type !== 'media') logOp('创建节点', `${evt.node.type}「${evt.node.name}」`);
      renderOne(evt.node);
      renderEdges();
      renderMinimap();
      break;
    case 'nodes_moved':
      applyPositions();
      renderEdges();
      renderMinimap();
      break;
    case 'node_updated': {
      renderOne(evt.node);
      renderEdges();
      break;
    }
    case 'edge_added':
      renderEdges();
      renderMinimap();
      // 连线后：下游节点面板自动带出上游图片缩略图
      refreshDownstreamPanels([evt.edge.target]);
      logOp('建立连线', `${store.getNode(evt.edge.source)?.name || evt.edge.source} → ${store.getNode(evt.edge.target)?.name || evt.edge.target}`);
      break;
    case 'selection': {
      // 更新选中态 & 面板显隐（多选时收起提示词面板）
      const single = store.selection.size === 1;
      for (const node of store.nodes.values()) {
        const el = document.querySelector(`.canvas-node[data-id="${node.id}"]`);
        if (!el) continue;
        const shouldSel = store.selection.has(node.id);
        const wantPanel = (shouldSel && single) || !!node.params?.pinned;
        const hasPanel = !!el.querySelector('.prompt-panel');
        if (el.classList.contains('selected') !== shouldSel || wantPanel !== hasPanel) {
          renderOne(node);
          continue;
        }
      }
      renderEdges(); // 相连连线流动高亮 / 无关连线淡白
      break;
    }
    case 'groups_changed':
      applyPositions();
      break;
    case 'render':
      applyPositions();
      renderEdges();
      drawGrid();
      renderMinimap();
      break;
  }
}

/* ============ 左侧工具栏 ============ */
function buildToolbar() {
  const bar = document.getElementById('toolbar');
  const types = ['text', 'image', 'video', 'audio', 'timeline', 'subject', 'director'];
  for (const t of types) {
    const def = NODE_TYPES[t];
    const btn = document.createElement('button');
    btn.className = 'tool-btn';
    btn.title = def.label;
    btn.innerHTML = icon(def.icon);
    btn.addEventListener('click', () => {
      store.pushHistory();
      // 居中创建 + 按已有节点数错开排布，避免新节点完全叠在一起
      const off = store.nodes.size % 6;
      const cx = (-store.camera.x + window.innerWidth / 2) / store.camera.scale - def.width / 2 + off * 30;
      const cy = (-store.camera.y + window.innerHeight / 2) / store.camera.scale - def.cardH / 2 + off * 30;
      store.addNode(t, { x: cx, y: cy });
    });
    bar.appendChild(btn);
  }
  const up = document.createElement('button');
  up.className = 'tool-btn';
  up.title = '本地上传';
  up.innerHTML = '⬆';
  up.addEventListener('click', () => requestUpload((r) => createMediaNode(r)));
  bar.appendChild(up);
}

/** 本地上传 → 创建素材节点 */
export function requestUpload(cb) {
  const input = document.getElementById('fileInput');
  input.value = '';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    toast('上传中…');
    try {
      const r = await api.uploadFile(file);
      cb?.(r);
      toast(`上传成功：${file.name}`, 'ok');
    } catch (e) { toast('上传失败：' + e.message, 'err'); }
  };
  input.click();
}

function createMediaNode({ url, name, mime, id }, offsetIdx = 0) {
  store.pushHistory();
  const node = store.addNode('media', {
    x: (-store.camera.x + window.innerWidth / 2) / store.camera.scale - 170 + offsetIdx * 36,
    y: (-store.camera.y + window.innerHeight / 2) / store.camera.scale - 180 + offsetIdx * 36,
  });
  node.name = name || node.name;
  node.params = { url, mime, name };
  const kind = mime.startsWith('video') ? 'video' : mime.startsWith('audio') ? 'audio' : (/text|json/.test(mime) ? 'text' : 'image');
  node.outputs[0] = { name: kind, resourceId: id || url.split('/').pop(), url, kind };
  node.status = 'success';
  store.emit({ type: 'node_added', node });
  loadAssets();
  logOp('创建素材节点', node.name);
  // 已选中单个节点且类型兼容时自动连线（粘贴/拖放场景）
  if (store.selection.size === 1) {
    const [targetId] = store.selection;
    const target = store.getNode(targetId);
    if (target && target.id !== node.id && validateEdgeTypes(node.type, target.type, node).ok) {
      store.addEdge(node.id, target.id);
      toast(`已自动连线到「${target.name}」`, 'ok');
    }
  }
  return node;
}

/* ============ 粘贴 / 拖放上传：从别处复制图片直接进画布 ============ */
function bindPasteDrop() {
  window.addEventListener('paste', (e) => {
    const cd = e.clipboardData;
    const text = cd?.getData('text') || '';
    const files = [...(cd?.items || [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
    const recentNodePaste = Date.now() - (window.__wbNodePasteAt || 0) < 400;
    // 复制节点后的 Ctrl+V：粘贴节点副本（带 __WB_CANVAS_NODES__ 标记或刚粘贴过节点），
    // 系统剪贴板里残留的截图/图片不会被误传成素材节点
    if (text.includes('__WB_CANVAS_NODES__') || recentNodePaste) {
      e.preventDefault();
      import('./canvas/interaction.js').then(({ hasNodeClipboard, pasteNodes }) => {
        if (!recentNodePaste && hasNodeClipboard()) pasteNodes();
      });
      return;
    }
    // 剪贴板带文本时不拦截，避免影响正常文本粘贴；复制的是图片时才上传
    if (!files.length || text.trim()) return;
    e.preventDefault();
    uploadFilesAsNodes(files);
  });
  const cw = document.getElementById('canvasWrap');
  cw.addEventListener('dragover', (e) => e.preventDefault());
  cw.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) uploadFilesAsNodes(files);
  });
}

/** 批量上传文件并逐个建素材节点（错开排列，自动连线到已选节点） */
export async function uploadFilesAsNodes(files) {
  let idx = 0;
  for (const file of files) {
    try {
      toast(`上传中：${file.name}`);
      const r = await api.uploadFile(file);
      createMediaNode({ ...r, name: r.name || file.name, mime: r.mime || file.type }, idx++);
    } catch (e) {
      toast(`上传失败：${file.name} — ${e.message}`, 'err');
    }
  }
}

/* ============ 操作日志上报（服务端 operation-*.log） ============ */
export function logOp(action, detail = '') {
  try {
    fetch('/api/logs/client', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, detail }),
    }).catch(() => {});
  } catch { /* 忽略 */ }
}

/* ============ 新建节点菜单 / 右键菜单 ============ */
let menuCtx = null;

function buildNodeMenu() {
  const list = document.getElementById('nodeMenuList');
  const types = ['text', 'image', 'video', 'audio', 'timeline', 'subject', 'director'];
  for (const t of types) {
    const def = NODE_TYPES[t];
    const item = document.createElement('div');
    item.className = 'nm-item';
    item.dataset.type = t;
    item.innerHTML = `<span class="nm-icon">${icon(def.icon)}</span>${def.label}`;
    item.addEventListener('click', () => {
      const ctx = menuCtx;
      hideMenus();
      const node = ctx?.onPick?.(t);
      if (node) toast(`已创建「${node.name}」`);
    });
    list.appendChild(item);
  }
  // 从资产库 / 本地上传
  document.querySelector('[data-action="from-library"]').addEventListener('click', () => { hideMenus(); openAssetPicker((a) => createMediaNode({ url: a.url, name: a.name, mime: a.mime })); });
  document.querySelector('[data-action="upload-local"]').addEventListener('click', () => { hideMenus(); requestUpload((r) => createMediaNode(r)); });
}

export function openNodeMenu({ x, y, title, onPick, highlight = [], only = null }) {
  const menu = document.getElementById('nodeMenu');
  document.getElementById('nodeMenuTitle').textContent = title || '新建节点';
  menuCtx = { onPick };
  menu.querySelectorAll('.nm-item[data-type]').forEach((it) => {
    it.classList.toggle('nm-active', highlight.includes(it.dataset.type));
    // only：只显示指定类型（如右键"新建下一级节点"只列能接住上游输出的类型）
    it.classList.toggle('nm-only-hide', !!only && !only.includes(it.dataset.type));
  });
  menu.style.left = Math.min(x, window.innerWidth - 240) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - 420) + 'px';
  menu.classList.remove('hidden');
  menuCtx.dismiss = onDocDismiss;
  function onDocDismiss(e) {
    if (!menu.contains(e.target)) { hideMenus(); }
  }
  setTimeout(() => document.addEventListener('pointerdown', onDocDismiss, { once: true }), 0);
}

export function openCtxMenu(x, y, items) {
  const menu = document.getElementById('ctxMenu');
  const list = document.getElementById('ctxMenuList');
  list.innerHTML = '';
  for (const it of items) {
    const div = document.createElement('div');
    div.className = 'nm-item';
    div.textContent = it.label;
    div.addEventListener('click', (ev) => { hideMenus(); it.act?.(ev); });
    list.appendChild(div);
  }
  menu.style.left = Math.min(x, window.innerWidth - 220) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - 300) + 'px';
  menu.classList.remove('hidden');
  function onDocDismiss(e) { if (!menu.contains(e.target)) hideMenus(); }
  setTimeout(() => document.addEventListener('pointerdown', onDocDismiss, { once: true }), 0);
}

function hideMenus() {
  document.getElementById('nodeMenu').classList.add('hidden');
  document.getElementById('ctxMenu').classList.add('hidden');
  menuCtx = null;
}

/* ============ 结果下载 ============ */
const EXT_BY_MIME = {
  'image/svg+xml': 'svg', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/webm': 'webm',
  'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg',
  'application/json': 'json', 'text/plain': 'txt',
};

/** 节点产出 → 统一格式的 Blob：图片一律转 .png，视频一律 .mp4（不支持时回退 .webm），其余按 mime 定扩展名。
 *  供单节点下载与分组打包下载共用。 */
export async function prepareOutputBlob(node, out) {
  const res = await fetch(out.url);
  const blob = await res.blob();
  const type = (blob.type || '').split(';')[0];
  // 视频优先：模拟视频是 SVG 动画（blob.type 为 image/svg+xml），必须先按节点 kind 判定为视频
  const isVideo = out.kind === 'video' || type.startsWith('video/');
  const isImage = !isVideo && (out.kind === 'image' || type.startsWith('image/'));

  if (isImage) return { blob: await toPngBlob(blob), ext: 'png' };
  if (isVideo) {
    if (type === 'video/mp4') return { blob, ext: 'mp4' };
    // 模拟视频（SVG 动画占位 / 其它格式）：实时录制转码，优先 MP4，回退 WebM
    toast(`正在把「${node?.name || '视频'}」转码为 MP4（约 ${Math.round(recordSeconds(node))} 秒）…`);
    const { blob: vb, ext } = await recordPlaceholderVideo(out.url, recordSeconds(node));
    return { blob: vb, ext };
  }
  const ext = EXT_BY_MIME[type] || (out.kind === 'text' ? 'txt' : (String(out.resourceId || '').match(/\.(png|jpe?g|svg|webp|mp4|webm|wav|json)$/) || [])[1] || 'bin');
  return { blob, ext };
}

/** 下载节点结果：图片一律转成 .png，视频一律 .mp4（浏览器不支持 MP4 编码时回退 .webm）；
 *  文件名与节点名一致；静默执行，无提示 */
export async function downloadNodeResult(node) {
  const out = node?.outputs?.[0];
  if (!out?.url) return;
  const base = node.name || 'result';
  try {
    const { blob, ext } = await prepareOutputBlob(node, out);
    saveBlob(blob, `${base}.${ext}`);
  } catch (e) {
    console.warn('[download failed]', e);
    toast('下载失败：' + e.message, 'err');
  }
}

/** 录制时长：视频节点用其设定的时长（2~30s），其它默认 5s */
function recordSeconds(node) {
  return Math.min(30, Math.max(2, Number(node?.params?.duration) || 5));
}

/** 任意图片（含 SVG）→ PNG Blob（按原始尺寸绘制到 canvas 再编码） */
function toPngBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth || 1024;
        c.height = img.naturalHeight || 1024;
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG 编码失败'))), 'image/png');
      } catch (err) { URL.revokeObjectURL(url); reject(err); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片解码失败')); };
    img.src = url;
  });
}

/** SVG 动画占位视频 → 实时录制为 MP4（浏览器不支持时回退 WebM） */
async function recordPlaceholderVideo(url, seconds) {
  const img = new Image();
  img.src = url;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth || 1280;
  canvas.height = img.naturalHeight || 720;
  const ctx = canvas.getContext('2d');
  const stream = canvas.captureStream(30);
  const mimes = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
  const mime = mimes.find((t) => window.MediaRecorder?.isTypeSupported?.(t));
  if (!mime) throw new Error('浏览器不支持视频录制');
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4000000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
  const stopped = new Promise((r) => { rec.onstop = r; });
  rec.start(250);
  const t0 = performance.now();
  const draw = () => {
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    if (performance.now() - t0 < seconds * 1000) requestAnimationFrame(draw);
  };
  draw();
  await new Promise((r) => setTimeout(r, seconds * 1000 + 300));
  rec.stop();
  await stopped;
  const outType = rec.mimeType || mime;
  return { blob: new Blob(chunks, { type: outType }), ext: outType.includes('mp4') ? 'mp4' : 'webm' };
}

function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 8000);
}

/* ============ 节点搜索 / 快捷键面板 ============ */
export async function openNodeSearch() {
  const { openSearch } = await import('./canvas/search.js');
  openSearch();
}

function bindShortcutPanel() {
  const panel = document.getElementById('shortcutPanel');
  document.getElementById('btnShortcuts')?.addEventListener('click', () => panel.classList.toggle('hidden'));
  panel?.querySelector('.sp-close')?.addEventListener('click', () => panel.classList.add('hidden'));
  document.addEventListener('pointerdown', (e) => {
    if (panel && !panel.classList.contains('hidden') && !panel.contains(e.target) && !e.target.closest('#btnShortcuts')) {
      panel.classList.add('hidden');
    }
  });
}

/** 刷新下游节点的面板（连线自动带入的上游参考图缩略图需要同步） */
function refreshDownstreamPanels(targetIds) {
  for (const id of targetIds) {
    const t = store.getNode(id);
    if (t && ['image', 'video'].includes(t.type) && (store.selection.has(t.id) || t.params?.pinned)) {
      if (document.querySelector(`.canvas-node[data-id="${t.id}"] .prompt-panel`)) renderOne(t);
    }
  }
}

/** 删除 / 清空前确认弹窗（返回 Promise<boolean>） */
export function confirmDialog({ title = '确认操作', message = '', confirmText = '删除', danger = true }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-box" role="dialog" aria-modal="true">
        <div class="cf-title">${escapeHtml(title)}</div>
        <div class="cf-msg">${escapeHtml(message)}</div>
        <div class="cf-btns">
          <button class="cf-btn cf-cancel">取消</button>
          <button class="cf-btn cf-ok ${danger ? 'danger' : ''}">${escapeHtml(confirmText)}</button>
        </div>
      </div>`;
    const done = (v) => { overlay.remove(); window.removeEventListener('keydown', onKey, true); resolve(v); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); done(false); }
      else if (e.key === 'Enter') { e.stopPropagation(); e.preventDefault(); done(true); }
    };
    overlay.querySelector('.cf-cancel').addEventListener('click', () => done(false));
    overlay.querySelector('.cf-ok').addEventListener('click', () => done(true));
    // 拦截画布交互，避免误触
    overlay.addEventListener('pointerdown', (e) => e.stopPropagation());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
    window.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    overlay.querySelector('.cf-ok').focus();
  });
}

/* ============ 顶栏：项目 / 保存 / 运行 ============ */
function bindTopbar() {
  const nameInput = document.getElementById('projectName');
  nameInput.addEventListener('change', () => { store.projectName = nameInput.value || '未命名项目'; store.dirty = true; scheduleAutosave(); });

  document.getElementById('btnSave').addEventListener('click', () => saveProject());
  document.getElementById('btnRun').addEventListener('click', () => runWorkflow());

  /* ---- 临时隧道（ngrok）安全开关 ----
   * 开：启动隧道（公网访问需令牌），本地素材即可入库；关：隧道与令牌立即失效。
   * 建议只在入库本地素材时临时开启，用完关闭。 */
  const btnTunnel = document.getElementById('btnTunnel');
  async function syncTunnelBadge() {
    try {
      const s = await fetch('/api/tunnel').then((r) => r.json());
      btnTunnel.classList.toggle('tunnel-on', !!s.active);
      btnTunnel.textContent = s.active ? '⛓ 隧道·开' : '⛓ 隧道';
      btnTunnel.title = s.active
        ? `隧道已开启：${s.url}\n公网访问需令牌；用完请点击关闭`
        : '临时隧道（ngrok）：本地素材入库时开启，用完关闭';
    } catch { /* 服务未就绪时忽略 */ }
  }
  btnTunnel.addEventListener('click', async () => {
    btnTunnel.disabled = true;
    try {
      const s = await fetch('/api/tunnel').then((r) => r.json()).catch(() => ({ active: false }));
      if (s.active) {
        await fetch('/api/tunnel/stop', { method: 'POST' });
        toast('隧道已关闭，公网不再可访问', 'ok');
      } else {
        toast('正在启动 ngrok 隧道（首次需自动下载，约 10~30 秒）…');
        const r = await fetch('/api/tunnel/start', { method: 'POST' }).then((x) => x.json());
        if (r.ok) toast(`隧道已开启：${r.url}\n（入库会自动带令牌，用完请点一次关闭）`, 'ok');
        else toast('隧道启动失败：' + r.error, 'err');
      }
    } finally {
      btnTunnel.disabled = false;
      syncTunnelBadge();
    }
  });
  syncTunnelBadge();

  const btnProjects = document.getElementById('btnProjects');
  const panel = document.getElementById('projectListPanel');
  btnProjects.addEventListener('click', async () => {
    if (!panel.classList.contains('hidden')) { panel.classList.add('hidden'); return; }
    panel.innerHTML = '<div class="dd-empty">加载中…</div>';
    panel.classList.remove('hidden');
    await renderProjectList(panel);
  });
}

/* 渲染项目列表（打开下拉 / 复制项目后刷新共用）；返回是否列表为空 */
async function renderProjectList(panel) {
  try {
    const { projects } = await api.listProjects();
    panel.innerHTML = projects.length ? '' : '<div class="dd-empty">暂无项目</div>';
    for (const p of projects) panel.appendChild(buildProjectItem(p, panel));
    // 新建项目
    const div = document.createElement('div');
    div.className = 'dd-item';
    div.innerHTML = `<span class="dd-name" style="color:var(--accent)">＋ 新建项目</span>`;
    div.addEventListener('click', async () => {
      panel.classList.add('hidden');
      const doc = await api.createProject('未命名项目');
      store.loadJSON(doc, doc.id);
      document.getElementById('projectName').value = doc.name;
      fixupVideoMimes();
      rememberLastProject(doc.id);
      toast('已新建项目', 'ok');
    });
    panel.appendChild(div);
    return projects.length === 0;
  } catch (e) {
    panel.innerHTML = `<div class="dd-empty">${escapeHtml(e.message)}</div>`;
    return true;
  }
}

/* ---------- 最近项目记忆：刷新页面后自动接着上次的项目继续，自动保存才不会"另存" ---------- */
const LAST_PID_KEY = 'wb_lastProjectId';
function rememberLastProject(id) {
  try { id ? localStorage.setItem(LAST_PID_KEY, id) : localStorage.removeItem(LAST_PID_KEY); } catch { /* 隐私模式忽略 */ }
}
async function autoLoadLastProject() {
  try {
    const lastId = localStorage.getItem(LAST_PID_KEY);
    if (!lastId || store.projectId) return;
    const doc = await api.getProject(lastId);
    if (!doc) { rememberLastProject(null); return; }
    store.loadJSON(doc, doc.id);
    document.getElementById('projectName').value = doc.name;
    fixupVideoMimes();
  } catch { /* 加载失败保持空白画布 */ }
}

/* 项目下拉列表的单行：普通态（名称/节点数/复制/删除按钮）与确认态（删除二次确认）切换 */
function buildProjectItem(p, panel) {
  const div = document.createElement('div');
  div.className = 'dd-item';

  const renderNormal = () => {
    div.classList.remove('dd-confirming');
    div.innerHTML = `<span class="dd-name">${escapeHtml(p.name)}</span>`
      + `<span class="dd-right"><span class="dd-meta">${p.nodeCount}节点</span>`
      + `<button class="dd-copy" title="复制项目">⧉</button>`
      + `<button class="dd-del" title="删除项目">🗑</button></span>`;
    div.querySelector('.dd-del').addEventListener('click', (ev) => {
      ev.stopPropagation();
      renderConfirm();
    });
    // 复制项目：整份文档另存为一个新 id 的「xxx 副本」，列表原地刷新
    div.querySelector('.dd-copy').addEventListener('click', async (ev) => {
      ev.stopPropagation();
      try {
        const doc = await api.getProject(p.id);
        const newId = crypto.randomUUID();
        await api.saveProject(newId, { ...doc, id: newId, name: `${p.name} 副本` });
        await renderProjectList(panel);
        toast(`已复制为「${p.name} 副本」`, 'ok');
      } catch (e) { toast('复制失败：' + e.message, 'err'); }
    });
    div.addEventListener('click', async () => {
      panel.classList.add('hidden');
      try {
        const doc = await api.getProject(p.id);
        store.loadJSON(doc, p.id);
        document.getElementById('projectName').value = doc.name;
        fixupVideoMimes();
        rememberLastProject(p.id);
        toast(`已加载「${doc.name}」`, 'ok');
      } catch (e) { toast('加载失败：' + e.message, 'err'); }
    });
  };

  // 二级确认：点删除后该行变为「确认删除？[删除][取消]」，不会误触
  const renderConfirm = () => {
    div.classList.add('dd-confirming');
    div.innerHTML = `<span class="dd-confirm-text">删除「${escapeHtml(p.name)}」？</span>`
      + `<span class="dd-right"><button class="dd-btn dd-btn-danger">删除</button>`
      + `<button class="dd-btn dd-btn-cancel">取消</button></span>`;
    div.querySelector('.dd-btn-danger').addEventListener('click', async (ev) => {
      ev.stopPropagation();
      try {
        await api.deleteProject(p.id);
        div.remove();
        if (p.id === store.projectId) {
          // 删除的是当前打开的项目：画布重置为空白草稿，下次保存自动新建
          store.loadJSON({ name: '未命名项目', nodes: [], edges: [] }, null);
          rememberLastProject(null);
          document.getElementById('projectName').value = '未命名项目';
          fixupVideoMimes();
          toast('项目已删除，当前画布已重置', 'ok');
        } else {
          toast(`已删除「${p.name}」`, 'ok');
        }
      } catch (e) { toast('删除失败：' + e.message, 'err'); renderNormal(); }
    });
    div.querySelector('.dd-btn-cancel').addEventListener('click', (ev) => {
      ev.stopPropagation();
      renderNormal();
    });
  };

  renderNormal();
  return div;
}

export async function saveProject(silent = false) {
  try {
    const doc = store.toJSON();
    let id = store.projectId;
    if (!id) {
      const created = await api.createProject(doc.name);
      id = store.projectId = created.id;
    }
    await api.saveProject(id, doc);
    store.dirty = false;
    rememberLastProject(id);
    document.getElementById('projectName').value = doc.name;
    toast(silent ? '已自动保存' : '项目已保存', 'ok');
  } catch (e) { toast('保存失败：' + e.message, 'err'); }
}

/* ============ 自动保存：用户操作期间不保存，停止操作 3 秒后才保存一次 ============
 * - 每次操作都会重置 3 秒计时（连续操作期间永远不触发保存）
 * - 保存后 dirty 复位；之后若用户一直没操作，就不再发起保存
 * - 保存进行中又有新改动 → 保存完成后再排一次，确保最终状态落盘 */
let autosaveTimer = null;
let autosaveSaving = false;
export function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => { void runAutosave(); }, 3000);
}
async function runAutosave() {
  if (!store.dirty || autosaveSaving) return; // 没有未保存改动：什么都不做
  autosaveSaving = true;
  try {
    await saveProject(true);
  } finally {
    autosaveSaving = false;
    if (store.dirty) scheduleAutosave();
  }
}

/* ============ 工作流运行 ============ */
/** 图片/视频节点点击生成时：自动复制出一个新节点（提示词/参考图/上游连线一致），
 *  新的生成结果落在新节点里，原节点（含其上传图与已有结果）保持不动 */
function cloneForRerun(src) {
  store.pushHistory();
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = `n_${crypto.randomUUID().slice(0, 8)}`;
  copy.name = copyName(src.name);
  copy.position = { x: src.position.x + 40, y: src.position.y + 40 };
  copy.status = 'idle';
  copy.progress = 0;
  copy.taskId = null;
  copy.error = null;
  copy.outputs = [{ name: src.outputs?.[0]?.name || 'out', resourceId: null, url: null }];
  copy.history = []; // 新节点从空历史开始（旧结果留在原节点）
  delete copy.resultText;
  store.nodes.set(copy.id, copy);
  // 上游连线一并接回新节点（提示词里引用的上游引用也随 params 保留）
  for (const e of store.edges.values()) {
    if (e.target === src.id) store.addEdge(e.source, copy.id, e.sourcePort, e.targetPort);
  }
  store.selection.clear();
  store.selection.add(copy.id);
  store.dirty = true;
  store.emit({ type: 'node_added', node: copy });
  store.emit({ type: 'selection' });
  return copy;
}

export async function runSingleNode(nodeId) {
  let node = store.getNode(nodeId);
  if (!node) return;
  if (node.type !== 'media' && !(node.params?.prompt || '').trim() && !node.params?.refResourceId) {
    toast('请先输入提示词', 'err');
    return;
  }
  // @引用先解析成连线（与整体运行一致），否则参考图不会随子图提交给生成模型
  const refRes = resolveReferences();
  if (refRes.linked) toast(`已根据 @引用 自动建立 ${refRes.linked} 条连线`);
  if (refRes.rejected?.length) {
    toast(`引用失败：${refRes.rejected[0]}${refRes.rejected.length > 1 ? `（共 ${refRes.rejected.length} 处）` : ''}`, 'err');
  }
  // 图片/视频：与该节点上次生成的配置（提示词+参考）相同 → 就地重跑，生成历史累积在同一节点；
  // 配置变了 → 先找画布上用相同配置生成过的其他节点复用，找不到才复制新节点
  if (node.type === 'image' || node.type === 'video') {
    const k = historyKey(node);
    if (node.lastRunKey !== k) {
      let best = null;
      for (const cand of store.nodes.values()) {
        if (cand.id === node.id || cand.type !== node.type) continue;
        if (cand.lastRunKey !== k) continue;
        if (!best || (cand.lastRunAt || 0) > (best.lastRunAt || 0)) best = cand;
      }
      if (best) {
        node = best;
        store.selection.clear();
        store.selection.add(node.id);
        store.emit({ type: 'selection' });
        renderOne(node);
        toast(`与「${node.name}」提示词/参考相同，生成结果将累积到该节点历史`);
      } else if (generatedBefore(node)) {
        node = cloneForRerun(node);
        toast(`提示词/参考已变化，生成结果放入新节点「${node.name}」，原节点历史保留`);
      }
    }
  }
  node.lastRunKey = historyKey(node); // 记住本次生成配置，下次比对
  node.lastRunAt = Date.now(); // 多个相同配置节点时优先复用最近用过的
  store.dirty = true;
  const sub = collectSubgraph(node.id);
  // 上游节点已有结果 → 只播种传给下游、不重跑（点视频生成不应连图片也重新生成）；
  // 没有结果的上游仍会执行（如 @ 引用的图片节点还没生成过，视频需要它先出图）
  const nodes = sub.nodes.map((n) =>
    n.id === node.id ? n : { ...n, seedOnly: !!n.outputs?.[0]?.resourceId }
  );
  await submitRun(nodes, sub.edges);
}

/** 生成配置指纹：提示词 + 上传参考图 + @引用上游连线（相同 → 结果归同一节点） */
function historyKey(n) {
  return JSON.stringify([
    (n.params?.prompt || '').trim(),
    n.params?.refResourceId || null,
    [...(store.upstreamOf(n.id) || [])].sort().join(','),
  ]);
}
function generatedBefore(n) {
  return !!(n.outputs?.[0]?.url || (n.history && n.history.length));
}

export async function runWorkflow() {
  if (!store.nodes.size) { toast('画布为空，先创建节点（双击画布）', 'err'); return; }

  // @引用自动连线；超限等失败原因立即提示（@ 不成功）
  const refRes = resolveReferences();
  if (refRes.linked) toast(`已根据 @引用 自动建立 ${refRes.linked} 条连线`);
  if (refRes.rejected?.length) {
    toast(`引用失败：${refRes.rejected[0]}${refRes.rejected.length > 1 ? `（共 ${refRes.rejected.length} 处）` : ''}`, 'err');
  }

  const v = validateGraph();
  if (!v.ok) { toast(v.reason, 'err'); return; }

  const nodes = [...store.nodes.values()];
  const edges = [...store.edges.values()];
  const r = topoSort(nodes, edges);
  if (r.error) { toast(r.error, 'err'); return; }

  await submitRun(nodes, edges);
}

async function submitRun(nodes, edges) {
  try {
    const res = await api.runWorkflow(nodes, edges);
    toast(`工作流已提交（${res.order.length} 个节点，消耗 ✦${res.creditsCost}）`);
    document.getElementById('creditsNum').textContent = res.creditsLeft;
  } catch (e) {
    toast(e.data?.cycle ? `${e.message}：${e.data.cycle.join(' → ')}` : e.message, 'err');
  }
}

/* ============ SSE 任务事件 → 节点状态 ============ */
function onTaskEvent(evt) {
  switch (evt.type) {
    case 'node_status': {
      const node = store.getNode(evt.nodeId);
      if (!node) break;
      node.status = evt.status;
      node.progress = evt.progress ?? node.progress;
      if (evt.status === 'success') node.progress = 100;
      if (evt.taskId) node.taskId = evt.taskId;
      const el = document.querySelector(`.canvas-node[data-id="${evt.nodeId}"]`);
      if (el) {
        el.dataset.status = evt.status;
        const st = el.querySelector('.nt-status');
        if (st) {
          st.textContent = { running: '生成中', failed: '失败', skipped: '跳过' }[evt.status] || '';
          if (evt.status === 'running' && evt.taskId) {
            st.textContent = '生成中';
            st.title = `任务ID: ${evt.taskId}`;
          }
        }
        el.querySelector('.nt-progress').textContent = evt.status === 'running' ? (node.progress || 0) + '%' : '';
        if (evt.status === 'running') el.querySelector('.progress-bar')?.style.setProperty('width', (node.progress || 0) + '%');
        // 生成中即显示节点级取消按钮（任务 ID 尚未建立时点击 → 服务端预取消，任务建立后立即中止）
        const titleBar = el.querySelector('.node-title');
        let cancelBtn = el.querySelector('.nt-cancel');
        if (evt.status === 'running' && titleBar) {
          if (!cancelBtn) {
            cancelBtn = document.createElement('span');
            cancelBtn.className = 'nt-cancel';
            cancelBtn.title = '取消生成';
            cancelBtn.textContent = '✕';
            cancelBtn.addEventListener('pointerdown', (ev) => ev.stopPropagation());
            cancelBtn.addEventListener('click', async (ev) => {
              ev.stopPropagation();
              const prevText = st?.textContent || '';
              if (st) st.textContent = '取消中…';
              try {
                const r = await api.cancelNodeTask(node.id);
                if (r?.ok) {
                  toast(r.pending ? '任务提交中，已登记预取消（建立后立即取消）' : '已取消生成');
                } else {
                  // 远端（Seedance）取消失败：节点继续运行，恢复状态文案
                  if (st) st.textContent = prevText || '生成中';
                  toast(`取消失败：${r?.error || '未知原因'}，任务继续运行`, 'err');
                }
              } catch (e) {
                if (st) st.textContent = prevText || '生成中';
                toast('取消失败：' + e.message, 'err');
              }
            });
            titleBar.appendChild(cancelBtn);
          }
        } else if (cancelBtn) {
          cancelBtn.remove();
          if (st) st.title = '';
        }
        if (evt.status === 'failed') {
          st && (st.textContent = /取消/.test(evt.error || '') ? '已取消' : '失败');
          st && (st.title = evt.error || '');
          node.status = 'failed';
          node.error = evt.error || '';
        }
      }
      break;
    }
    case 'node_result': {
      const node = store.getNode(evt.nodeId);
      if (!node) break;
      // 旧结果滚入本节点历史（同提示词/参考的生成历史都归到同一节点）
      const old = node.outputs[0];
      if (old?.url && old.url !== evt.url) {
        node.history = node.history || [];
        if (!node.history.some((h) => h.url === old.url)) {
          node.history.push({ ...old, ts: Date.now() });
          if (node.history.length > 20) node.history = node.history.slice(-20); // 最多留 20 条
        }
      }
      node.outputs[0] = {
        name: node.outputs[0]?.name || 'out',
        resourceId: evt.resourceId, url: evt.url, kind: evt.kind,
        mime: evt.mime || (evt.kind === 'video' ? 'video/mp4' : ''),
        mock: !!evt.mock,
      };
      if (evt.text) node.resultText = evt.text;
      if (node.params) node.params.pinned = node.params.pinned; // 保持
      node.status = 'success';
      renderOne(node);
      renderEdges();
      // 有结果后，下游节点的面板自动带出该图片缩略图（同步刷新）
      refreshDownstreamPanels([...store.edges.values()].filter((e) => e.source === node.id).map((e) => e.target));
      break;
    }
    case 'workflow_done':
      toast('工作流执行完成 ✅', 'ok');
      store.dirty = true;
      scheduleAutosave();
      break;
    case 'workflow_error':
      toast('工作流错误：' + evt.error, 'err');
      break;
    case 'workflow_cancelled':
      toast('工作流已取消');
      break;
  }
}

/* ============ 旧数据兼容：探测历史视频输出的真实类型 ============ */
/** 早期版本的素材 URL 不带扩展名、mime 笼统为 video/*，无法区分「模拟占位图」和「真实视频」。
 *  加载项目后对这类输出做一次 HEAD 探测，按服务端返回的真实 content-type 修正并重渲染。 */
async function fixupVideoMimes() {
  for (const n of store.nodes.values()) {
    const out = n.outputs?.[0];
    if (!out || out.kind !== 'video' || !out.url) continue;
    if (/\.(svg|mp4|webm|mov)$/i.test(out.url)) continue;               // 新数据：URL 已带扩展名
    if (out.mime && /^(video|image)\//.test(out.mime) && out.mime !== 'video/*') continue; // mime 已明确
    try {
      const res = await fetch(out.url, { method: 'HEAD' });
      const ct = (res.headers.get('content-type') || '').split(';')[0];
      if (ct && /^(video|image)\//.test(ct)) {
        out.mime = ct;
        renderOne(n);
      }
    } catch { /* 探测失败保持原样 */ }
  }
}

/* ============ 资产库 ============ */
let assetPickCb = null;

export function openAssetPicker(cb) {
  assetPickCb = cb || null;
  const panel = document.getElementById('assetPanel');
  panel.classList.remove('hidden');
  loadAssets();
}

function bindAssetPanel() {
  document.getElementById('assetClose').addEventListener('click', () => {
    document.getElementById('assetPanel').classList.add('hidden');
    assetPickCb = null;
  });
}

async function loadAssets() {
  const grid = document.getElementById('assetGrid');
  try {
    const { assets } = await api.listAssets();
    grid.innerHTML = assets.length ? '' : '<div class="dd-empty" style="grid-column:1/-1">暂无素材</div>';
    for (const a of assets) {
      const isMedia = /^(image|video|audio)\//.test(a.mime) || /\.(svg|png|jpe?g|webp|gif)$/i.test(a.name);
      const preview = a.mime.startsWith('video')
        ? `<video src="${a.url}" muted preload="metadata"></video>`
        : isMedia ? `<img src="${a.url}">` : `<div style="height:90px;display:flex;align-items:center;justify-content:center;color:var(--text-dim)">📄</div>`;
      const div = document.createElement('div');
      div.className = 'ap-item';
      div.innerHTML = preview +
        `<div class="ap-name">${escapeHtml(a.name)}</div>`;
      div.addEventListener('click', () => {
        if (assetPickCb) {
          assetPickCb(a);
          assetPickCb = null;
          document.getElementById('assetPanel').classList.add('hidden');
        } else {
          createMediaNode({ url: a.url, name: a.name, mime: a.mime });
          document.getElementById('assetPanel').classList.add('hidden');
        }
      });
      grid.appendChild(div);
    }
  } catch (e) {
    grid.innerHTML = `<div class="dd-empty" style="grid-column:1/-1">${escapeHtml(e.message)}</div>`;
  }
}

/* ============ AI 对话 ============ */
function bindAiChat() {
  const panel = document.getElementById('aiPanel');
  document.getElementById('aiToggle').addEventListener('click', () => panel.classList.toggle('hidden'));
  const input = document.getElementById('aiInput');
  const msgs = document.getElementById('aiMsgs');
  const send = () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    addMsg(text, 'user');
    setTimeout(() => addMsg(interpret(text), 'bot'), 250);
  };
  document.getElementById('aiSend').addEventListener('click', send);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  document.querySelectorAll('.ai-tips span').forEach((s) => {
    s.addEventListener('click', () => { input.value = s.dataset.cmd; send(); });
  });
  function addMsg(text, who) {
    const div = document.createElement('div');
    div.className = 'ai-msg ' + who;
    div.textContent = text;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
  }
  addMsg('你好！我是画布 AI 助手。可以让我创建节点、连线、修改提示词、运行工作流。输入"帮助"查看指令。', 'bot');
}

/* ============ 通用 ============ */
function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderAll() {
  fullRender();
  renderEdges();
  renderMinimap();
}

init();
