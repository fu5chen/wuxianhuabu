// ============================================================
// aiAdapter/jimengImage.js — 即梦AI 图片生成4.0（火山引擎视觉服务）
// 接口：https://visual.volcengineapi.com  Region=cn-north1  Service=cv
//   提交任务 Action=CVSync2AsyncSubmitTask  Version=2022-08-31
//   查询结果 Action=CVSync2AsyncGetResult
//   req_key = jimeng_t2i_v40（即梦图片4.0）
// 鉴权：火山引擎 AK/SK 的 V4 HMAC-SHA256 签名（keys.json: volcAccessKey / volcSecretKey）
// 生命周期：提交 → 轮询(3s) → 下载图片落盘 / 本地取消
// ============================================================
import crypto from 'node:crypto';
import fs from 'node:fs';
import { getKeyField } from '../config/keys.js';
import { getAsset, createAsset, updateAssetMeta } from '../storage/assets.js';

const HOST = 'visual.volcengineapi.com';
const REGION = 'cn-north-1';
const SERVICE = 'cv';

/** 前端模型 ID → 视觉服务 req_key（可用 keys.json 字段覆盖）
 *  每个下拉模型对应一个独立配置槽位；未配置该模型服务标识 → 返回空串，
 *  上层据此跳过即梦通道（不冒充其他模型），回落方舟/mock */
export function reqKeyFor(node) {
  const m = node?.params?.model;
  if (m === 'jimeng-4.6') return getKeyField('jimeng46ReqKey', 'jimeng_seedream46_cvtob');
  if (m === 'image-5.0-lite') return getKeyField('image50LiteReqKey');
  if (m === 'image-5.0-pro') return getKeyField('image50ProReqKey');
  if (m === 'nano-banana-pro') return getKeyField('nanoBananaProReqKey');
  if (m === 'gpt-image-2.0') return getKeyField('gptImage2ReqKey');
  // jimeng-4.0 与未知模型（旧节点未存 model）：默认即梦图片4.0
  return getKeyField('jimengImageReqKey', 'jimeng_t2i_v40');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- V4 签名（与官方 Python demo 逐字对齐） ---------- */
const hmac = (key, msg) => crypto.createHmac('sha256', key).update(String(msg), 'utf8').digest();
const sha256hex = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

export function signV4({ ak, sk, query, body, now }) {
  const t = now ? new Date(now) : new Date();
  const xDate = t.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); // YYYYMMDDTHHMMSSZ (UTC)
  const datestamp = xDate.slice(0, 8);
  const payloadHash = sha256hex(body);
  const signedHeaders = 'content-type;host;x-content-sha256;x-date';
  const canonicalHeaders =
    'content-type:application/json\n' +
    `host:${HOST}\n` +
    `x-content-sha256:${payloadHash}\n` +
    `x-date:${xDate}\n`;
  const canonicalRequest = ['POST', '/', query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope = `${datestamp}/${REGION}/${SERVICE}/request`;
  const stringToSign = ['HMAC-SHA256', xDate, credentialScope, sha256hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(sk, datestamp), REGION), SERVICE), 'request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  const authorization = `HMAC-SHA256 Credential=${ak}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { xDate, authorization, payloadHash };
}

export function isJimengImageEnabled() {
  return !!(getKeyField('volcAccessKey') && getKeyField('volcSecretKey'));
}

/* ---------- 节点级取消（本地标记，轮询即停） ---------- */
const active = new Map(); // nodeId -> { taskId, cancelled }
const pendingCancel = new Set(); // 任务提交前用户已点取消的节点（提交后立即中止）
export function getJimengImageTaskId(nodeId) { return active.get(nodeId)?.taskId || null; }
export function cancelJimengImageTask(nodeId) {
  const st = active.get(nodeId);
  if (!st) return { ok: false, noTask: true }; // 无进行中的即梦任务，由调用方决定走其他通道或登记预取消
  st.cancelled = true; // 即梦取消是本地轮询中止，必然成功
  return { ok: true };
}
/** 任务提交前登记预取消（提交成功后立即中止） */
export function markJimengPendingCancel(nodeId) { pendingCancel.add(nodeId); }

/* ---------- 参考图收集：手动上传 + 连线上游（只取即梦支持的位图格式） ---------- */
function refMetas(node) {
  const metas = [];
  const seen = new Set();
  const push = (meta) => {
    if (!meta || seen.has(meta.id)) return;
    seen.add(meta.id);
    if (!/^image\/(png|jpe?g|bmp|webp)$/i.test(meta.mime)) return; // SVG 占位/其他类型跳过
    metas.push(meta);
  };
  const pinned = node.params?.refResourceId && getAsset(node.params.refResourceId);
  if (pinned) push(pinned);
  for (const u of node.upstreamResults || []) {
    if (u?.resourceId) push(getAsset(u.resourceId));
  }
  return metas;
}

function refBase64List(node) {
  return refMetas(node)
    .map((meta) => {
      try { return fs.readFileSync(meta.file).toString('base64'); } catch { return null; }
    })
    .filter(Boolean);
}

/** 探测图片像素尺寸（PNG/JPEG/GIF/WebP 头解析），失败返回 null */
function imageSizeOf(buf) {
  try {
    if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let off = 2;
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xff) { off++; continue; }
        const mk = buf[off + 1];
        if (mk === 0x01 || (mk >= 0xd0 && mk <= 0xd7)) { off += 2; continue; }
        const len = buf.readUInt16BE(off + 2);
        if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) {
          return { w: buf.readUInt16BE(off + 7), h: buf.readUInt16BE(off + 5) };
        }
        off += 2 + len;
      }
      return null;
    }
    if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'GIF') return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const fmt = buf.toString('ascii', 12, 16);
      if (fmt === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
      if (fmt === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
      }
      if (fmt === 'VP8X') return { w: (buf.readUIntLE(24, 3)) + 1, h: (buf.readUIntLE(27, 3)) + 1 };
    }
  } catch { /* fallthrough */ }
  return null;
}

/** 参考图宽高比 → 输出 width/height（像素总量与 2K 档一致，边长取 8 的倍数）
 *  有参考图时输出比例跟随参考图，不改掉用户上传图的比例 */
function whFromRefAspect(node) {
  const metas = refMetas(node);
  if (!metas.length) return null;
  let dim = null;
  for (const meta of metas) {
    try { dim = imageSizeOf(fs.readFileSync(meta.file)); } catch { dim = null; }
    if (dim?.w && dim?.h) break;
  }
  if (!dim) return null;
  const ratio = Math.min(16, Math.max(1 / 16, dim.w / dim.h));
  const area = 2048 * 2048; // 与 ratioToWH 默认档位相同的像素预算
  // h = sqrt(area / ratio)，w = ratio * h
  const h = Math.sqrt(area / ratio);
  const w = ratio * h;
  return [Math.max(512, Math.round(w / 8) * 8), Math.max(512, Math.round(h / 8) * 8)];
}

/** 比例 → 即梦 width/height（像素总数约 2K 档，比例范围 [1/16,16] 内） */
function ratioToWH(ratio) {
  switch (ratio) {
    case '3:4': return [1776, 2368];
    case '4:3': return [2368, 1776];
    case '16:9': return [2560, 1440];
    case '9:16': return [1440, 2560];
    default: return [2048, 2048];
  }
}

/** 组装提交任务请求体：比例优先级 = 用户显式选择 > 参考图跟随 > 默认 1:1。
 *  具体规则：面板选了 3:4/4:3/16:9/9:16 → 按选择出图；
 *  保持默认 1:1 且有参考图 → 跟随参考图比例（不改变上传图的比例，防止竖图被压方） */
export function buildSubmitBody(node) {
  const p = node.params || {};
  const ratio = p.ratio || '1:1';
  const [width, height] = (ratio === '1:1' && whFromRefAspect(node)) || ratioToWH(ratio);
  const body = {
    req_key: reqKeyFor(node),
    prompt: p.prompt || '生成一张图片',
    width,
    height,
  };
  const refs = refBase64List(node);
  if (refs.length) body.binary_data_base64 = refs.slice(0, 10);
  // 单图强制 force_single（延迟与费用可控）；count>1 时交给模型按意图出多图
  if (Number(p.count || 1) <= 1) body.force_single = true;
  return body;
}

/** 对一个 signed 请求执行 fetch */
async function signedPost(action, bodyObj) {
  const query = `Action=${action}&Version=2022-08-31`;
  const body = JSON.stringify(bodyObj);
  const { xDate, authorization, payloadHash } = signV4({
    ak: getKeyField('volcAccessKey'), sk: getKeyField('volcSecretKey'), query, body,
  });
  return fetch(`${'https://' + HOST}/?${query}`, {
    method: 'POST',
    headers: {
      'X-Date': xDate,
      Authorization: authorization,
      'X-Content-Sha256': payloadHash,
      'Content-Type': 'application/json',
    },
    body,
  });
}

function bizError(d, fallback) {
  const msg = d?.message || d?.ResponseMetadata?.Error?.Message || d?.data?.message || fallback;
  const code = d?.code ?? d?.ResponseMetadata?.Error?.Code ?? '';
  return new Error(`即梦接口错误 ${code}: ${String(msg).slice(0, 300)}`);
}

/**
 * 运行一个即梦图片4.0任务直到完成（提交 → 轮询 → 下载落盘）
 * @returns {{resourceId:string, url:string, kind:'image', mime:string, taskId:string}}
 */
export async function runJimengImageTask(node, onProgress = () => {}) {
  // 1) 提交任务（提交与轮询必须使用同一 req_key）
  const reqKey = reqKeyFor(node);
  const body = buildSubmitBody(node);
  const subRes = await signedPost('CVSync2AsyncSubmitTask', body);
  const subData = await subRes.json().catch(() => null);
  if (!subRes.ok || !subData || (subData.code !== undefined && subData.code !== 10000)) {
    pendingCancel.delete(node.id); // 提交即失败：清掉预取消，避免误杀下一次运行
    throw bizError(subData, `提交失败 HTTP ${subRes.status}`);
  }
  const taskId = subData.data?.task_id;
  if (!taskId) { pendingCancel.delete(node.id); throw new Error('即梦返回缺少 task_id'); }

  const st = { taskId, cancelled: false };
  active.set(node.id, st);
  // 提交期间用户已点过取消 → 立即中止
  if (pendingCancel.delete(node.id)) {
    active.delete(node.id);
    const err = new Error('已取消');
    err.cancelled = true;
    throw err;
  }
  onProgress(5, { taskId, taskType: '即梦图片4.0' });

  // 2) 轮询（3s 间隔，上限 10 分钟）
  const deadline = Date.now() + 10 * 60 * 1000;
  let tick = 0;
  while (Date.now() < deadline) {
    if (st.cancelled) {
      active.delete(node.id);
      const err = new Error('已取消');
      err.cancelled = true;
      throw err;
    }
    await sleep(3000);
    tick++;
    onProgress(Math.min(95, 10 + tick * 5), { taskId });
    let d;
    try {
      const r = await signedPost('CVSync2AsyncGetResult', { req_key: reqKey, task_id: taskId });
      if (!r.ok) continue; // 单次查询失败继续重试
      d = await r.json();
    } catch { continue; }
    if (!d || (d.code !== undefined && d.code !== 10000)) {
      active.delete(node.id);
      throw bizError(d, '查询结果失败');
    }
    const status = d.data?.status || '';
    if (status === 'done') {
      const urls = d.data?.image_urls || [];
      const b64s = d.data?.binary_data_base64 || [];
      let buf = null, ext = '.jpg';
      if (urls.length) {
        const res = await fetch(urls[0]);
        if (!res.ok) throw new Error(`图片下载失败 ${res.status}`);
        buf = Buffer.from(await res.arrayBuffer());
        ext = (res.headers.get('content-type') || '').includes('png') ? '.png' : '.jpg';
      } else if (b64s.length) {
        buf = Buffer.from(b64s[0], 'base64');
        ext = d.data?.binary_data_type?.[0] === 'png' ? '.png' : '.jpg';
      }
      if (!buf) throw new Error('即梦返回缺少图片数据');
      onProgress(97, { taskId });
      const meta = createAsset({ name: 'jimeng-image' + ext, ext, data: buf });
      // 记录生成结果的原始公网 URL（火山 OBS 链接），供 AI 虚拟库 CreateAsset 入库使用
      if (urls.length) updateAssetMeta(meta.id, { sourceUrl: urls[0] });
      active.delete(node.id);
      return { resourceId: meta.id, url: `/api/assets/${meta.id}${meta.ext}`, kind: 'image', mime: meta.mime, taskId };
    }
    if (status.includes('fail') || status.includes('error') || status === 'expired' || status === 'not_found') {
      active.delete(node.id);
      throw new Error('即梦图片生成失败：' + (d.data?.message || status));
    }
    // in_progress / 其它状态继续轮询
  }
  active.delete(node.id);
  throw new Error('即梦图片生成超时（10 分钟）');
}
