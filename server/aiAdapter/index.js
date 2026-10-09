// ============================================================
// aiAdapter/index.js — AI 模型适配器层（Mock 实现）
// 生产环境：将每个 generate* 替换为对独立推理服务(image-infer /
// seedance-infer / llm-service / audio-service)的 HTTP 调用
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAsset, getAsset } from '../storage/assets.js';
import { getApiKey, hasApiKey, getKeyField } from '../config/keys.js';
import { runArkVideoTask, cancelArkVideoTask, getArkTaskId, isArkVideoEnabled, markPendingCancel } from './arkVideo.js';
import { runJimengImageTask, cancelJimengImageTask, getJimengImageTaskId, isJimengImageEnabled, reqKeyFor, markJimengPendingCancel } from './jimengImage.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));

// 节点级任务取消：方舟视频以远端 DELETE 结果为准（失败则任务继续跑）；无方舟任务再试即梦图片；
// 都没有运行中的任务 → 双通道登记预取消（节点类型未定，建立后立即取消）
export async function cancelNodeTask(nodeId) {
  if (getArkTaskId(nodeId)) return cancelArkVideoTask(nodeId); // {ok, error?}
  if (cancelJimengImageTask(nodeId).ok) return { ok: true };
  markPendingCancel(nodeId);
  markJimengPendingCancel(nodeId);
  return { ok: true, pending: true };
}
export function getNodeTaskId(nodeId) { return getArkTaskId(nodeId) || getJimengImageTaskId(nodeId); }
export { isArkVideoEnabled, isJimengImageEnabled };

export const MODELS = {
  image: [
    { id: 'jimeng-4.6', name: '即梦图片4.6', credits: 8, sizes: ['1K', '2K', '4K'], ratios: ['1:1', '3:4', '4:3', '16:9', '9:16'] },
    { id: 'jimeng-4.0', name: '即梦图片4.0', credits: 6,  sizes: ['1K', '2K', '4K'], ratios: ['1:1', '3:4', '4:3', '16:9', '9:16'] },
    { id: 'image-5.0-lite', name: '图片 5.0 Lite', credits: 3,  sizes: ['1K', '2K', '4K'], ratios: ['1:1', '3:4', '4:3', '16:9', '9:16'] },
    { id: 'image-5.0-pro',  name: '图片 5.0 Pro',  credits: 8,  sizes: ['2K', '4K'],       ratios: ['1:1', '3:4', '4:3', '16:9', '9:16'] },
    { id: 'nano-banana-pro', name: 'Nano Banana Pro', credits: 10, sizes: ['1K', '2K', '4K'], ratios: ['1:1', '3:4', '4:3', '16:9', '9:16'] },
    { id: 'gpt-image-2.0',   name: 'GPT Image 2.0',   credits: 12, sizes: ['1K', '2K', '4K'], ratios: ['1:1', '3:4', '4:3', '16:9', '9:16'] },
  ],
  video: [
    { id: 'seedance-2.0',     name: '即梦 Seedance 2.0',     credits: 56,  minDur: 4, maxDur: 15, durations: [4, 8, 12], resolutions: ['480P', '720P', '1080P'] },
    { id: 'seedance-2.0-vip', name: '即梦 Seedance 2.0 VIP', credits: 120, minDur: 4, maxDur: 15, durations: [4, 8, 12], resolutions: ['720P', '1080P'] },
    { id: 'seedance-2.5',     name: '即梦 Seedance 2.5',     credits: 90,  minDur: 4, maxDur: 30, durations: [4, 8, 12, 15, 30], resolutions: ['480P', '720P', '1080P'] },
  ],
  audio: [
    { id: 'tts-v2', name: '语音合成 TTS v2', credits: 2 },
    { id: 'sfx-v1', name: '音效生成 v1',    credits: 5 },
  ],
  text: [
    { id: 'llm-lite', name: '文本模型 Lite', credits: 1 },
  ],
};

const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function pickPalette(seedStr) {
  const palettes = [
    ['#1a2a6c', '#b21f1f', '#fdbb2d'],
    ['#0f2027', '#203a43', '#2c5364'],
    ['#41295a', '#2f0743', '#642b73'],
    ['#134e5e', '#71b280', '#3a7bd5'],
    ['#3e1e68', '#1e3c72', '#928dab'],
  ];
  let h = 0;
  for (const ch of String(seedStr)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palettes[h % palettes.length];
}

function svgPlaceholder({ w, h, title, subtitle, animated }) {
  const [c1, c2, c3] = pickPalette(title + subtitle);
  const anim = animated ? `
  <circle cx="${w / 2}" cy="${h / 2}" r="26" fill="none" stroke="#ffffff" stroke-opacity="0.85" stroke-width="4" stroke-dasharray="40 130">
    <animateTransform attributeName="transform" type="rotate" from="0 ${w / 2} ${h / 2}" to="360 ${w / 2} ${h / 2}" dur="1.6s" repeatCount="indefinite"/>
  </circle>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${c1}"/><stop offset="0.55" stop-color="${c2}"/><stop offset="1" stop-color="${c3}"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#g)"/>
  <circle cx="${w * 0.78}" cy="${h * 0.24}" r="${Math.min(w, h) * 0.22}" fill="#ffffff" fill-opacity="0.10"/>
  <circle cx="${w * 0.2}" cy="${h * 0.78}" r="${Math.min(w, h) * 0.16}" fill="#ffffff" fill-opacity="0.08"/>
  ${anim}
  <text x="${w / 2}" y="${h / 2 - 8}" text-anchor="middle" font-family="Microsoft YaHei, sans-serif" font-size="${Math.round(Math.min(w, h) * 0.055)}" fill="#ffffff" fill-opacity="0.95">${esc(title)}</text>
  <text x="${w / 2}" y="${h / 2 + 30}" text-anchor="middle" font-family="Microsoft YaHei, sans-serif" font-size="${Math.round(Math.min(w, h) * 0.032)}" fill="#ffffff" fill-opacity="0.7">${esc(subtitle)}</text>
</svg>`;
}

/** 简易 WAV 生成（正弦和弦短音） */
function wavBuffer(seconds = 2, freqs = [440, 554, 659]) {
  const rate = 22050;
  const n = Math.floor(rate * seconds);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const env = Math.min(1, t * 8) * Math.exp(-1.2 * t);
    let v = 0;
    for (const f of freqs) v += Math.sin(2 * Math.PI * f * t) / freqs.length;
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * env * 28000))), 44 + i * 2);
  }
  return buf;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 参考图解析：手动上传(refResourceId) 优先，其次连线传入的上游图片 ----------
 * 有参考图 = 图生视频/参考图生图；无参考图 = 文生视频/文生图。
 * 可传 mimePattern 改变匹配类型（如 /^video\// 取视频参考）。 */
function resolveRefMeta(node, mimePattern = /^image\//) {
  const candidates = [];
  if (node.params?.refResourceId) candidates.push(node.params.refResourceId);
  for (const u of node.upstreamResults || []) {
    if (u?.resourceId) candidates.push(u.resourceId);
  }
  for (const id of candidates) {
    const meta = getAsset(id);
    if (meta && mimePattern.test(meta.mime)) return meta;
  }
  return null;
}

/** 参考图 → base64 data URI（SVG 内嵌与真实 API 的图生视频入参都可用） */
function refDataUri(node) {
  const meta = resolveRefMeta(node);
  if (!meta) return null;
  try {
    const b = fs.readFileSync(meta.file);
    return `data:${meta.mime};base64,${b.toString('base64')}`;
  } catch { return null; }
}

/** 探测参考图原始像素尺寸（PNG/JPEG/GIF/WebP/SVG），失败返回 null。
 *  占位生成用它保证上传图按原始比例完整呈现——不裁切、不拉伸。 */
function refImageSize(node) {
  const meta = resolveRefMeta(node);
  if (!meta) return null;
  try {
    const b = fs.readFileSync(meta.file);
    // PNG
    if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    // JPEG（扫描 SOF 段）
    if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
      let off = 2;
      while (off + 9 < b.length) {
        if (b[off] !== 0xff) { off++; continue; }
        const mk = b[off + 1];
        if (mk === 0x01 || (mk >= 0xd0 && mk <= 0xd7)) { off += 2; continue; }
        const len = b.readUInt16BE(off + 2);
        if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) {
          return { w: b.readUInt16BE(off + 7), h: b.readUInt16BE(off + 5) };
        }
        off += 2 + len;
      }
      return null;
    }
    // GIF
    if (b.length > 10 && b.toString('ascii', 0, 3) === 'GIF') return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
    // WebP
    if (b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
      const fmt = b.toString('ascii', 12, 16);
      if (fmt === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
      if (fmt === 'VP8L') { const t = b.readUInt32LE(21); return { w: (t & 0x3fff) + 1, h: ((t >> 14) & 0x3fff) + 1 }; }
      if (fmt === 'VP8X') return { w: (b[24] | (b[25] << 8) | (b[26] << 16)) + 1, h: (b[27] | (b[28] << 8) | (b[29] << 16)) + 1 };
      return null;
    }
    // SVG
    const head = b.toString('utf-8', 0, Math.min(b.length, 2048));
    const m = head.match(/<svg[^>]*?width=["']([\d.]+)["'][^>]*?height=["']([\d.]+)["']/i)
      || head.match(/<svg[^>]*?viewBox=["']0 0 ([\d.]+) ([\d.]+)["']/i);
    if (m) return { w: Math.round(+m[1]), h: Math.round(+m[2]) };
    return null;
  } catch { return null; }
}

/* ---------- 即梦（火山方舟 Ark）真实协议接入 ----------
 * 在 server/config/keys.json 填入 "jimeng": "<方舟 API Key>" 即启用真实调用；
 * 未填写时自动回落 mock。视频走 aiAdapter/arkVideo.js 的 Seedance 任务通道。 */
const arkBase = () => getKeyField('jimengBaseUrl', 'https://ark.cn-beijing.volces.com/api/v3');
const arkHeaders = () => ({ 'Authorization': `Bearer ${getApiKey('jimeng')}`, 'Content-Type': 'application/json' });

async function arkGenerateImage({ prompt, refData, w, h }) {
  const body = {
    model: getKeyField('jimengImageModel', 'doubao-seedream-4-0-250828'),
    prompt: prompt || '生成一张图片',
    size: `${Math.min(w, 4096)}x${Math.min(h, 4096)}`,
    response_format: 'url',
  };
  // 参考图生图：方舟图片接口的 image 参数支持 base64 data URI
  if (refData) body.image = refData;
  const r = await fetch(`${arkBase()}/images/generations`, {
    method: 'POST', headers: arkHeaders(), body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`即梦图片生成失败 ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  const url = d.data?.[0]?.url;
  if (!url) throw new Error('即梦返回缺少图片 url');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`图片下载失败 ${res.status}`);
  const ext = (res.headers.get('content-type') || '').includes('png') ? '.png' : '.jpg';
  return createAsset({ name: 'seedream-image' + ext, ext, data: Buffer.from(await res.arrayBuffer()) });
}

/**
 * 执行单个节点的 AI 生成任务
 * @param {object} node 画布节点 { id, type, params, inputs }
 * @param {Function} onProgress (0-100) => void
 * @returns {Promise<{resourceId:string, url:string, kind:string}>}
 */
export async function runNodeTask(node, onProgress = () => {}) {
  const params = node.params || {};
  const prompt = params.prompt || '';

  for (const pct of [15, 40, 70, 90]) {
    await sleep(300 + Math.random() * 400);
    onProgress(pct);
  }

  switch (node.type) {
    case 'image': {
      // 真实协议①：配置了火山引擎 AK/SK（volcAccessKey/volcSecretKey）且当前模型
      // 配置了对应服务标识（req_key）时走即梦图片异步任务通道。
      // 每个模型一个独立槽位：即梦4.0/4.6 默认开通；图片5.0/香蕉/GPT 需在 keys.json
      // 填对应 *ReqKey 才启用，未配置就如实走 mock，不冒充即梦。
      const m = node?.params?.model;
      const isJimengModel = !m || m === 'jimeng-4.0' || m === 'jimeng-4.6';
      if (isJimengImageEnabled() && reqKeyFor(node)) {
        try {
          const out = await runJimengImageTask(node, onProgress);
          return out;
        } catch (e) {
          if (e.cancelled) throw e;
          console.error('[即梦图片生成失败，尝试方舟通道]', e.message);
        }
      }
      // 真实协议②：仅即梦系模型回落方舟 Seedream（参考图 → 图生图），失败回落 mock
      // 输出分辨率跟随参考图比例（不改变上传图的比例）；纯文生图按面板比例
      if (isJimengModel && hasApiKey('jimeng')) {
        try {
          // 输出分辨率跟随参考图比例（不改变上传图的比例）；纯文生图 1024 方形
          const dim = refImageSize(node);
          let rw = 1024, rh = 1024;
          if (dim?.w && dim?.h) {
            const s = 1024 / Math.max(dim.w, dim.h);
            rw = Math.max(2, Math.round(dim.w * s));
            rh = Math.max(2, Math.round(dim.h * s));
          }
          const meta = await arkGenerateImage({ prompt, refData: refDataUri(node), w: rw, h: rh });
          return { resourceId: meta.id, url: `/api/assets/${meta.id}${meta.ext}`, kind: 'image' };
        } catch (e) {
          console.error('[即梦图片生成失败，回落 mock]', e.message);
        }
      }
      const [rw, rh] = ratioToSize(params.ratio || '1:1');
      const scale = (params.size || '2K') === '4K' ? 2 : 1;
      const w = rw * scale, h = rh * scale;
      const ref = refDataUri(node);
      let svg;
      if (ref) {
        // 参考图生图：占位画布直接采用参考图原始宽高比，图片完整呈现（不裁切、不拉伸、不改变原图比例）
        // 不在画面上叠加任何文字/字幕条 —— 模拟占位即原图原样呈现
        const dim = refImageSize(node);
        const rw = dim?.w || 1024, rh = dim?.h || 1024;
        const k = 1024 / Math.max(rw, rh);
        const w = Math.max(2, Math.round(rw * k)), h = Math.max(2, Math.round(rh * k));
        svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <image href="${ref}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet"/>
</svg>`, 'utf-8');
      } else if (resolveRefMeta(node, /^video\//)) {
        // 视频参考：真实接口仅支持图片参考，故不传 ref；mock 占位标注"参考视频"
        svg = Buffer.from(svgPlaceholder({ w, h, title: (prompt || '未命名图像').slice(0, 24), subtitle: `参考视频生图（视频截帧参考） · ${params.modelName || '图片 5.0 Lite'} · ${params.ratio || '1:1'}` }), 'utf-8');
      } else {
        svg = Buffer.from(svgPlaceholder({ w, h, title: (prompt || '未命名图像').slice(0, 24), subtitle: `文生图 · ${params.modelName || '图片 5.0 Lite'} · ${params.ratio || '1:1'} · ${params.size || '2K'}` }), 'utf-8');
      }
      const meta = createAsset({ name: 'generated-image.svg', ext: '.svg', data: svg });
      return { resourceId: meta.id, url: `/api/assets/${meta.id}${meta.ext}`, kind: 'image' };
    }
    case 'video': {
      const ref = refDataUri(node);
      // 真实协议：配置了即梦(方舟) Key 时走 Seedance 任务通道
      // （文生视频 / 全模态参考 / 编辑视频 / 延长视频，支持节点级取消），取消不回落 mock
      if (isArkVideoEnabled()) {
        try {
          const out = await runArkVideoTask(node, onProgress);
          return out;
        } catch (e) {
          if (e.cancelled) throw e;
          console.error('[Seedance 视频生成失败，回落 mock]', e.message);
        }
      }
      // 视频模拟（未配置方舟 Key 或真实调用失败时的演示占位，不消耗真实额度）
      let svg;
      if (ref) {
        const w = 960, h = 540;
        // 上传图按原始比例完整呈现（letterbox 居中，不裁切、不缩放变形、不加运镜动画、不叠加文字）
        svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect x="0" y="0" width="${w}" height="${h}" fill="#14171c"/>
  <image href="${ref}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet"/>
</svg>`, 'utf-8');
      } else {
        svg = Buffer.from(svgPlaceholder({ w: 960, h: 540, title: (prompt || '未命名视频').slice(0, 24), subtitle: `模拟占位（未配置 API Key）· ${params.modelName || 'Seedance'} · ${params.duration || 4}s`, animated: true }), 'utf-8');
      }
      const meta = createAsset({ name: 'generated-video.svg', ext: '.svg', data: svg });
      return { resourceId: meta.id, url: `/api/assets/${meta.id}${meta.ext}`, kind: 'video', mime: 'image/svg+xml', mock: true };
    }
    case 'audio': {
      const wav = wavBuffer(Number(params.duration) || 2);
      const meta = createAsset({ name: 'generated-audio.wav', ext: '.wav', data: wav });
      return { resourceId: meta.id, url: `/api/assets/${meta.id}${meta.ext}`, kind: 'audio' };
    }
    case 'text': {
      const text = mockLLM(prompt);
      const meta = createAsset({ name: 'generated-text.json', ext: '.json', data: Buffer.from(JSON.stringify({ text }), 'utf-8') });
      return { resourceId: meta.id, url: `/api/assets/${meta.id}${meta.ext}`, kind: 'text', text };
    }
    case 'subject': {
      const svg = Buffer.from(svgPlaceholder({ w: 512, h: 512, title: (params.name || '主体').slice(0, 16), subtitle: '主体形象资产' }), 'utf-8');
      const meta = createAsset({ name: 'subject.svg', ext: '.svg', data: svg });
      return { resourceId: meta.id, url: `/api/assets/${meta.id}${meta.ext}`, kind: 'image' };
    }
    case 'timeline':
    case 'director': {
      // 编排类节点：汇总上游，输出执行计划 JSON
      const plan = { node: node.type, prompt, steps: (node.upstreamResults || []).map((u) => u.resourceId) };
      const meta = createAsset({ name: `${node.type}-plan.json`, ext: '.json', data: Buffer.from(JSON.stringify(plan), 'utf-8') });
      return { resourceId: meta.id, url: `/api/assets/${meta.id}${meta.ext}`, kind: 'json', plan };
    }
    default:
      throw new Error(`不支持的节点类型: ${node.type}`);
  }
}

function ratioToSize(ratio) {
  switch (ratio) {
    case '3:4': return [768, 1024];
    case '4:3': return [1024, 768];
    case '16:9': return [1024, 576];
    case '9:16': return [576, 1024];
    default: return [1024, 1024];
  }
}

function mockLLM(prompt) {
  if (!prompt) return '（请在文本节点输入提示词）';
  return `【AI 扩写】基于提示词「${prompt.slice(0, 40)}」的创意描述：画面主体清晰，构图采用中心透视，光影层次丰富，色调和谐统一，细节处理精致，整体氛围具有电影质感。`;
}

export function estimateCredits(node) {
  const list = MODELS[node.type] || [];
  const m = list.find((x) => x.id === (node.params?.model || node.params?.modelId));
  return m ? m.credits : (node.type === 'image' ? 3 : node.type === 'video' ? 56 : 1);
}
