// ============================================================
// aiAdapter/arkVideo.js — 火山方舟 Seedance 2.5 视频任务通道
// 四类任务（omni_reference_task_type）：
//   文生视频   t2v       doubao-seedance-1-0-pro-250528（简单 content + watermark）
//   全模态参考 reference doubao-seedance-2-5-260628（text + 图/视频参考）
//   编辑视频   edit      ratio=adaptive, duration=-1
//   延长视频   extend    ratio=adaptive, duration=延长后的总时长
// 生命周期：创建 → 轮询(GET) → 成功下载落盘 / 取消(DELETE)
// ============================================================
import fs from 'node:fs';
import { getApiKey, getKeyField } from '../config/keys.js';
import { getAsset, updateAssetMeta } from '../storage/assets.js';
import { saveVideo } from '../storage/videos.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const arkBase = () => getKeyField('jimengBaseUrl', 'https://ark.cn-beijing.volces.com/api/v3');
const OMNI_MODEL = () => getKeyField('jimengOmniVideoModel', 'doubao-seedance-2-5-260628');
const T2V_MODEL = () => getKeyField('jimengVideoModel', 'doubao-seedance-1-0-pro-250528');
const headers = () => ({ 'Authorization': `Bearer ${getApiKey('jimeng')}`, 'Content-Type': 'application/json' });

export function isArkVideoEnabled() { return !!getApiKey('jimeng'); }

/** nodeId -> { taskId, cancelled }（运行中的方舟任务，用于节点级取消） */
const active = new Map();
/** 任务创建前用户就点了取消的节点（任务建立后立即删除，避免"点了没反应"） */
const pendingCancel = new Set();

export function getArkTaskId(nodeId) { return active.get(nodeId)?.taskId || null; }

/** 取消节点正在进行的方舟任务：先调方舟 DELETE，**远端确认成功**才置本地取消标志（轮询立即中止）。
 *  远端拒绝或网络失败 → 返回 {ok:false,error}，任务继续运行（前端不当作已取消） */
export async function cancelArkVideoTask(nodeId) {
  const st = active.get(nodeId);
  if (!st) return { ok: false, noTask: true }; // 没有运行中的方舟任务，由调用方决定走其他通道或登记预取消
  let res;
  try {
    res = await fetch(`${arkBase()}/contents/generations/tasks/${st.taskId}`, {
      method: 'DELETE', headers: headers(),
    });
  } catch (e) {
    return { ok: false, error: '网络错误：' + (e.message || e) };
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    return { ok: false, error: `Seedance 返回 ${res.status}：${t.slice(0, 120)}` };
  }
  st.cancelled = true; // 远端已确认删除 → 本地轮询立即中止
  return { ok: true };
}

/** 任务尚未建立（提交中）时登记预取消：任务创建成功后立即尝试删除 */
export function markPendingCancel(nodeId) { pendingCancel.add(nodeId); }

function fileDataUri(meta) {
  try {
    const b = fs.readFileSync(meta.file);
    return `data:${meta.mime};base64,${b.toString('base64')}`;
  } catch { return null; }
}

/** 收集上游参考素材：连线/@引用 → 方舟参考项
 *  image → reference_image，video → reference_video，audio → reference_audio（audio_url）
 *  已在 AI 虚拟库过审（Active）的素材优先用 asset://素材ID 引用（真人素材必须，且免传大 base64） */
function refItems(node) {
  const items = [];
  const push = (meta, role, type) => {
    // 已过审素材 → asset:// URI；否则回退 base64
    let uri = null;
    if (meta.arkAssetId && meta.arkStatus === 'Active') uri = `asset://${meta.arkAssetId}`;
    else uri = fileDataUri(meta);
    if (!uri) return;
    if (type === 'image') items.push({ type: 'image_url', image_url: { url: uri }, role });
    else if (type === 'audio') items.push({ type: 'audio_url', audio_url: { url: uri }, role });
    else items.push({ type: 'video_url', video_url: { url: uri }, role });
  };
  // 手动上传参考图优先
  const pinned = node.params?.refResourceId && getAsset(node.params.refResourceId);
  if (pinned && /^image\//.test(pinned.mime)) push(pinned, 'reference_image', 'image');
  for (const u of node.upstreamResults || []) {
    const meta = u?.resourceId && getAsset(u.resourceId);
    if (!meta) continue;
    if (/^image\//.test(meta.mime)) push(meta, 'reference_image', 'image');
    else if (/^video\//.test(meta.mime)) push(meta, 'reference_video', 'video');
    else if (/^audio\//.test(meta.mime)) push(meta, 'reference_audio', 'audio');
  }
  return items;
}

/** 前端模式 → 方舟任务类型 */
export function modeToTaskType(mode) {
  switch (mode) {
    case '文生视频': return 't2v';
    case '编辑视频': return 'edit';
    case '延长视频': return 'extend';
    default: return 'reference'; // 全能参考
  }
}

/** 组装方舟任务创建请求体 */
export function buildTaskBody(node) {
  const p = node.params || {};
  const type = modeToTaskType(p.mode);

  if (type === 't2v') {
    // 文生视频：doubao-seedance-1-0-pro，参数拼进提示词（方舟协议）
    const quality = /1080/i.test(p.resolution) ? '1080p' : /480/i.test(p.resolution) ? '480p' : '720p';
    const text = `${p.prompt || '生成一段视频'} --resolution ${quality} --duration ${Math.round(Number(p.duration) || 5)} --fps 24`;
    return {
      model: T2V_MODEL(),
      content: [{ type: 'text', text }],
      ratio: p.ratio || '16:9',
      duration: Math.round(Number(p.duration) || 5),
      watermark: false,
    };
  }

  // 2.5 全模态：text + 参考项
  const content = [{ type: 'text', text: p.prompt || '' }, ...refItems(node)];
  const extra_body = { omni_reference_task_type: type, output_format: 'mov' };
  if (type === 'edit') {
    return { model: OMNI_MODEL(), content, generate_audio: true, ratio: 'adaptive', duration: -1, extra_body };
  }
  if (type === 'extend') {
    // 延长视频：第一个 video 参考是要被延长的源视频，duration = 延长后的总时长
    return { model: OMNI_MODEL(), content, generate_audio: true, ratio: 'adaptive', duration: Math.round(Number(p.duration) || 11), extra_body };
  }
  // 全模态参考
  return { model: OMNI_MODEL(), content, generate_audio: true, ratio: p.ratio || '16:9', duration: Math.round(Number(p.duration) || 15), extra_body };
}

/**
 * 运行一个 Seedance 视频任务直到完成（创建 → 轮询 → 下载落盘）
 * @param {object} node 画布节点
 * @param {(pct:number, extra?:object)=>void} onProgress
 * @returns {{resourceId:string, url:string, kind:'video', mime:string, taskId:string}}
 */
export async function runArkVideoTask(node, onProgress = () => {}) {
  const body = buildTaskBody(node);
  let createRes;
  try {
    createRes = await fetch(`${arkBase()}/contents/generations/tasks`, {
      method: 'POST', headers: headers(), body: JSON.stringify(body),
    });
  } catch (e) {
    pendingCancel.delete(node.id); // 创建即失败：清掉预取消，避免误杀下一次运行
    throw e;
  }
  if (!createRes.ok) {
    pendingCancel.delete(node.id);
    throw new Error(`Seedance 任务创建失败 ${createRes.status}: ${(await createRes.text()).slice(0, 200)}`);
  }
  const { id: taskId } = await createRes.json();

  const st = { taskId, cancelled: false };
  active.set(node.id, st);
  // 任务创建期间用户已点过取消 → 尝试删除刚建的任务；远端拒绝则任务继续运行（如实反馈）
  if (pendingCancel.delete(node.id)) {
    let delOk = false;
    try {
      const r = await fetch(`${arkBase()}/contents/generations/tasks/${taskId}`, { method: 'DELETE', headers: headers() });
      delOk = r.ok;
    } catch { /* 走继续运行分支 */ }
    if (delOk) {
      active.delete(node.id);
      const err = new Error('已取消');
      err.cancelled = true;
      throw err;
    }
  }
  onProgress(5, { taskId, taskType: node.params?.mode || '全能参考' });

  // 轮询任务（10s 间隔，上限 30 分钟；取消标志 0.5s 内响应）
  const deadline = Date.now() + 30 * 60 * 1000;
  let tick = 0;
  while (Date.now() < deadline) {
    for (let i = 0; i < 20 && !st.cancelled; i++) await sleep(500);
    if (st.cancelled) {
      active.delete(node.id);
      const err = new Error('已取消');
      err.cancelled = true;
      throw err;
    }
    await sleep(10000);
    tick++;
    onProgress(Math.min(95, 8 + tick * 2), { taskId });
    let d;
    try {
      const r = await fetch(`${arkBase()}/contents/generations/tasks/${taskId}`, { headers: headers() });
      if (!r.ok) continue;
      d = await r.json();
    } catch { continue; } // 单次查询失败继续重试

    if (d.status === 'succeeded') {
      const videoUrl = d.content?.video_url;
      if (!videoUrl) throw new Error('Seedance 返回缺少 video_url');
      onProgress(97, { taskId });
      const res = await fetch(videoUrl);
      if (!res.ok) throw new Error(`视频下载失败 ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const ct = (res.headers.get('content-type') || '').split(';')[0];
      const ext = ct.includes('webm') ? '.webm' : (ct.includes('quicktime') || /\.mov(\?|$)/i.test(videoUrl)) ? '.mov' : '.mp4';
      const saved = saveVideo({
        taskId, buffer: buf, ext,
        meta: {
          name: node.name || '生成视频',
          model: body.model,
          taskType: node.params?.mode || '全能参考',
          duration: node.params?.duration ?? null,
          nodeId: node.id,
        },
      });
      active.delete(node.id);
      // 记录生成视频的原始公网 URL（预签名链接），供 AI 虚拟库 CreateAsset 入库使用
      if (videoUrl) updateAssetMeta(saved.assetId, { sourceUrl: videoUrl });
      return { resourceId: saved.assetId, url: saved.assetUrl, kind: 'video', mime: saved.mime, taskId };
    }
    if (d.status === 'failed') throw new Error('Seedance 生成失败：' + (d.error?.message || JSON.stringify(d.error || '未知错误')));
    if (d.status === 'cancelled') {
      active.delete(node.id);
      const err = new Error('已取消');
      err.cancelled = true;
      throw err;
    }
  }
  active.delete(node.id);
  throw new Error('Seedance 生成超时（30 分钟）');
}
