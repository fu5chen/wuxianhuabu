// ============================================================
// aiAdapter/arkAsset.js — 火山方舟 AI 虚拟素材库（私域可信素材）
// 接口：https://ark.cn-beijing.volcengineapi.com  Region=cn-beijing  Service=ark
//   Action=CreateAsset    Version=2024-01-01  上传素材（仅公网 URL，不支持 base64）
//   Action=GetAsset                          查询素材状态（Processing/Active/Failed）
//   Action=ListAssetGroups / ListAssets      素材组/素材列表
//   Action=CreateAssetGroup                  创建素材组
// 用途：素材入库过审后，视频生成以 asset://<素材ID> 引用（真人素材必须）
// 鉴权：V4 HMAC-SHA256（keys.json: volcAccessKey / volcSecretKey）
// ============================================================
import crypto from 'node:crypto';
import { getKeyField, setKeyField } from '../config/keys.js';

const HOST = 'ark.cn-beijing.volcengineapi.com';
const REGION = 'cn-beijing';
const SERVICE = 'ark';
const VERSION = '2024-01-01';

const hmac = (key, msg) => crypto.createHmac('sha256', key).update(String(msg), 'utf8').digest();
const sha256hex = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

/** V4 签名（方舟域；与 jimengImage.signV4 同算法，host/service/region 参数化） */
export function arkSign({ ak, sk, query, body, now }) {
  const t = now ? new Date(now) : new Date();
  const xDate = t.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
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

export function isArkAssetEnabled() {
  return !!(getKeyField('volcAccessKey') && getKeyField('volcSecretKey'));
}

/** 默认素材组（keys.json: assetGroupId；未配置返回空串） */
let runtimeGroupId = null; // 运行期自动创建的组 ID（优先于配置）
export function defaultGroupId() {
  return runtimeGroupId || getKeyField('assetGroupId') || '';
}

/** 创建素材组（GroupType=AIGC 普通素材组），成功后回写 keys.json 记住 */
export async function createArkAssetGroup(name = '无限画布素材组') {
  const d = await arkCall('CreateAssetGroup', {
    Name: String(name).slice(0, 64),
    GroupType: 'AIGC',
    ProjectName: getKeyField('arkProjectName') || 'default',
  });
  const id = d.Result?.Id || d.Id || null;
  if (id) { runtimeGroupId = id; setKeyField('assetGroupId', id); }
  return id;
}

/** 统一的方舟 API 调用（返回解析后的 JSON；非 2xx/业务错误抛异常） */
async function arkCall(action, bodyObj) {
  const ak = getKeyField('volcAccessKey');
  const sk = getKeyField('volcSecretKey');
  if (!ak || !sk) throw new Error('未配置火山引擎 AK/SK（keys.json: volcAccessKey/volcSecretKey）');
  const body = JSON.stringify(bodyObj || {});
  const query = `Action=${action}&Version=${VERSION}`; // 规范化 query 不含 '?'（签名用），请求 URL 里再拼 '?'
  const { xDate, authorization, payloadHash } = arkSign({ ak, sk, query, body });
  const r = await fetch(`https://${HOST}/?${query}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Date': xDate,
      'X-Content-Sha256': payloadHash,
      Authorization: authorization,
    },
    body,
  });
  const d = await r.json().catch(() => null);
  const err = d?.ResponseMetadata?.Error || d?.ResponseError || d?.Error || null;
  if (!r.ok || err) {
    const e = new Error(`方舟素材库 ${action} 失败：${err?.Code || r.status} ${err?.Message || ''}`.trim());
    e.code = err?.Code;
    throw e;
  }
  return d;
}

/** 上传素材入库（异步）。url 必须是公网可访问地址；返回素材 Id */
export async function createArkAsset({ groupId, url, name, assetType, projectName }) {
  const g = groupId || defaultGroupId();
  if (!g) throw new Error('未配置素材组 ID（keys.json: assetGroupId）');
  const d = await arkCall('CreateAsset', {
    GroupId: g,
    URL: url,
    ...(name ? { Name: String(name).slice(0, 64) } : {}),
    AssetType: assetType, // Image | Video | Audio
    ProjectName: projectName || getKeyField('arkProjectName') || 'default',
  });
  return d.Id || d.Result?.Id || null;
}

/** 查询素材状态：{ Id, Status: Processing|Active|Failed, Error, URL, ... } */
export async function getArkAsset(id) {
  const d = await arkCall('GetAsset', {
    Id: id,
    ProjectName: getKeyField('arkProjectName') || 'default',
  });
  return d.Result || d;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询直到 Active / Failed（默认上限 150s，3s 一次） */
export async function waitArkAssetActive(id, { timeoutMs = 150000, intervalMs = 3000, onTick } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const a = await getArkAsset(id);
    const status = a?.Status || 'Processing';
    if (onTick) try { onTick(status, a); } catch { /* noop */ }
    if (status === 'Active' || status === 'Failed') return a;
    await sleep(intervalMs);
  }
  return { Id: id, Status: 'Processing' };
}

/** 素材组列表（GroupType: AIGC=普通素材组 / LivenessFace=真人认证素材组，两种都拉） */
export async function listArkAssetGroups() {
  const pn = getKeyField('arkProjectName') || 'default';
  const out = [];
  for (const gt of ['AIGC', 'LivenessFace']) {
    try {
      const d = await arkCall('ListAssetGroups', { Filter: { GroupType: gt }, ProjectName: pn });
      const items = d.Result?.Items || d.Items || d.Result || [];
      if (Array.isArray(items)) out.push(...items);
    } catch { /* 某类型无权限/无数据时跳过 */ }
  }
  return out;
}

/** 素材列表（可按 groupId 过滤） */
export async function listArkAssets({ groupId } = {}) {
  const body = { Filter: { GroupType: 'AIGC' }, ProjectName: getKeyField('arkProjectName') || 'default' };
  if (groupId || defaultGroupId()) body.GroupId = groupId || defaultGroupId();
  const d = await arkCall('ListAssets', body);
  return d.Result || d;
}
