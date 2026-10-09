// ============================================================
// config/keys.js — API Key 配置（server/config/keys.json）
// Key 只存在服务端本地文件中，绝不通过任何 API 下发到前端页面。
// 填好 keys.json 后重启服务生效；未填写的模型继续走 mock。
// 可用字段：
//   jimeng              火山方舟 API Key（启用 Seedance 视频 / Seedream 图片生成）
//   jimengBaseUrl       默认 https://ark.cn-beijing.volces.com/api/v3
//   jimengVideoModel    文生视频模型，默认 doubao-seedance-1-0-pro-250528
//   jimengOmniVideoModel 2.5 全模态模型，默认 doubao-seedance-2-5-260628
//   jimengImageModel    图片模型（方舟通道），默认 doubao-seedream-4-0-250828
//   volcAccessKey       火山引擎访问密钥 AK（启用即梦图片4.0/4.6：visual.volcengineapi.com 通道）
//   volcSecretKey       火山引擎访问密钥 SK（与 AK 配对，V4 签名用）
//   jimengImageReqKey   即梦图片4.0服务标识，默认 jimeng_t2i_v40
//   jimeng46ReqKey      即梦图片4.6服务标识，默认 jimeng_seedream46_cvtob
//   image50LiteReqKey / image50ProReqKey / nanoBananaProReqKey / gptImage2ReqKey
//                       对应下拉其余图片模型的服务标识，留空走 mock（不冒充即梦）
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));

let KEY_CONFIG = {};
try {
  KEY_CONFIG = JSON.parse(fs.readFileSync(path.resolve(__dir, 'keys.json'), 'utf-8'));
} catch { /* 未配置文件则全部走 mock */ }

export function getApiKey(provider) {
  return String(KEY_CONFIG[provider] || process.env[`${String(provider).toUpperCase()}_API_KEY`] || '');
}
export function hasApiKey(provider) { return !!getApiKey(provider); }
export function getKeyField(name, fallback = '') {
  const v = KEY_CONFIG[name] ?? process.env[name.toUpperCase()];
  return v === undefined || v === null || v === '' ? fallback : String(v);
}
/** 运行期写回某个字段（内存立即生效 + 持久化到 keys.json，如自动创建的素材组 ID） */
export function setKeyField(name, value) {
  KEY_CONFIG[name] = String(value);
  try {
    const file = path.resolve(__dir, 'keys.json');
    const json = JSON.parse(fs.readFileSync(file, 'utf-8'));
    json[name] = String(value);
    fs.writeFileSync(file, JSON.stringify(json, null, 2));
  } catch { /* 写失败只影响持久化，内存值仍生效 */ }
}
