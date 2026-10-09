// ============================================================
// services/api.js — 后端 HTTP / SSE / 上传封装
// ============================================================

// 模型清单兜底（正常从 GET /api/user 拉取）
export const MODELS_FALLBACK = {
  image: [
    { id: 'image-5.0-lite', name: '图片 5.0 Lite', credits: 3, sizes: ['1K', '2K', '4K'], ratios: ['1:1', '3:4', '4:3', '16:9', '9:16'] },
    { id: 'image-5.0-pro', name: '图片 5.0 Pro', credits: 8, sizes: ['2K', '4K'], ratios: ['1:1', '3:4', '4:3', '16:9', '9:16'] },
    { id: 'nano-banana-pro', name: 'Nano Banana Pro', credits: 10, sizes: ['1K', '2K', '4K'], ratios: ['1:1', '3:4', '4:3', '16:9', '9:16'] },
    { id: 'gpt-image-2.0', name: 'GPT Image 2.0', credits: 12, sizes: ['1K', '2K', '4K'], ratios: ['1:1', '3:4', '4:3', '16:9', '9:16'] },
  ],
  video: [
    { id: 'seedance-2.0', name: '即梦 Seedance 2.0', credits: 56, minDur: 4, maxDur: 15, resolutions: ['480P', '720P', '1080P'] },
    { id: 'seedance-2.0-vip', name: '即梦 Seedance 2.0 VIP', credits: 120, minDur: 4, maxDur: 15, resolutions: ['720P', '1080P'] },
    { id: 'seedance-2.5', name: '即梦 Seedance 2.5', credits: 90, minDur: 4, maxDur: 30, resolutions: ['480P', '720P', '1080P'] },
  ],
  audio: [{ id: 'tts-v2', name: '语音合成 TTS v2', credits: 2 }],
  text: [{ id: 'llm-lite', name: '文本模型 Lite', credits: 1 }],
};

async function jfetch(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  listProjects: () => jfetch('/api/projects'),
  createProject: (name) => jfetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }),
  getProject: (id) => jfetch(`/api/projects/${id}`),
  saveProject: (id, doc) => jfetch(`/api/projects/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(doc) }),
  deleteProject: (id) => jfetch(`/api/projects/${id}`, { method: 'DELETE' }),

  getUser: () => jfetch('/api/user'),
  runWorkflow: (nodes, edges) => jfetch('/api/tasks/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nodes, edges }) }),
  cancelWorkflow: (runId) => jfetch('/api/tasks/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId }) }),
  /** 取消单个节点正在进行的生成任务（Seedance DELETE） */
  cancelNodeTask: (nodeId) => jfetch('/api/tasks/cancel-node', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nodeId }) }),

  listAssets: () => jfetch('/api/assets'),
  deleteAsset: (id) => jfetch(`/api/assets/${id}`, { method: 'DELETE' }),

  /** 视频文件夹管理 */
  listVideos: () => jfetch('/api/videos'),
  deleteVideo: (id) => jfetch(`/api/videos/${id}`, { method: 'DELETE' }),

  /** 分组打包下载：POST /api/export/group → zip Blob */
  async exportGroup(payload) {
    const res = await fetch('/api/export/group', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { msg = (await res.json()).error || msg; } catch { /* noop */ }
      throw new Error(msg);
    }
    return res.blob();
  },

  /** 上传本地文件（File 对象 → base64 JSON） */
  async uploadFile(file) {
    const buf = await file.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buf);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    const dataBase64 = btoa(binary);
    return jfetch('/api/assets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: file.name, mime: file.type, dataBase64 }),
    });
  },
};

/** SSE 订阅任务事件 */
export function openEventStream(handlers) {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => {
    if (!e.data) return;
    try {
      const evt = JSON.parse(e.data);
      handlers?.(evt);
    } catch { /* ignore */ }
  };
  es.onerror = () => { /* 自动重连由浏览器处理 */ };
  return es;
}
