// ============================================================
// nodes/nodeRegistry.js — 节点类型定义（图标 / 端口 / 面板配置 / 默认参数）
// ============================================================
import { MODELS_FALLBACK } from '../services/api.js';

export const NODE_TYPES = {
  text: {
    label: '文本', icon: 'text',
    cardH: 180, width: 300,
    hasInput: true, inputAccepts: ['text'], outputType: 'text',
    placeholder: '输入文本，或让 AI 帮你扩写',
  },
  image: {
    label: '图片', icon: 'image',
    cardH: 320, width: 340,
    hasInput: true, inputAccepts: ['image', 'video'], outputType: 'image',
    placeholder: '上传参考图、输入文字或 @ 主体，描述你想生成的图片（也可连接视频作参考）',
  },
  video: {
    label: '视频', icon: 'video',
    cardH: 240, width: 420,
    hasInput: true, inputAccepts: ['image', 'video', 'audio'], outputType: 'video',
    placeholder: '使用 @ 快速调用参考内容，例如：@图片1 模仿 @视频1 的动作，音色参考 @音频1',
  },
  audio: {
    label: '音频', icon: 'audio',
    cardH: 160, width: 320,
    hasInput: true, inputAccepts: ['text', 'audio'], outputType: 'audio',
    placeholder: '输入文本转语音，或描述想要的音效',
  },
  timeline: {
    label: '时间线', icon: 'timeline',
    cardH: 200, width: 460,
    hasInput: true, inputAccepts: ['video', 'image'], outputType: 'video',
    placeholder: '时序编排：把上游视频/图片按时间轴串起来',
  },
  subject: {
    label: '主体', icon: 'subject',
    cardH: 240, width: 300,
    hasInput: true, inputAccepts: ['image', 'text'], outputType: 'image',
    placeholder: '描述角色形象，跨节点复用同一主体',
  },
  director: {
    label: '导演台', icon: 'director',
    cardH: 220, width: 380,
    hasInput: true, inputAccepts: ['video', 'image', 'text', 'audio'], outputType: 'text',
    placeholder: '全局分镜调度：@图片1 @视频1 编排镜头脚本，批量执行',
  },
  media: {
    label: '素材', icon: 'image',
    cardH: 300, width: 340,
    hasInput: false, inputAccepts: [], outputType: 'image',
    placeholder: '',
  },
};

export function createNodeData(type, name, pos) {
  const def = NODE_TYPES[type] || NODE_TYPES.image;
  const node = {
    id: `n_${crypto.randomUUID().slice(0, 8)}`,
    type,
    name,
    position: { x: Math.round(pos.x), y: Math.round(pos.y) },
    width: def.width,
    params: defaultParams(type),
    outputs: [{ name: def.outputType, resourceId: null, url: null }],
    status: 'idle', // idle | running | success | failed | skipped
    progress: 0,
  };
  if (type === 'media') {
    node.params = { resourceId: null, url: null, mime: '', name: '' };
    node.outputs = [{ name: 'media', resourceId: null, url: null }];
  }
  return node;
}

function defaultParams(type) {
  switch (type) {
    case 'image': {
      const m = firstModel('image');
      return { prompt: '', model: m?.id, modelName: m?.name, ratio: '1:1', size: '2K', count: 1, refResourceId: null };
    }
    case 'video': {
      const m = firstModel('video');
      return { prompt: '', model: m?.id, modelName: m?.name, ratio: '16:9', resolution: '720P', duration: 4, mode: '全能参考', refResourceId: null };
    }
    case 'audio': {
      const m = firstModel('audio');
      return { prompt: '', model: m?.id, modelName: m?.name, duration: 3 };
    }
    case 'text':
      return { prompt: '', model: firstModel('text')?.id };
    case 'subject':
      return { prompt: '', name: '主体 1' };
    case 'timeline':
      return { prompt: '' };
    case 'director':
      return { prompt: '' };
    default:
      return {};
  }
}

export function firstModel(kind) {
  const models = window.__MODELS || MODELS_FALLBACK;
  return (models[kind] || [])[0] || null;
}
export function modelsOf(kind) {
  return window.__MODELS?.[kind] || MODELS_FALLBACK[kind] || [];
}

/** 端口类型校验（与后端 PORT_RULES 一致）；素材(media)节点按实际内容类型校验 */
export function validateEdgeTypes(sourceType, targetType, srcNode) {
  const target = NODE_TYPES[targetType];
  if (!target || !target.hasInput) return { ok: false, reason: '目标节点不接受输入' };
  const src = NODE_TYPES[sourceType];
  if (!src) return { ok: false, reason: '未知源节点' };
  let outType = src.outputType;
  if (sourceType === 'media') {
    const kind = srcNode?.outputs?.[0]?.kind || (srcNode?.params?.mime || '').split('/')[0];
    outType = ['image', 'video', 'audio', 'text'].includes(kind) ? kind : 'image';
  }
  if (!target.inputAccepts.includes(outType)) {
    const label = { image: '图片', video: '视频', text: '文本', audio: '音频' }[outType] || outType;
    return { ok: false, reason: `${target.label}节点的输入不支持${label}类型` };
  }
  return { ok: true };
}

/** 正则转义（@引用解析 / 芯片高亮共用） */
export function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ---------- 视频模型参考上限（连线时校验） ----------
 * 即梦视频2.0（含 VIP）：图片 ≤ 9 张，音频 ≤ 3 个且总时长 ≤ 15 秒；不可纯音频参考（官方规则：至少搭配 1 张图或 1 段视频）
 * 即梦视频2.5：图片 ≤ 50 张，音频总时长 ≤ 60 秒（支持纯音频参考）
 * 未知模型按 2.5 的宽松规则处理 */
export const VIDEO_REF_LIMITS = {
  'seedance-2.0':     { maxImages: 9,  maxAudioCount: 3, maxAudioSeconds: 15, needMediaWithAudio: true },
  'seedance-2.0-vip': { maxImages: 9,  maxAudioCount: 3, maxAudioSeconds: 15, needMediaWithAudio: true },
  'seedance-2.5':     { maxImages: 50, maxAudioSeconds: 60 },
  default:            { maxImages: 50, maxAudioSeconds: 60 },
};

/** 节点的有效输出类型（素材节点按实际内容判定） */
export function outKindOf(node) {
  if (!node) return null;
  if (node.type === 'media') {
    const kind = node.outputs?.[0]?.kind || (node.params?.mime || '').split('/')[0];
    return ['image', 'video', 'audio', 'text'].includes(kind) ? kind : 'image';
  }
  return NODE_TYPES[node.type]?.outputType || null;
}

/** 节点可提供的音频秒数（音频节点优先取上传时记录的真实时长，其次取面板时长参数） */
export function audioSecondsOf(node) {
  if (!node) return 0;
  if (node.type === 'audio') return Number(node.outputs?.[0]?.duration) || Number(node.params?.duration) || 3;
  return Number(node.outputs?.[0]?.duration) || 0;
}

/**
 * 视频节点连线前的模型上限校验
 * @param {object} targetNode 视频节点
 * @param {Array} incomingSrcs 本次即将接入的来源节点
 * @param {Array} existingUpstreams 目标节点当前已有的上游节点
 * @returns {{ok:boolean, reason?:string}}
 */
export function validateVideoRefs(targetNode, incomingSrcs = [], existingUpstreams = []) {
  if (!targetNode || targetNode.type !== 'video') return { ok: true };
  const modelId = targetNode.params?.model || '';
  const limits = VIDEO_REF_LIMITS[modelId] || VIDEO_REF_LIMITS.default;
  const modelName = modelsOf('video').find((m) => m.id === modelId)?.name || modelId || '视频节点';
  const seen = new Set();
  let images = 0, audios = 0, audioSec = 0, videos = 0;
  for (const n of [...existingUpstreams, ...incomingSrcs]) {
    if (!n || seen.has(n.id)) continue;
    seen.add(n.id);
    const k = outKindOf(n);
    if (k === 'image') images++;
    else if (k === 'audio') { audios++; audioSec += audioSecondsOf(n); }
    else if (k === 'video') videos++;
  }
  if (limits.maxImages !== undefined && images > limits.maxImages) {
    return { ok: false, reason: `连接失败：${modelName} 最多连接 ${limits.maxImages} 张图片（当前已有 ${images} 张）` };
  }
  if (limits.maxAudioCount !== undefined && audios > limits.maxAudioCount) {
    return { ok: false, reason: `连接失败：${modelName} 最多连接 ${limits.maxAudioCount} 个音频（当前已有 ${audios} 个）` };
  }
  if (limits.maxAudioSeconds !== undefined && audioSec > limits.maxAudioSeconds) {
    return { ok: false, reason: `连接失败：${modelName} 音频总时长不能超过 ${limits.maxAudioSeconds} 秒（当前共 ${Math.round(audioSec * 10) / 10} 秒）` };
  }
  if (limits.needMediaWithAudio && audios > 0 && images + videos === 0) {
    return { ok: false, reason: `连接失败：${modelName} 不能只参考音频，至少需要搭配 1 张图片或 1 段视频` };
  }
  return { ok: true };
}

/* ---------- SVG 图标 ---------- */
const ICONS = {
  text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 6h14M12 6v13"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="5" width="16" height="14" rx="2.5"/><circle cx="9.2" cy="10" r="1.6"/><path d="M4.5 17l5-5 4 4 2.5-2.5 3.5 3.5"/></svg>',
  video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3.5" y="5" width="17" height="14" rx="3"/><path d="M10.5 9.5l4.5 2.5-4.5 2.5z" fill="currentColor" stroke="none"/></svg>',
  audio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 10v4M8.5 7v10M12 4.5v15M15.5 7v10M19 10v4" stroke-linecap="round"/></svg>',
  timeline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3.5" y="6" width="17" height="12" rx="2.5"/><path d="M8 6v12M8 10h9"/></svg>',
  subject: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="4" width="14" height="16" rx="3"/><circle cx="12" cy="10" r="2.2"/><path d="M8.5 17c.8-2 2-3 3.5-3s2.7 1 3.5 3"/></svg>',
  director: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="9" r="3.2"/><path d="M12 12.5V19M7.5 19h9M5 9h1.5M17.5 9H19M12 4.5V3"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M15 4l5 5-3.5 1-2.5 5-2-2-4.5 4.5L6 16l4.5-4.5-2-2 5-2.5z"/></svg>',
  emptyImage: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="5" width="16" height="14" rx="2.5"/><circle cx="9.2" cy="10" r="1.6"/><path d="M4.5 17l5-5 4 4 2.5-2.5 3.5 3.5"/></svg>',
  emptyVideo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3.5" y="5" width="17" height="14" rx="3"/><path d="M10.5 9.5l4.5 2.5-4.5 2.5z"/></svg>',
  emptyText: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 6h14M5 11h14M5 16h9"/></svg>',
  emptyAudio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 10v4M8.5 7v10M12 4.5v15M15.5 7v10M19 10v4" stroke-linecap="round"/></svg>',
};
export function icon(name) { return ICONS[name] || ICONS.image; }
