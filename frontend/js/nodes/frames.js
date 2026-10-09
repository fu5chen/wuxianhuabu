// ============================================================
// frames.js — 视频抽帧：浏览器解码 + canvas 截帧（零依赖，无需 ffmpeg）
//  1) 快速抽帧：首帧 / 均匀 N 帧 → 新建图片节点（首帧主显示，其余进历史）
//  2) 抽帧面板：缩略图胶片条 + 播放头拖动滑选，提取任意指定帧
// ============================================================
import { store } from '../store.js';
import { api } from '../services/api.js';
import { renderOne } from './nodeDom.js';

/* ---------- 基础工具 ---------- */

/** seek 到指定时间（带超时兜底，单帧失败不阻塞整体） */
function seek(v, t) {
  return new Promise((resolve) => {
    const done = (ok) => { v.removeEventListener('seeked', onSeeked); clearTimeout(timer); resolve(ok); };
    const onSeeked = () => done(true);
    const timer = setTimeout(() => done(false), 6000);
    v.addEventListener('seeked', onSeeked);
    try { v.currentTime = t; } catch { done(false); }
  });
}

/** 探测视频时长：部分视频（如 MediaRecorder 录的 webm）没有 duration 元数据（NaN/Infinity）。
 *  用「seek 到超大值」逼浏览器定位到末尾，duration 会被修正；否则用 currentTime 的钳制值兜底 */
async function ensureDuration(v) {
  if (isFinite(v.duration) && v.duration > 0) return v.duration;
  await new Promise((res) => {
    const done = () => { v.removeEventListener('seeked', onEnded); clearTimeout(timer); res(); };
    const timer = setTimeout(done, 3000);
    const onEnded = () => done();
    v.addEventListener('seeked', onEnded);
    v.addEventListener('ended', onEnded);
    try { v.currentTime = 1e101; } catch { done(); }
  });
  const d = (isFinite(v.duration) && v.duration > 0)
    ? v.duration
    : (isFinite(v.currentTime) ? v.currentTime : 0);
  try { v.currentTime = 0; } catch { /* 忽略 */ }
  return d;
}

/** 加载视频元素（返回 {video, duration}），出错抛可读信息 */
async function loadVideo(videoUrl) {
  const v = document.createElement('video');
  v.src = videoUrl; v.muted = true; v.preload = 'auto'; v.playsInline = true;
  await new Promise((res, rej) => {
    v.addEventListener('loadedmetadata', res, { once: true });
    v.addEventListener('error', () => rej(new Error('视频加载失败（格式可能不受浏览器支持）')), { once: true });
  });
  const dur = await ensureDuration(v);
  if (!dur || !v.videoWidth) { v.removeAttribute('src'); v.load(); throw new Error('无法读取视频时长/画面尺寸'); }
  return { video: v, duration: dur };
}

/** 当前帧 → JPEG Blob */
function frameToBlob(v, quality = 0.92) {
  const canvas = document.createElement('canvas');
  canvas.width = v.videoWidth; canvas.height = v.videoHeight;
  canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height);
  return new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
}

/** 时间格式化 mm:ss.d */
function fmt(t) {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}

/* ---------- 落地：新建图片节点承载帧 ---------- */

/** 把帧列表落到新建图片节点（自动连线）：首帧主显示、其余进历史 */
async function attachFramesToNode(node, frames, label = '') {
  const { toast } = await import('../main.js');
  const src = store.getNode(node.id) || node;
  const img = store.addNode('image', { x: src.position.x + (src.width || 320) + 80, y: src.position.y });
  img.name = `${src.name}·帧${label ? '·' + label : ''}`;
  store.addEdge(src.id, img.id);

  const items = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const file = new File([f.blob], `frame_${String(i + 1).padStart(2, '0')}_${f.t.toFixed(1)}s.jpg`, { type: 'image/jpeg' });
    try {
      const r = await api.uploadFile(file);
      if (r?.id && r?.url) items.push({ name: 'out', resourceId: r.id, url: r.url, kind: 'image', mime: 'image/jpeg', ts: Date.now() });
    } catch (e) { console.warn('[frames] 帧上传失败', i, e); }
  }
  if (!items.length) {
    store.removeNodes([img.id]);
    toast('帧上传失败：' + frames.length + ' 帧均未入库', 'err');
    return null;
  }
  img.outputs = [items[0]];
  if (items.length > 1) img.history = items.slice(1);
  img.status = 'success';
  img.progress = 100;
  store.dirty = true;
  const { scheduleAutosave } = await import('../main.js');
  renderOne(img);
  scheduleAutosave();
  toast(`已提取 ${items.length} 帧到「${img.name}」${items.length > 1 ? '（左上角历史条可切换）' : ''}`, 'ok');
  return img;
}

/** 快速抽帧：count=1 首帧（稍避开头黑帧），>1 均匀分布（前后各留 5%） */
export async function extractFramesToNode(node, count) {
  const { toast } = await import('../main.js');
  const out = node.outputs?.[0];
  if (!out?.url) { toast('该节点还没有生成结果', 'err'); return null; }

  toast(`正在提取${count === 1 ? '首帧' : ` ${count} 帧`}（解码视频中）…`);
  let frames;
  try {
    const { video, duration } = await loadVideo(out.url);
    const times = count === 1
      ? [Math.min(0.1, duration * 0.05)]
      : Array.from({ length: count }, (_, i) => duration * (0.05 + (0.9 * i) / (count - 1)));
    frames = [];
    for (const t of times) {
      if (await seek(video, Math.min(t, duration - 0.05))) {
        const blob = await frameToBlob(video);
        if (blob) frames.push({ blob, t });
      }
    }
    video.removeAttribute('src'); video.load(); // 释放解码资源
  } catch (e) {
    toast('提取失败：' + e.message, 'err');
    return null;
  }
  if (!frames.length) { toast('提取失败：未获得任何帧', 'err'); return null; }
  return attachFramesToNode(node, frames);
}

/* ---------- 抽帧面板：胶片条 + 播放头滑选 ---------- */

let fpEsc = null; // 面板 Esc 处理
const STRIP_THUMBS = 18; // 胶片条缩略图数量

/** 打开抽帧面板：大图预览 + 底部缩略图胶片条，拖动播放头滑选任意帧后提取 */
export function openFramePicker(node) {
  const out = node.outputs?.[0];
  if (!out?.url) { import('../main.js').then(({ toast }) => toast('该节点还没有生成结果', 'err')); return; }
  closeFramePicker();

  const el = document.createElement('div');
  el.id = 'framePicker';
  el.innerHTML = `
    <div class="fp-inner">
      <div class="fp-head">
        <span class="fp-title">${node.name || '视频'}<span class="fp-sub"> · 抽帧</span></span>
        <button class="fp-close" title="关闭 (Esc)">✕</button>
      </div>
      <video class="fp-video" src="${out.url}" muted playsinline></video>
      <div class="fp-strip-wrap">
        <div class="fp-strip">
          <div class="fp-playhead" style="left:0%"><i></i></div>
        </div>
        <div class="fp-hint">拖动绿色播放头或点击缩略图滑选画面，选好后点「提取当前帧」</div>
      </div>
      <div class="fp-bar">
        <span class="fp-time">00:00.0</span>
        <div class="fp-acts">
          <button class="fp-btn fp-primary" data-fp="cur">提取当前帧</button>
          <button class="fp-btn" data-fp="f1">首帧</button>
          <button class="fp-btn" data-fp="f6">均匀 6 帧</button>
          <button class="fp-btn" data-fp="f12">均匀 12 帧</button>
        </div>
      </div>
    </div>
    <button class="fp-close fp-close2" title="关闭 (Esc)">✕</button>`;
  document.body.appendChild(el);

  const video = el.querySelector('.fp-video');
  const strip = el.querySelector('.fp-strip');
  const playhead = el.querySelector('.fp-playhead');
  const timeEl = el.querySelector('.fp-time');
  let duration = 0;

  const close = () => closeFramePicker();
  el.querySelectorAll('.fp-close').forEach((b) => b.addEventListener('click', close));
  fpEsc = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', fpEsc);
  el.addEventListener('pointerdown', (e) => { if (e.target === el) close(); });

  // ---- 胶片条：生成缩略图（逐个追加，边生成边显示）----
  (async () => {
    try {
      const { video: sv, duration: dur } = await loadVideo(out.url);
      duration = dur;
      const cw = 120, ch = Math.max(40, Math.round(cw * sv.videoHeight / sv.videoWidth));
      for (let i = 0; i < STRIP_THUMBS; i++) {
        const t = dur * (i + 0.5) / STRIP_THUMBS;
        if (!(await seek(sv, t))) continue;
        const c = document.createElement('canvas');
        c.width = cw; c.height = ch;
        c.getContext('2d').drawImage(sv, 0, 0, cw, ch);
        const img = document.createElement('img');
        img.className = 'fp-thumb';
        img.src = c.toDataURL('image/jpeg', 0.6);
        img.draggable = false;
        img.dataset.t = String(t);
        strip.insertBefore(img, playhead); // 缩略图排在播放头前面
      }
      sv.removeAttribute('src'); sv.load();
    } catch (e) {
      const hint = el.querySelector('.fp-hint');
      if (hint) hint.textContent = '缩略图生成失败：' + e.message;
    }
  })();

  // ---- 播放头拖动 / 点击缩略图滑选 ----
  const moveTo = (ratio) => {
    ratio = Math.min(1, Math.max(0, ratio));
    playhead.style.left = (ratio * 100) + '%';
    const t = ratio * duration;
    timeEl.textContent = fmt(t);
    if (isFinite(t)) { try { video.currentTime = t; } catch { /* 忽略 */ } }
  };
  let dragging = false;
  strip.addEventListener('pointerdown', (e) => {
    dragging = true;
    try { strip.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
    const rect = strip.getBoundingClientRect();
    moveTo((e.clientX - rect.left) / rect.width);
  });
  strip.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const rect = strip.getBoundingClientRect();
    moveTo((e.clientX - rect.left) / rect.width);
  });
  strip.addEventListener('pointerup', () => { dragging = false; });
  strip.addEventListener('pointercancel', () => { dragging = false; });
  // 点击缩略图直接跳到该缩略图中心对应时间
  el.addEventListener('click', (e) => {
    const img = e.target.closest('.fp-thumb');
    if (img && duration) moveTo(Number(img.dataset.t) / duration);
  });

  // ---- 提取动作 ----
  el.querySelector('.fp-bar').addEventListener('click', async (e) => {
    const btn = e.target.closest('.fp-btn');
    if (!btn) return;
    const act = btn.dataset.fp;
    const { toast } = await import('../main.js');
    if (act === 'cur') {
      btn.disabled = true;
      try {
        // 预览画面已停在播放头位置，直接截当前帧
        const blob = await frameToBlob(video);
        if (!blob) throw new Error('未捕获到画面');
        const cur = isFinite(video.currentTime) ? video.currentTime : 0;
        await attachFramesToNode(node, [{ blob, t: cur }], fmt(cur));
      } catch (err) {
        toast('提取失败：' + err.message, 'err');
      }
      btn.disabled = false;
      return;
    }
    const count = act === 'f1' ? 1 : act === 'f6' ? 6 : 12;
    btn.disabled = true;
    try {
      await extractFramesToNode(node, count);
    } finally { btn.disabled = false; }
  });
}

/** 关闭抽帧面板 */
export function closeFramePicker() {
  document.getElementById('framePicker')?.remove();
  if (fpEsc) { document.removeEventListener('keydown', fpEsc); fpEsc = null; }
}

/** 兼容旧入口：选项菜单（卡片按钮/右键菜单打开抽帧面板，另附快速抽帧路径） */
export function openFrameMenu(x, y, node) {
  import('../main.js').then(({ openCtxMenu }) => {
    openCtxMenu(x, y, [
      { label: '打开抽帧面板（滑选画面）', act: () => openFramePicker(node) },
      { label: '提取首帧', act: () => extractFramesToNode(node, 1) },
      { label: '均匀提取 6 帧', act: () => extractFramesToNode(node, 6) },
      { label: '均匀提取 12 帧', act: () => extractFramesToNode(node, 12) },
    ]);
  });
}
