// ============================================================
// nodes/nodeDom.js — 节点 DOM 渲染：标题栏 / 卡片 / 端口 / 提示词面板
// ============================================================
import { store } from '../store.js';
import { NODE_TYPES, icon, modelsOf, escapeRegExp, validateVideoRefs, validateEdgeTypes } from './nodeRegistry.js';
import { camera } from '../canvas/camera.js';
import { renderGroups } from '../canvas/groupRenderer.js';
import { api } from '../services/api.js';

const nodeLayer = () => document.getElementById('nodeLayer');
const els = new Map(); // nodeId -> DOM element

/** 面板内改动只置 dirty 不发 store 事件 → 手动触发自动保存计时 */
const autosaveSoon = () => { import('../main.js').then((m) => m.scheduleAutosave()).catch(() => {}); };

export function getNodeEl(id) { return els.get(id); }

/* ================= 渲染 ================= */

export function fullRender() {
  nodeLayer().innerHTML = '';
  els.clear();
  for (const node of store.nodes.values()) {
    nodeLayer().appendChild(buildNode(node));
  }
  applyPositions();
  updateEmptyHint();
}

export function renderOne(node) {
  const old = els.get(node.id);
  if (old) { old.remove(); els.delete(node.id); }
  const el = buildNode(node);
  nodeLayer().appendChild(el);
  els.set(node.id, el);
  positionNode(node);
  updateEmptyHint();
}

export function removeEl(id) {
  els.get(id)?.remove();
  els.delete(id);
  updateEmptyHint();
}

export function applyPositions() {
  const s = store.camera.scale, cx = store.camera.x, cy = store.camera.y;
  for (const node of store.nodes.values()) positionNode(node, s, cx, cy);
  renderGroups(); // 分组边框跟随节点/相机刷新
}

function positionNode(node, s = store.camera.scale, cx = store.camera.x, cy = store.camera.y) {
  const el = els.get(node.id);
  if (!el) return;
  el.style.transform = `translate(${node.position.x * s + cx}px, ${node.position.y * s + cy}px) scale(${s})`;
}

export function updateEmptyHint() {
  const hint = document.getElementById('emptyHint');
  hint.classList.toggle('gone', store.nodes.size > 0);
}

/* ================= 节点 DOM 构建 ================= */

function buildNode(node) {
  const def = NODE_TYPES[node.type] || NODE_TYPES.image;
  const el = document.createElement('div');
  el.className = 'canvas-node' + (store.selection.has(node.id) ? ' selected' : '') + (node.params?.pinned ? ' pinned' : '');
  el.dataset.id = node.id;
  el.dataset.type = node.type;
  el.dataset.status = node.status || 'idle';
  el.style.setProperty('--node-w', node.width + 'px');
  // 拉大模式：卡片整体放大 1.7 倍（宽度存在 node.width 上，随连线/框选同步）
  el.style.setProperty('--card-h', Math.round(def.cardH * (node.params?.big ? 1.7 : 1)) + 'px');
  el.innerHTML = `
    <div class="node-title">
      <span class="nt-icon">${icon(def.icon)}</span>
      <span class="nt-name" title="双击重命名">${escapeHtml(node.name)}</span>
      <span class="nt-status">${statusLabel(node.status)}</span>
      <span class="nt-progress">${node.progress ? node.progress + '%' : ''}</span>
      ${node.outputs?.[0]?.url ? `<span class="nt-dl" data-act="download" title="下载结果"><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M8 2v7.2M8 9.2 5.2 6.4M8 9.2l2.8-2.8M3 12.5h10" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></span>` : ''}
      <span class="nt-pin" title="固定面板">${icon('pin')}</span>
    </div>
    <div class="node-frame">
      ${def.hasInput ? `<div class="node-port port-in" title="输入端口"><span>＋</span></div>` : ''}
      <div class="node-card">${buildCard(node)}</div>
      <div class="node-port port-out" title="输出端口"><span>＋</span></div>
    </div>
    ${buildPanel(node)}
  `;
  els.set(node.id, el);
  bindNodeEvents(el, node);
  return el;
}

function statusLabel(s) {
  // 生成成功不显示「完成」提示
  return { running: '生成中', failed: '失败', skipped: '跳过' }[s] || '';
}

/* ---------- 卡片内容 ---------- */
export function buildCard(node) {
  const out = node.outputs?.[0];
  const hasResult = out && out.url;

  if (node.status === 'running') {
    return `<div class="card-empty">${icon('empty' + cap(node.type))}</div><div class="progress-bar" style="width:${node.progress || 5}%"></div>`;
  }
  if (hasResult) {
    const mime = out.mime || '';
    if (out.kind === 'audio') return `<audio controls src="${out.url}"></audio>`;
    // 视频：mime 为 image/* 或 URL 带 .svg → 是模拟占位图（非真实视频流），按图片渲染
    const isMockVideo = out.kind === 'video' && (mime.startsWith('image/') || out.url.endsWith('.svg'));
    if (out.kind === 'video' && !isMockVideo) return `${cardActs(node)}<video src="${out.url}" controls></video>${historyStrip(node)}`;
    if (out.kind === 'text' || out.kind === 'json') {
      return `<div class="text-content">${escapeHtml(node.resultText || out.textContent || '(结构化结果，已存入资产库)')}</div>`;
    }
    const playBadge = isMockVideo ? '<span class="card-badge">▶ 模拟占位（未配置 API Key）</span>' : out.kind === 'video' ? '<span class="card-badge">▶ 视频预览</span>' : '';
    return `${playBadge}<img src="${out.url}" draggable="false" alt="">${cardActs(node)}${historyStrip(node)}`;
  }
  switch (node.type) {
    case 'text':
      return `<div class="text-content">${escapeHtml(node.params?.prompt || '')}</div>`;
    case 'media':
      return node.params?.url
        ? `<img src="${node.params.url}" draggable="false">`
        : `<div class="card-empty">${icon('emptyImage')}</div>`;
    case 'timeline':
      return `<div class="text-content" style="color:var(--text-dim)">将上游视频/图片按时间轴编排。\n连接节点后运行自动生成时间线。</div>`;
    case 'director':
      return `<div class="text-content" style="color:var(--text-dim)">全局分镜调度台。\n@引用图片/视频/音频节点，运行后输出分镜脚本。</div>`;
    case 'image':
    case 'video':
      // 未生成时：卡片方框内直接显示已上传的参考图
      if (node.params?.refUrl) return `<img class="card-refimg" src="${node.params.refUrl}" draggable="false" alt="">`;
      return `<div class="card-empty">${icon('empty' + cap(node.type))}</div>`;
    default:
      return `<div class="card-empty">${icon('empty' + cap(node.type))}</div>`;
  }
}
const cap = (s) => ({ text: 'Text', image: 'Image', video: 'Video', audio: 'Audio' }[s] || 'Image');

/** 结果卡片右上角悬浮操作：拉大（1.7x）/ 全屏预览 / 视频抽帧（hover 显示） */
function cardActs(node) {
  const big = node.params?.big;
  const out = node.outputs?.[0];
  // 真实视频结果（非模拟占位图）→ 额外提供抽帧入口
  const isRealVideo = node.type === 'video' && out?.url && out.kind === 'video'
    && !(String(out.mime || '').startsWith('image/') || String(out.url || '').endsWith('.svg'));
  const frameBtn = isRealVideo ? '\n    <button class="ca-btn" data-act="frames" title="提取视频帧">🎞</button>' : '';
  return `<div class="card-acts">
    <button class="ca-btn" data-act="zoom-card" title="${big ? '还原卡片大小' : '拉大卡片'}">${big ? '⤡' : '⤢'}</button>
    <button class="ca-btn" data-act="fullscreen" title="全屏预览">⛶</button>${frameBtn}
  </div>`;
}

/** 节点生成历史条：本节点下同提示词/参考的历次生成结果（左上角小缩略图，点击切换主显示） */
function historyStrip(node) {
  const out = node.outputs?.[0];
  const hist = node.history || [];
  if (!hist.length || !out?.url) return '';
  const items = hist.slice(-10); // 条上最多展示最近 10 个
  const chips = items.map((h, i) => {
    const idx = hist.length - items.length + i + 1;
    const cur = h.url === out.url ? ' ch-cur' : '';
    const isVid = h.kind === 'video' && !(h.mime || '').startsWith('image/') && !String(h.url).endsWith('.svg');
    return isVid
      ? `<span class="ch-item ch-video${cur}" data-hurl="${h.url}" title="历史视频 #${idx}（点击切换显示）">▶${idx}</span>`
      : `<img class="ch-item${cur}" data-hurl="${h.url}" src="${h.url}" title="历史 #${idx}（点击切换显示）" draggable="false" alt="">`;
  }).join('');
  return `<div class="card-history">${chips}<span class="ch-count" title="本节点共生成 ${hist.length + 1} 次">⏱${hist.length + 1}</span></div>`;
}

/* ---------- 全屏预览（lightbox） ---------- */
let lightboxEsc = null;

/** 全屏放大预览：图片原样放大、视频用完整播放器（自动播放/循环/可拖进度）；点遮罩、✕ 或 Esc 关闭 */
function openLightbox(node) {
  closeLightbox();
  const out = node.outputs?.[0];
  if (!out?.url) return;
  const isMockVideo = out.kind === 'video' && ((out.mime || '').startsWith('image/') || out.url.endsWith('.svg'));
  const media = out.kind === 'video' && !isMockVideo
    ? `<video src="${out.url}" controls autoplay loop></video>`
    : `<img src="${out.url}" alt="">`;
  const lb = document.createElement('div');
  lb.id = 'lightbox';
  lb.innerHTML = `
    <div class="lb-inner">
      <div class="lb-title">${escapeHtml(node.name)}<span class="lb-sub">${out.kind === 'video' ? ' · 视频预览' : ' · 图片预览'}</span></div>
      ${media}
    </div>
    <button class="lb-close" title="关闭 (Esc)">✕</button>`;
  document.body.appendChild(lb);
  lb.addEventListener('click', (e) => {
    if (e.target === lb || e.target.closest('.lb-close')) closeLightbox();
  });
  lightboxEsc = (e) => { if (e.key === 'Escape') closeLightbox(); };
  document.addEventListener('keydown', lightboxEsc);
}

export function closeLightbox() {
  document.getElementById('lightbox')?.remove();
  if (lightboxEsc) { document.removeEventListener('keydown', lightboxEsc); lightboxEsc = null; }
}

/* ---------- 提示词面板 ---------- */
function buildPanel(node) {
  const def = NODE_TYPES[node.type] || NODE_TYPES.image;
  // 多选时不渲染提示词面板（仅单选或固定钉住时显示）
  const show = (store.selection.has(node.id) && store.selection.size === 1) || node.params?.pinned;
  if (!show) return '';
  const p = node.params || {};

  if (node.type === 'media') return '';

  // 参考图区：手动上传的参考图 + 上游连线自动带出的图片/视频/音频缩略图（带序号，✕ 断开连线，⇧ 入库过审）
  const arkRefs = p.arkRefs || {};
  const arkBadge = (rid) => arkRefs[rid]?.status === 'Active'
    ? '<span class="ark-ok" title="已入库过审（AI虚拟库 Active）">✓</span>'
    : '';
  const manualThumb = p.refUrl
    ? `<div class="pp-ref-thumb" data-act="ref-view" title="点击查看大图"><img src="${p.refUrl}">${arkBadge(p.refResourceId)}<span class="rm" data-act="ref-clear" title="移除参考图">✕</span></div>`
    : '';
  const autoThumbs = upstreamRefs(node).map((r, i) => {
    const badge = arkBadge(r.resourceId);
    const ing = r.resourceId && !badge
      ? `<span class="ark-ing" data-act="ark-ingest" data-rid="${r.resourceId || ''}" title="上传到 AI 虚拟库过审（入库后用 asset:// 引用）">⇧</span>`
      : '';
    const inner = r.kind === 'video'
      ? '<span class="vid-chip">▶ 视频</span>'
      : r.kind === 'audio'
        ? '<span class="vid-chip">♪ 音频</span>'
        : `<img src="${r.url}">`;
    const cls = r.kind === 'image' ? '' : ` is-${r.kind}`;
    return `<div class="pp-ref-thumb auto${cls}" title="来自「${escapeHtml(r.name)}」的连线${r.kind === 'image' ? '' : `（${r.kind === 'video' ? '视频' : '音频'}参考）`}">${inner}<span class="ref-idx">${i + 1}</span>${badge}${ing}<span class="rm" data-act="ref-edge" data-edge="${r.edgeId}" title="断开此连线">✕</span></div>`;
  }).join('');
  const refArea = ['image', 'video'].includes(node.type)
    ? manualThumb + autoThumbs + `<button class="pp-add-btn" data-act="ref-add" title="添加参考图">＋</button>`
    : '';

  let bottom = '';
  if (node.type === 'image') {
    const models = modelsOf('image');
    bottom = `
      ${selHtml(models, p.model, 'model')}
      <span class="pp-dot">•</span>${selSimple(['1:1', '3:4', '4:3', '16:9', '9:16'], p.ratio, 'ratio')}
      <span class="pp-dot">•</span>${selSimple(['1K', '2K', '4K'], p.size, 'size')}
      <span class="pp-dot">•</span>${selSimple([1, 2, 4], p.count, 'count')}
      <button class="pp-at" data-act="at" title="输入 @节点名 引用画布内容">@</button>
      <span class="pp-credits"><span class="spark">✦</span>${creditsOf('image', p.model)} / 张</span>
      ${genBtn()}`;
  } else if (node.type === 'video') {
    const models = modelsOf('video');
    bottom = `
      ${selHtml(models, p.model, 'model')}
      <span class="pp-dot">•</span>${selSimple(['文生视频', '全能参考', '编辑视频', '延长视频'], p.mode, 'mode')}
      <span class="pp-dot">•</span>${selSimple(['16:9', '9:16', '1:1', '4:3'], p.ratio, 'ratio')}
      <span class="pp-dot">•</span>${selSimple(['480P', '720P', '1080P'], p.resolution, 'resolution')}
      ${durControl(node, p)}
      <button class="pp-at" data-act="at" title="输入 @节点名 引用画布内容">@</button>
      <span class="pp-credits"><span class="spark">✦</span>${creditsOf('video', p.model)}</span>
      ${genBtn()}`;
  } else if (node.type === 'audio') {
    bottom = `
      ${selHtml(modelsOf('audio'), p.model, 'model')}
      <span class="pp-dot">•</span>${selSimple([2, 3, 5, 10], p.duration, 'duration', 's')}
      <button class="pp-audio-up" data-act="audio-upload" title="上传本地音频（时长需在 2~8 秒之间）">⇧ 上传</button>
      <span class="pp-credits"><span class="spark">✦</span>${creditsOf('audio', p.model)}</span>
      ${genBtn()}`;
  } else if (node.type === 'text') {
    bottom = `
      ${selHtml(modelsOf('text'), p.model, 'model')}
      <span class="pp-credits"><span class="spark">✦</span>${creditsOf('text', p.model)}</span>
      ${genBtn('扩写')}`;
  } else if (node.type === 'subject') {
    bottom = `<input class="pp-select" style="width:120px" data-param="name" value="${escapeHtml(p.name || '')}" placeholder="主体名称"/>
      <span class="pp-credits"><span class="spark">✦</span>5 / 次</span>${genBtn('固化形象')}`;
  } else {
    bottom = `<span class="pp-credits" style="margin-left:0">编排节点：连接上游后由「运行」统一调度</span>${genBtn('执行编排')}`;
  }

  return `
  <div class="prompt-panel">
    <div class="pp-top">
      ${refArea}
      <button class="pp-expand" data-act="expand" title="展开/收起">⤢</button>
    </div>
    <div class="pp-ta-wrap">
      <div class="pp-hl" aria-hidden="true"></div>
      <textarea rows="2" data-act="prompt" placeholder="${escapeHtml(def.placeholder)}">${escapeHtml(p.prompt || '')}</textarea>
    </div>
    <div class="pp-bottom">${bottom}</div>
  </div>`;
}

/* ---------- @引用芯片：高亮显示 + 整体删除 + 方向键跨块 ---------- */
function mentionNames() {
  return [...store.nodes.values()].map((n) => n.name).filter(Boolean).sort((a, b) => b.length - a.length);
}

/** 同步高亮层：把提示词里的 @节点名 渲染成彩色芯片 */
function syncHighlight(el, node) {
  const hl = el.querySelector('.pp-hl');
  const ta = el.querySelector('.prompt-panel textarea');
  if (!hl || !ta) return;
  const text = node?.params?.prompt ?? ta.value ?? '';
  const names = mentionNames();
  let html = '';
  if (names.length && text.includes('@')) {
    const re = new RegExp('@(' + names.map(escapeRegExp).join('|') + ')(?=[\\s@，。,.;；:：]|$)', 'g');
    let last = 0;
    for (const m of text.matchAll(re)) {
      html += escapeHtml(text.slice(last, m.index)) + `<b class="mchip">${escapeHtml(m[0])}</b>`;
      last = m.index + m[0].length;
    }
    html += escapeHtml(text.slice(last));
  } else {
    html = escapeHtml(text);
  }
  hl.innerHTML = html + '<br>';
  hl.scrollTop = ta.scrollTop;
}

/** 光标前方是否紧邻一个 @引用（用于 Backspace / ← 整块处理） */
function mentionEndAt(text, pos) {
  for (const name of mentionNames()) {
    const start = pos - name.length - 1;
    if (start < 0 || text.slice(start, pos) !== '@' + name) continue;
    if (start === 0 || /[\s@，。,.;；:：]/.test(text[start - 1])) return { start, end: pos };
  }
  return null;
}
/** 光标后方是否紧邻一个 @引用（用于 Delete / → 整块处理） */
function mentionStartAt(text, pos) {
  if (text[pos] !== '@') return null;
  for (const name of mentionNames()) {
    const end = pos + name.length + 1;
    if (text.slice(pos, end) !== '@' + name) continue;
    if (end >= text.length || /[\s@，。,.;；:：]/.test(text[end])) return { start: pos, end };
  }
  return null;
}

function selHtml(models, val, param) {
  return `<select class="pp-select" data-param="${param}">` +
    models.map((m) => `<option value="${m.id}" ${m.id === val ? 'selected' : ''}>${escapeHtml(m.name)}${m.name.includes('VIP') ? ' ✦' : ''}</option>`).join('') +
    `</select>`;
}
function selSimple(opts, val, param, suffix = '') {
  return `<select class="pp-select" data-param="${param}">` +
    opts.map((o) => `<option value="${o}" ${String(o) === String(val) ? 'selected' : ''}>${o}${suffix}</option>`).join('') +
    `</select>`;
}

/** 视频时长控件：滑动条 + 数字输入 双模式，范围随模型（2.0: 4-15s，2.5: 4-30s） */
function durControl(node, p) {
  const m = modelsOf('video').find((x) => x.id === p.model) || modelsOf('video')[0] || {};
  const min = m.minDur ?? 4, max = m.maxDur ?? 15;
  const val = Math.min(max, Math.max(min, Number(p.duration) || min));
  return `<span class="pp-dur" style="display:inline-flex;align-items:center;gap:5px">
    <input type="range" class="pp-dur-range" min="${min}" max="${max}" step="1" value="${val}" style="width:86px;accent-color:#4da3ff">
    <input type="number" class="pp-dur-num" min="${min}" max="${max}" step="1" value="${val}" style="width:52px;background:var(--bg-card);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:4px 6px;font-size:12px;outline:none"><span style="color:var(--text-dim);font-size:12px">s</span>
  </span>`;
}
function creditsOf(kind, modelId) {
  const m = modelsOf(kind).find((x) => x.id === modelId) || modelsOf(kind)[0];
  return m?.credits ?? 1;
}
function genBtn(label = '') {
  return `<button class="pp-generate" data-act="generate" title="生成">${label || '↑'}</button>`;
}

/* ---------- 事件 ---------- */
function bindNodeEvents(el, node) {
  // 静默更新参数（不触发重渲染，避免输入焦点丢失）
  const setParam = (k, v) => {
    const n = store.getNode(node.id);
    if (!n) return;
    n.params = n.params || {};
    n.params[k] = v;
    store.dirty = true; autosaveSoon();
  };

  const taBind = el.querySelector('.prompt-panel textarea');
  taBind?.addEventListener('input', (e) => {
    setParam('prompt', e.target.value);
    syncHighlight(el, store.getNode(node.id));
    handleMentionInput(e, node.id);
  });
  // 高亮层跟随滚动
  taBind?.addEventListener('scroll', () => {
    const hl = el.querySelector('.pp-hl');
    if (hl) hl.scrollTop = taBind.scrollTop;
  });
  // @引用整体化：Backspace/Delete 删除整块，←/→ 跨块移动
  taBind?.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' || e.key === 'ArrowLeft') {
      const pos = taBind.selectionStart;
      if (taBind.selectionStart === taBind.selectionEnd && pos > 0) {
        // 光标前紧邻芯片；或隔着刚补全时加的一个空格（整体删除时连空格一起删）
        const m = mentionEndAt(taBind.value, pos)
          || (taBind.value[pos - 1] === ' ' ? mentionEndAt(taBind.value, pos - 1) : null);
        if (m) {
          e.preventDefault();
          if (e.key === 'Backspace') {
            taBind.setRangeText('', m.start, pos, 'end');
            setParam('prompt', taBind.value);
            syncHighlight(el, store.getNode(node.id));
            taBind.dispatchEvent(new Event('input', { bubbles: true }));
          } else {
            taBind.setSelectionRange(m.start, m.start);
          }
        }
      }
    } else if (e.key === 'Delete' || e.key === 'ArrowRight') {
      const pos = taBind.selectionStart;
      if (taBind.selectionStart === taBind.selectionEnd) {
        const m = mentionStartAt(taBind.value, pos);
        if (m) {
          e.preventDefault();
          if (e.key === 'Delete') {
            taBind.setRangeText('', pos, m.end, 'end');
            setParam('prompt', taBind.value);
            syncHighlight(el, store.getNode(node.id));
            taBind.dispatchEvent(new Event('input', { bubbles: true }));
          } else {
            taBind.setSelectionRange(m.end, m.end);
          }
        }
      }
    }
  });
  // 初始渲染高亮
  syncHighlight(el, store.getNode(node.id));
  // 内联 @ 提及期间的键盘导航：↑↓ 选择、Enter 确认、Esc 关闭
  taBind?.addEventListener('keydown', (e) => {
    if (!mention || mention.ta !== e.target) return;
    // Esc 永远可关闭菜单（即使过滤后没有可选项）
    if (e.key === 'Escape') {
      e.preventDefault();
      closeAtMenu();
      return;
    }
    const items = [...mention.menu.querySelectorAll('.at-item')].filter((i) => i.style.display !== 'none');
    if (!items.length) return;
    const cur = items.findIndex((i) => i.classList.contains('hl'));
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[cur]?.classList.remove('hl');
      (items[cur + 1] || items[0]).classList.add('hl');
      (items[cur + 1] || items[0]).scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[cur]?.classList.remove('hl');
      (items[cur - 1] || items[items.length - 1]).classList.add('hl');
      (items[cur - 1] || items[items.length - 1]).scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      items[Math.max(cur, 0)]?.click();
    }
  });

  el.querySelectorAll('.pp-select, .prompt-panel input[data-param]').forEach((s) => {
    s.addEventListener('change', (e) => {
      const k = s.dataset.param;
      let v = e.target.value;
      if (k === 'count' || k === 'duration') v = Number(v);
      if (k === 'model') {
        const kind = node.type === 'image' ? 'image' : node.type;
        const m = modelsOf(kind).find((x) => x.id === v);
        const n2 = store.getNode(node.id);
        if (n2) {
          n2.params = n2.params || {};
          n2.params.model = v;
          n2.params.modelName = m?.name;
          // 切换视频模型时，把时长钳制到新模型的允许范围并刷新面板（滑动条范围随之变化）
          if (node.type === 'video' && m) {
            const min = m.minDur ?? 4, max = m.maxDur ?? 15;
            n2.params.duration = Math.min(max, Math.max(min, Number(n2.params.duration) || min));
            // 已有连线超出新模型参考上限时仅提示（不强制断开，用户可自行调整）
            const vr = validateVideoRefs(n2, [], store.upstreamOf(n2.id));
            if (!vr.ok) import('../main.js').then((mm) => mm.toast(vr.reason, 'err'));
          }
          store.dirty = true; autosaveSoon();
          renderOne(n2);
        }
        return;
      }
      setParam(k, v);
    });
  });

  // 视频时长：滑动条 ↔ 数字输入 双向同步，且始终钳制在当前模型范围内
  el.querySelectorAll('.pp-dur-range, .pp-dur-num').forEach((s) => {
    s.addEventListener('input', () => {
      const n = store.getNode(node.id);
      if (!n) return;
      const m = modelsOf('video').find((x) => x.id === n.params?.model) || {};
      const min = m.minDur ?? 4, max = m.maxDur ?? 15;
      const v = Math.min(max, Math.max(min, Math.round(Number(s.value)) || min));
      n.params = n.params || {};
      n.params.duration = v;
      store.dirty = true; autosaveSoon();
      const other = el.querySelector(s.classList.contains('pp-dur-range') ? '.pp-dur-num' : '.pp-dur-range');
      if (other && Number(other.value) !== v) other.value = v;
    });
  });

  el.querySelector('.nt-pin')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const n = store.getNode(node.id);
    n.params.pinned = !n.params.pinned;
    el.classList.toggle('pinned', n.params.pinned);
    renderOne(n);
  });

  // 下载结果（文件名 = 节点名）
  el.querySelector('.nt-dl')?.addEventListener('click', (e) => {
    e.stopPropagation();
    import('../main.js').then(({ downloadNodeResult }) => downloadNodeResult(store.getNode(node.id)));
  });

  // 生成历史条：点击历史缩略图 → 与当前主显示互换（可来回切换）
  el.querySelectorAll('.card-history .ch-item').forEach((chip) => {
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      const n = store.getNode(node.id);
      if (!n) return;
      const url = chip.dataset.hurl;
      const cur = n.outputs?.[0];
      const hit = (n.history || []).find((h) => h.url === url);
      if (!hit || !cur || cur.url === url) return;
      n.history = (n.history || []).filter((h) => h.url !== url);
      n.history.push({ ...cur, ts: Date.now() });
      n.outputs[0] = { ...hit };
      store.dirty = true;
      autosaveSoon();
      renderOne(n);
    });
  });

  // 卡片悬浮操作：拉大 / 全屏预览
  el.querySelectorAll('.card-acts .ca-btn').forEach((btn) => {    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const n = store.getNode(node.id);
      if (!n) return;
      if (btn.dataset.act === 'zoom-card') {
        const def = NODE_TYPES[n.type] || NODE_TYPES.image;
        n.params.big = !n.params.big;
        n.width = n.params.big ? Math.round(def.width * 1.7) : def.width;
        store.dirty = true;
        // node_updated → renderOne（卡片尺寸/按钮图标刷新）+ renderEdges（端口位置跟随宽度）
        store.emit({ type: 'node_updated', node: n });
      } else if (btn.dataset.act === 'fullscreen') {
        openLightbox(n);
      } else if (btn.dataset.act === 'frames') {
        import('./frames.js').then((m) => m.openFramePicker(n));
      }
    });
  });

  // 双击标题重命名；改名后 @引用 与 下载文件名 自动同步
  el.querySelector('.nt-name')?.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    startRename(el.querySelector('.nt-name'), node.id);
  });

  el.querySelector('.prompt-panel')?.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    e.stopPropagation();
    if (act === 'at') {
      // 与手动敲 @ 完全一致：光标处插入 @ 并就地弹出引用菜单
      const ta = el.querySelector('textarea');
      let pos = ta.selectionStart ?? ta.value.length;
      if (ta.value[pos - 1] !== '@') {
        ta.value = ta.value.slice(0, pos) + '@' + ta.value.slice(pos);
        ta.focus();
        ta.setSelectionRange(pos + 1, pos + 1);
        setParam('prompt', ta.value);
        pos += 1;
      }
      mention = { nodeId: node.id, start: pos - 1, ta };
      openAtMenuFromCaret(ta, node.id);
    } else if (act === 'ref-add') {
      openRefMenu(e.clientX, e.clientY, node.id);
    } else if (act === 'ref-clear') {
      setParam('refResourceId', null); setParam('refUrl', null);
      renderOne(store.getNode(node.id));
    } else if (act === 'ref-edge') {
      // ✕ 自动缩略图 = 断开对应上游连线
      const edgeId = e.target.closest('[data-edge]')?.dataset.edge;
      if (edgeId) { store.pushHistory(); store.removeEdge(edgeId); }
    } else if (act === 'ark-ingest') {
      ingestToArk(e.target.closest('[data-rid]')?.dataset.rid, node);
    } else if (act === 'expand') {
      const ta = el.querySelector('textarea');
      ta.style.minHeight = ta.style.minHeight === '160px' ? '44px' : '160px';
    } else if (act === 'audio-upload') {
      uploadLocalAudio(node);
    } else if (act === 'generate') {
      const { runSingleNode } = await import('../main.js');
      runSingleNode(node.id);
    }
  });

  // 右键节点 → 下一级菜单：新建下一级节点 / 重新生成 / 下载结果 / 复制 / 固定 / 删除
  el.addEventListener('contextmenu', async (e) => {
    if (e.target.closest('.prompt-panel textarea, .prompt-panel input, .pp-select')) return; // 文本输入区保留系统菜单
    e.preventDefault();
    e.stopPropagation();
    const { openCtxMenu, openNodeMenu, toast } = await import('../main.js');
    const n = store.getNode(node.id);
    if (!n) return;
    if (!store.selection.has(n.id)) { store.selection.clear(); store.selection.add(n.id); store.emit({ type: 'selection' }); }
    const items = [];
    // 新建下一级节点：只列出能接住本节点输出类型的节点，建好自动连线
    const targets = Object.keys(NODE_TYPES).filter((t) => validateEdgeTypes(n.type, t, n).ok);
    items.push({
      label: '新建下一级节点 ▸',
      act: (ev) => openNodeMenu({
        x: ev?.clientX ?? e.clientX, y: ev?.clientY ?? e.clientY,
        title: '新建下一级节点（自动连线）', highlight: targets, only: targets,
        onPick: (t) => {
          if (!targets.includes(t)) { toast(`「${NODE_TYPES[t]?.label || t}」不接受当前节点的输出类型`, 'err'); return null; }
          const created = store.addNode(t, { x: n.position.x + (n.width || 320) + 80, y: n.position.y });
          store.addEdge(n.id, created.id);
          toast(`已创建并连线到「${created.name}」`, 'ok');
          return created;
        },
      }),
    });
    if (['image', 'video', 'audio', 'text'].includes(n.type)) {
      items.push({ label: '重新生成', act: () => import('../main.js').then((m) => m.runSingleNode(n.id)) });
    }
    if (n.outputs?.[0]?.url) {
      items.push({ label: '下载结果', act: () => import('../main.js').then((m) => m.downloadNodeResult(n)) });
      // 视频结果 → 抽帧（首帧/均匀多帧），落到新建图片节点
      if (n.type === 'video') {
        items.push({
          label: '提取视频帧 ▸',
          act: (ev) => import('./frames.js').then((m) => m.openFrameMenu(ev?.clientX ?? e.clientX, ev?.clientY ?? e.clientY, store.getNode(n.id) || n)),
        });
      }
    }
    items.push({
      label: '复制节点',
      act: () => {
        store.pushHistory();
        import('../canvas/interaction.js').then((m) => {
          const cur = store.getNode(n.id);
          if (cur) { m.duplicateNode(cur); toast('已复制节点副本', 'ok'); }
        });
      },
    });
    items.push({
      label: n.params?.pinned ? '取消固定面板' : '固定面板',
      act: () => {
        const n2 = store.getNode(n.id);
        if (!n2) return;
        n2.params.pinned = !n2.params.pinned;
        renderOne(n2);
      },
    });
    items.push({ label: '删除节点', act: () => import('../canvas/interaction.js').then((m) => m.removeNodeWithConfirm(n.id)) });
    openCtxMenu(e.clientX, e.clientY, items);
  });
}

/* ---------- 音频节点：本地上传（时长 2~8 秒，超出提示上传失败） ---------- */

/* ---------- AI 虚拟库入库过审：素材上传到方舟私域素材库，轮询到 Active/Failed ----------
 * 入库成功后写入 node.params.arkRefs[resourceId] = { id, status }，
 * 生成视频时服务端优先用 asset://素材ID 引用（真人素材必须） */
async function ingestToArk(resourceId, node) {
  const toast = (msg, kind) => import('../main.js').then((m) => m.toast(msg, kind));
  if (!resourceId) { toast('该参考没有可入库的素材 ID', 'err'); return; }
  toast('正在上传到 AI 虚拟库过审…（最长约 2.5 分钟）');
  try {
    const r = await fetch('/api/ark-asset/ingest', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resourceId, name: node.name || 'canvas-asset' }),
    }).then((x) => x.json());
    if (!r.ok && !r.arkId) { toast('入库失败：' + (r.error || '未知错误'), 'err'); return; }
    store.pushHistory();
    const node2 = store.getNode(node.id);
    const refs = { ...(node2.params?.arkRefs || {}) };
    refs[resourceId] = { id: r.arkId, status: r.status };
    setParam('arkRefs', refs);
    store.emit({ type: 'node_updated', nodeId: node.id });
    if (r.status === 'Active') toast(`已入库过审 ✓ asset://${r.arkId}`, 'ok');
    else if (r.status === 'Failed') toast(`入库被驳回：${r.error || '审核未通过'}`, 'err');
    else toast('仍在过审中（Processing），稍后自动生效', 'warn');
  } catch (e) {
    toast('入库失败：' + e.message, 'err');
  }
}

function audioDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const a = new Audio();
    const done = (d) => { URL.revokeObjectURL(url); resolve(Number.isFinite(d) ? d : 0); };
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(a.duration);
    a.onerror = () => done(0);
    a.src = url;
  });
}

async function uploadLocalAudio(node) {
  const { toast } = await import('../main.js');
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'audio/*';
  inp.onchange = async () => {
    const file = inp.files?.[0];
    if (!file) return;
    const dur = await audioDuration(file);
    if (!(dur >= 2 && dur <= 8)) {
      toast(`上传失败：音频时长需在 2~8 秒之间（当前 ${dur ? dur.toFixed(1) + 's' : '无法识别'}）`, 'err');
      return;
    }
    try {
      const { api } = await import('../services/api.js');
      const res = await api.uploadFile(file);
      store.pushHistory();
      node.outputs = [{ name: 'audio', resourceId: res.id, url: res.url, kind: 'audio', mime: file.type || 'audio/mpeg', duration: Math.round(dur * 10) / 10 }];
      node.status = 'idle';
      store.dirty = true; autosaveSoon();
      renderOne(node);
      toast(`音频已上传（${dur.toFixed(1)}s），可连线给下游使用`, 'ok');
    } catch (err) {
      toast('上传失败：' + err.message, 'err');
    }
  };
  inp.click();
}

/* ---------- 重命名：双击标题 → 行内输入，回车/失焦提交 ---------- */
function startRename(nameEl, nodeId) {
  const node = store.getNode(nodeId);
  if (!node || nameEl.querySelector('input')) return;
  const oldName = node.name;
  nameEl.innerHTML = `<input class="nt-rename" value="${escapeHtml(oldName)}" spellcheck="false" />`;
  const input = nameEl.querySelector('input');
  input.focus();
  input.select();
  let finished = false;
  const commit = (cancel) => {
    if (finished) return;
    finished = true;
    const v = input.value.trim();
    if (cancel || !v || v === oldName) {
      nameEl.textContent = oldName;
      return;
    }
    applyRename(nodeId, oldName, v);
  };
  input.addEventListener('pointerdown', (e) => e.stopPropagation());
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('dblclick', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') input.blur();
    else if (e.key === 'Escape') { input.value = oldName; input.blur(); }
  });
  input.addEventListener('blur', () => commit(false));
}

/** 应用重命名：更新节点名，并同步所有提示词中的 @旧名 引用 */
function applyRename(nodeId, oldName, newName) {
  const node = store.getNode(nodeId);
  if (!node) return;
  node.name = newName;
  store.dirty = true; autosaveSoon();
  // 同步其它节点提示词里的 @旧名（后面跟分隔符或结尾才算完整引用）
  const esc = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let synced = 0;
  for (const n of store.nodes.values()) {
    const prompt = n.params?.prompt;
    if (!prompt || n.id === nodeId) continue;
    const re = new RegExp('@' + esc + '(?=[\\s@，。,.;；:：]|$)', 'g');
    if (re.test(prompt)) {
      n.params.prompt = prompt.replace(new RegExp('@' + esc + '(?=[\\s@，。,.;；:：]|$)', 'g'), '@' + newName);
      synced++;
      const el = els.get(n.id);
      if (el) {
        const ta = el.querySelector('.prompt-panel textarea');
        if (ta) ta.value = n.params.prompt;
      }
    }
  }
  renderOne(node);
  import('../main.js').then((m) => m.toast(
    synced ? `已重命名为「${newName}」，同步更新 ${synced} 处 @引用` : `已重命名为「${newName}」`, 'ok'));
}

/* ---------- 参考图菜单（截图 5）：上传图片 / 从资产库添加 / 从画布选择 ---------- */
let pickCallback = null;
let activeRefMenu = null;

function closeRefMenu() {
  activeRefMenu?.menu.remove();
  if (activeRefMenu) document.removeEventListener('pointerdown', activeRefMenu.dismiss);
  activeRefMenu = null;
}

function openRefMenu(x, y, nodeId) {
  closeRefMenu();
  const menu = document.createElement('div');
  menu.className = 'pp-ref-menu';
  menu.style.left = Math.min(x, window.innerWidth - 215) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - 130) + 'px';
  menu.innerHTML = `
    <div class="nm-item" data-r="upload"><span class="nm-icon">⬆</span>上传图片</div>
    <div class="nm-item" data-r="library"><span class="nm-icon">🗂</span>从资产库添加</div>
    <div class="nm-item" data-r="canvas"><span class="nm-icon">◎</span>从画布选择</div>`;
  document.body.appendChild(menu);

  // 菜单内部的 pointerdown 不冒泡到 document，避免被关闭逻辑吞掉
  menu.addEventListener('pointerdown', (e) => e.stopPropagation());
  const dismiss = (e) => { if (!menu.contains(e.target)) closeRefMenu(); };
  setTimeout(() => document.addEventListener('pointerdown', dismiss), 0);
  activeRefMenu = { menu, dismiss };

  menu.addEventListener('click', async (e) => {
    const r = e.target.closest('[data-r]')?.dataset.r;
    if (!r) return;
    closeRefMenu();
    if (r === 'upload') {
      const { requestUpload } = await import('../main.js');
      requestUpload((r) => {
        if (!r?.url) return;
        setRef(nodeId, r.resourceId || r.id, r.url);
        import('../main.js').then((m) => m.toast('参考图已添加', 'ok'));
      });
    } else if (r === 'library') {
      const { openAssetPicker } = await import('../main.js');
      openAssetPicker((asset) => setRef(nodeId, asset.id, asset.url));
    } else if (r === 'canvas') {
      const { toast } = await import('../main.js');
      toast('点击画布上的一个节点作为参考图');
      pickCallback = (srcNode) => {
        const out = srcNode.outputs?.[0];
        if (out?.url) setRef(nodeId, out.resourceId, out.url);
        // 同时建立连线（类型合法时）
        import('../store.js').then(({ store }) => {
          import('./nodeRegistry.js').then(({ validateEdgeTypes }) => {
            if (validateEdgeTypes(srcNode.type, store.getNode(nodeId).type).ok) store.addEdge(srcNode.id, nodeId);
          });
        });
      };
    }
  });
}

/** 「从画布选择」模式下，点击节点回调 */
export function handleCanvasPick(node) {
  if (pickCallback) { pickCallback(node); pickCallback = null; return true; }
  return false;
}

export function setRef(nodeId, resourceId, url) {
  const n = store.getNode(nodeId);
  if (!n) return;
  n.params.refResourceId = resourceId;
  n.params.refUrl = url;
  store.dirty = true; autosaveSoon();
  renderOne(n);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ---------- @ 引用菜单（截图：搜索 / 已引用 / 素材引用：图片·视频·音频·文本） ---------- */
let activeAtMenu = null;

function closeAtMenu() {
  activeAtMenu?.menu.remove();
  if (activeAtMenu) document.removeEventListener('pointerdown', activeAtMenu.dismiss);
  activeAtMenu = null;
  mention = null;
}

function openAtMenu(x, y, nodeId, opts = {}) {
  // 内联触发时 mention 已就位；此处 closeAtMenu 会清掉它，先保留再恢复
  const keepMention = mention;
  closeAtMenu();
  if (keepMention) mention = keepMention;
  const node = store.getNode(nodeId);
  if (!node) return;
  const inline = !!opts.inline;
  const prompt = node.params?.prompt || '';
  // 已引用：提示词里 @过名字 的其它节点
  const referenced = [...store.nodes.values()].filter((n) => n.id !== nodeId && prompt.includes('@' + n.name));

  const menu = document.createElement('div');
  menu.className = 'at-menu inline';
  menu.style.left = Math.min(x, window.innerWidth - 280) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - 380) + 'px';
  const sectionsHtml = inline
    ? `
    <div class="at-sec">画布节点</div>
    <div class="at-list at-nodes"></div>
    <div class="at-sec">素材引用</div>
    <div class="at-cats">
      <div class="at-cat" data-cat="image"><span class="at-ico">🖼</span>图片<span class="arrow">▸</span></div>
      <div class="at-cat" data-cat="video"><span class="at-ico">🎬</span>视频<span class="arrow">▸</span></div>
      <div class="at-cat" data-cat="audio"><span class="at-ico">🎵</span>音频<span class="arrow">▸</span></div>
      <div class="at-cat" data-cat="text"><span class="at-ico">📝</span>文本<span class="arrow">▸</span></div>
    </div>
    <div class="at-assets hidden"></div>`
    : `
    <div class="at-sec">已引用</div>
    <div class="at-list at-refs">${referenced.length ? '' : '<div class="at-empty">暂无引用，可从下方素材选择</div>'}</div>
    <div class="at-sec">素材引用</div>
    <div class="at-cats">
      <div class="at-cat" data-cat="image"><span class="at-ico">🖼</span>图片<span class="arrow">▸</span></div>
      <div class="at-cat" data-cat="video"><span class="at-ico">🎬</span>视频<span class="arrow">▸</span></div>
      <div class="at-cat" data-cat="audio"><span class="at-ico">🎵</span>音频<span class="arrow">▸</span></div>
      <div class="at-cat" data-cat="text"><span class="at-ico">📝</span>文本<span class="arrow">▸</span></div>
    </div>
    <div class="at-assets hidden"></div>`;
  menu.innerHTML = `
    <div class="at-search" ${inline ? 'style="display:none"' : ''}><span class="at-search-ico">⌕</span><input placeholder="搜索节点或素材" /></div>
    ${sectionsHtml}`;
  document.body.appendChild(menu);

  // 填充节点列表：按钮模式=已引用(定位)；内联模式=画布全部节点(选中即引用并连线)
  const nodeList = inline ? [...store.nodes.values()].filter((n) => n.id !== nodeId) : referenced;
  const refList = menu.querySelector('.at-nodes, .at-refs');
  if (inline && !nodeList.length) refList.innerHTML = '<div class="at-empty">画布上还没有其它节点，可从下方素材选择</div>';
  for (const r of nodeList) {
    const thumb = r.outputs?.[0]?.url || r.params?.refUrl || r.params?.url || '';
    const div = document.createElement('div');
    div.className = 'at-item';
    div.dataset.name = r.name;
    div.innerHTML = `${thumb ? `<img class="at-thumb" src="${thumb}">` : `<span class="at-thumb at-thumb-txt">${icon(NODE_TYPES[r.type]?.icon || 'image')}</span>`}<span class="at-name">${escapeHtml(r.name)}</span><span class="at-jump">${inline ? '引用 ＋' : '定位 ⟶'}</span>`;
    div.addEventListener('click', () => {
      if (inline) mentionNode(r, nodeId);
      else { closeAtMenu(); focusNode(r.id); }
    });
    refList.appendChild(div);
  }

  // 素材分类展开（懒加载资产库）
  let assetsCache = null;
  menu.querySelectorAll('.at-cat').forEach((cat) => {
    cat.addEventListener('click', async () => {
      const c = cat.dataset.cat;
      const box = menu.querySelector('.at-assets');
      const already = cat.classList.contains('open');
      menu.querySelectorAll('.at-cat').forEach((el) => el.classList.remove('open'));
      if (already) { box.classList.add('hidden'); return; }
      cat.classList.add('open');
      box.classList.remove('hidden');
      box.innerHTML = '<div class="at-empty">加载中…</div>';
      try {
        if (!assetsCache) assetsCache = (await api.listAssets()).assets;
        const kindOf = (mime) => mime.startsWith('image') ? 'image' : mime.startsWith('video') ? 'video' : mime.startsWith('audio') ? 'audio' : 'text';
        const list = assetsCache.filter((a) => kindOf(a.mime) === c);
        box.innerHTML = list.length ? '' : '<div class="at-empty">素材库暂无此类素材（可在左侧 ⬆ 上传）</div>';
        for (const a of list) {
          const isMedia = /^(image|video)\//.test(a.mime);
          const div = document.createElement('div');
          div.className = 'at-item';
          div.dataset.name = a.name;
          div.innerHTML = `${isMedia ? `<img class="at-thumb" src="${a.url}">` : `<span class="at-thumb at-thumb-txt">📄</span>`}<span class="at-name">${escapeHtml(a.name)}</span><span class="at-jump">引用 ＋</span>`;
          div.addEventListener('click', async () => {
            if (opts.inline) {
              // 内联模式：补全 @名字 到光标处，同时后台建素材节点并连线
              const media = await ensureAssetNode(a, nodeId);
              if (media) completeMention(media.name);
              closeAtMenu();
            } else {
              closeAtMenu();
              referenceAsset(a, nodeId);
            }
          });
          box.appendChild(div);
        }
      } catch (err) {
        box.innerHTML = `<div class="at-empty">加载失败：${escapeHtml(err.message)}</div>`;
      }
    });
  });

  // 搜索过滤（已引用 + 当前展开的素材列表）；内联模式下由输入框打字驱动同一接口
  menu.__filter = (q) => {
    const query = (q || '').trim().toLowerCase();
    menu.querySelectorAll('.at-sec').forEach((sec) => {
      let visible = 0;
      let el = sec.nextElementSibling;
      while (el && !el.classList.contains('at-sec')) {
        el.querySelectorAll?.('.at-item').forEach((it) => {
          const show = !query || (it.dataset.name || '').toLowerCase().includes(query);
          it.style.display = show ? '' : 'none';
          if (show) visible++;
        });
        el = el.nextElementSibling;
      }
      sec.style.display = visible ? '' : 'none';
    });
    const items = [...menu.querySelectorAll('.at-item')].filter((i) => i.style.display !== 'none');
    menu.querySelectorAll('.at-item.hl').forEach((i) => i.classList.remove('hl'));
    items[0]?.classList.add('hl');
    // 无匹配结果提示
    let nm = menu.querySelector('.at-nomatch');
    if (!nm) {
      nm = document.createElement('div');
      nm.className = 'at-empty at-nomatch';
      nm.textContent = '无匹配的节点或素材';
      menu.appendChild(nm);
    }
    nm.style.display = items.length ? 'none' : '';
  };
  menu.querySelector('.at-search input').addEventListener('input', (e2) => menu.__filter(e2.target.value));

  menu.addEventListener('pointerdown', (e2) => e2.stopPropagation());
  const dismiss = (e2) => { if (!menu.contains(e2.target)) closeAtMenu(); };
  setTimeout(() => document.addEventListener('pointerdown', dismiss), 0);
  activeAtMenu = { menu, dismiss };
  menu.__filter('');
  if (opts.inline && mention) mention.menu = menu;
}

/* ---------- 内联 @ 提及：在提示词里敲 @ 就地弹出菜单 ---------- */
let mention = null; // { nodeId, start(@的下标), ta, menu }

/** 计算文本域光标的屏幕坐标（镜像 div 方案） */
function taCaretXY(ta) {
  const cs = getComputedStyle(ta);
  const div = document.createElement('div');
  for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'lineHeight', 'paddingTop', 'paddingLeft', 'paddingRight', 'borderTopWidth', 'borderLeftWidth', 'boxSizing', 'width', 'whiteSpace', 'wordWrap', 'overflowWrap', 'textTransform']) {
    div.style[p] = cs[p];
  }
  div.style.position = 'absolute';
  div.style.visibility = 'hidden';
  div.style.whiteSpace = 'pre-wrap';
  div.style.wordWrap = 'break-word';
  div.textContent = ta.value.substring(0, ta.selectionStart);
  const span = document.createElement('span');
  span.textContent = ta.value.substring(ta.selectionStart) || '\u200b';
  div.appendChild(span);
  document.body.appendChild(div);
  const dRect = div.getBoundingClientRect();
  const sRect = span.getBoundingClientRect();
  const tRect = ta.getBoundingClientRect();
  const x = tRect.left + (sRect.left - dRect.left) - ta.scrollLeft;
  const lineH = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4 || 18;
  const y = tRect.top + (sRect.top - dRect.top) - ta.scrollTop + lineH;
  div.remove();
  return { x, y };
}

function positionAtMenu(menu, { x, y }) {
  menu.style.left = Math.max(4, Math.min(x, window.innerWidth - 280)) + 'px';
  menu.style.top = Math.max(4, Math.min(y + 4, window.innerHeight - 380)) + 'px';
}

/** 从光标处弹出内联 @ 菜单（@ 按钮与敲 @ 共用） */
function openAtMenuFromCaret(ta, nodeId) {
  const c = taCaretXY(ta);
  openAtMenu(c.x, c.y, nodeId, { inline: true });
}

/** 输入框 input 事件：检测敲入 @ 触发，或跟随输入实时过滤/移动菜单 */
function handleMentionInput(e, nodeId) {
  const ta = e.target;
  const pos = ta.selectionStart ?? ta.value.length;
  if (mention && mention.ta === ta) {
    const v = ta.value;
    if (v[mention.start] !== '@' || v.slice(mention.start + 1, pos).includes('\n')) {
      closeAtMenu();
      return;
    }
    mention.menu?.__filter(v.slice(mention.start + 1, pos));
    if (mention.menu) positionAtMenu(mention.menu, taCaretXY(ta));
    return;
  }
  // 触发：本次输入的字符是 @（逐字输入；@ 按钮走 openAtMenuFromCaret）
  if (pos > 0 && (e.data === '@' || (e.inputType === 'insertText' && ta.value[pos - 1] === '@'))) {
    mention = { nodeId, start: pos - 1, ta };
    openAtMenuFromCaret(ta, nodeId);
  }
}

/** 确认引用：把 @查询 替换为 @名字(带尾空格)，光标落回插入点并触发参数同步 */
function completeMention(name) {
  if (!mention) return;
  const { ta, start } = mention;
  closeAtMenu();
  if (!ta.isConnected) return;
  const pos = ta.selectionStart ?? ta.value.length;
  const insert = '@' + name + ' ';
  ta.value = ta.value.slice(0, start) + insert + ta.value.slice(pos);
  const caret = start + insert.length;
  ta.setSelectionRange(caret, caret);
  ta.focus();
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

/** 内联选中画布节点：补全 @名字 + 类型合法时自动连线。
 *  超出视频模型参考上限时 @ 不成功：撤销已敲入的 @ 文本并提示失败原因 */
async function mentionNode(target, nodeId) {
  if (!mention) { closeAtMenu(); return; }
  const node = store.getNode(nodeId);
  if (!node || !store.getNode(target.id)) { closeAtMenu(); return; }
  const dup = [...store.edges.values()].some((e2) => e2.source === target.id && e2.target === nodeId);
  if (!dup) {
    const typeV = validateEdgeTypes(target.type, node.type, target);
    const refV = typeV.ok ? validateVideoRefs(node, [target], store.upstreamOf(nodeId)) : { ok: true };
    if (!typeV.ok || !refV.ok) {
      // @失败：把已敲入的 '@查询' 从提示词里撤销，光标落回 @ 处
      const { ta, start } = mention;
      closeAtMenu();
      if (ta.isConnected) {
        const pos = ta.selectionStart ?? ta.value.length;
        ta.value = ta.value.slice(0, start) + ta.value.slice(pos);
        ta.setSelectionRange(start, start);
        ta.focus();
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
      import('../main.js').then((m) => m.toast(typeV.ok ? refV.reason : typeV.reason, 'err'));
      return;
    }
  }
  completeMention(target.name);
  if (!dup) store.addEdge(target.id, nodeId);
}

/** 已引用项「定位」：选中节点并居中画布 */
function focusNode(id) {
  const n = store.getNode(id);
  if (!n) return;
  store.selection.clear();
  store.selection.add(id);
  store.emit({ type: 'selection' });
  const rect = document.getElementById('canvasWrap').getBoundingClientRect();
  camera.set(
    rect.width / 2 - (n.position.x + (n.width || 320) / 2) * store.camera.scale,
    rect.height / 2 - (n.position.y + 140) * store.camera.scale,
    store.camera.scale,
  );
  store.emit({ type: 'render' });
}

/** 找/建素材节点并连线到目标节点（按钮模式与内联模式共用） */
async function ensureAssetNode(asset, nodeId) {
  const node = store.getNode(nodeId);
  if (!node) return null;
  // 1) 已有同源素材节点则复用，否则在当前节点右侧新建
  let media = [...store.nodes.values()].find((n) => n.type === 'media' && (n.params?.url === asset.url || n.outputs?.[0]?.resourceId === asset.id));
  if (!media) {
    store.pushHistory();
    media = store.addNode('media', { x: node.position.x + (node.width || 320) + 80, y: node.position.y });
    media.name = asset.name.replace(/\.[a-z0-9]+$/i, '') || media.name;
    media.params = { url: asset.url, mime: asset.mime, name: asset.name };
    const kind = asset.mime.startsWith('video') ? 'video' : asset.mime.startsWith('audio') ? 'audio' : (/text|json/.test(asset.mime) ? 'text' : 'image');
    media.outputs[0] = { name: 'out', resourceId: asset.id, url: asset.url, kind };
    media.status = 'success';
    store.emit({ type: 'node_added', node: media });
  }
  // 2) 类型合法时自动连线
  const dup = [...store.edges.values()].some((e2) => e2.source === media.id && e2.target === nodeId);
  if (!dup) {
    const { validateEdgeTypes } = await import('./nodeRegistry.js');
    if (validateEdgeTypes(media.type, node.type, media).ok) store.addEdge(media.id, nodeId);
  }
  store.dirty = true; autosaveSoon();
  return media;
}

/** 素材引用（按钮模式）：建素材节点 → 连线 → 提示词末尾插入 @素材名 */
async function referenceAsset(asset, nodeId) {
  const media = await ensureAssetNode(asset, nodeId);
  if (!media) return;
  const n = store.getNode(nodeId);
  n.params = n.params || {};
  const cur = n.params.prompt || '';
  if (!cur.includes('@' + media.name)) {
    n.params.prompt = (cur ? cur.replace(/\s+$/, '') + ' ' : '') + '@' + media.name;
    store.dirty = true; autosaveSoon();
  }
  renderOne(n);
  import('../main.js').then((m) => m.toast(`已引用「${media.name}」并自动连线`, 'ok'));
}

/**
 * 上游连线自动带出的参考图列表（最终端显示）：
 * 起始端只显示自己上传的图片；被连线的下游节点把上游图片作为缩略图自动展示。
 * 仅收集图片类输出（mock 图为 svg，素材节点看 mime）。
 */
function upstreamRefs(node) {
  const out = [];
  for (const e of store.edges.values()) {
    if (e.target !== node.id) continue;
    const src = store.nodes.get(e.source);
    if (!src) continue;
    const o = src.outputs?.[0];
    let url = null, kind = 'image';
    // kind 优先于扩展名判断：mock 视频输出是 .svg 占位，但 kind 是 video
    if (o?.url && (o.kind === 'video' || /\.(mp4|webm|mov)($|\?)/i.test(o.url))) { kind = 'video'; url = o.url; }
    else if (o?.url && (o.kind === 'audio' || /\.(mp3|wav|m4a|aac|ogg|flac)($|\?)/i.test(o.url))) { kind = 'audio'; url = o.url; }
    else if (o?.url && (o.kind === 'image' || /\.(svg|png|jpe?g|webp|gif)($|\?)/i.test(o.url))) url = o.url;
    else if (src.type === 'media' && src.params?.url && String(src.params?.mime || '').startsWith('video')) { kind = 'video'; url = src.params.url; }
    else if (src.type === 'media' && src.params?.url && String(src.params?.mime || '').startsWith('audio')) { kind = 'audio'; url = src.params.url; }
    else if (src.type === 'media' && src.params?.url) url = src.params.url;
    else if (src.params?.refUrl) url = src.params.refUrl;
    if (url) out.push({ edgeId: e.id, url, name: src.name, kind, resourceId: o?.resourceId || (src.type === 'media' ? src.id : null) });
  }
  return out;
}
