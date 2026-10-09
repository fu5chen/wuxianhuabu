// ============================================================
// api/arkAssets.js — AI 虚拟库（方舟私域素材）路由
//   GET  /api/ark-asset/groups            素材组列表
//   GET  /api/ark-asset/list?groupId=     素材列表（默认 keys.json 的 assetGroupId）
//   POST /api/ark-asset/ingest            入库：{ resourceId?, url?, name?, assetType? }
//                                         服务端 CreateAsset + 轮询到 Active/Failed
//   GET  /api/ark-asset/status/:id        查询单个方舟素材状态
// 说明：CreateAsset 仅支持公网 URL（官方不支持 base64）。传 resourceId 时
//       优先用素材元数据里的 sourceUrl（生成结果的火山公网链接）；其次用
//       keys.json 的 publicBaseUrl（内网穿透地址）拼出本服务的公网下载链接。
// ============================================================
import {
  isArkAssetEnabled, createArkAsset, createArkAssetGroup, getArkAsset,
  listArkAssetGroups, listArkAssets, waitArkAssetActive,
} from '../aiAdapter/arkAsset.js';
import { getAsset, updateAssetMeta } from '../storage/assets.js';
import { getKeyField } from '../config/keys.js';
import { tunnelPublicUrl, tunnelToken } from '../tunnel/ngrok.js';

/** 由 mime 推断 AssetType */
function assetTypeOf(mime) {
  if (/^video\//.test(mime || '')) return 'Video';
  if (/^audio\//.test(mime || '')) return 'Audio';
  return 'Image';
}

export async function handleArkAssetApi(ctx) {
  const { req, res, u, body, sendJson } = ctx;
  const p = u.pathname;

  if (!isArkAssetEnabled()) {
    sendJson(res, 200, { ok: false, error: '未配置火山引擎 AK/SK（keys.json: volcAccessKey/volcSecretKey）' });
    return true;
  }

  try {
    // 素材组列表
    if (p === '/api/ark-asset/groups' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, groups: await listArkAssetGroups() });
      return true;
    }
    // 素材列表
    if (p === '/api/ark-asset/list' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, assets: await listArkAssets({ groupId: u.searchParams.get('groupId') || undefined }) });
      return true;
    }
    // 单个方舟素材状态
    const mStatus = p.match(/^\/api\/ark-asset\/status\/([\w-]+)$/);
    if (mStatus && req.method === 'GET') {
      sendJson(res, 200, { ok: true, asset: await getArkAsset(mStatus[1]) });
      return true;
    }
    // 入库（CreateAsset + 轮询）
    if (p === '/api/ark-asset/ingest' && req.method === 'POST') {
      const { resourceId, url, name, assetType, groupId } = body || {};

      let publicUrl = url || null;
      let type = assetType || null;
      if (!publicUrl && resourceId) {
        const meta = getAsset(resourceId);
        if (!meta) { sendJson(res, 404, { ok: false, error: '本地素材不存在' }); return true; }
        type = type || assetTypeOf(meta.mime);
        // 公网 URL 取用优先级：素材自带 sourceUrl（生成结果的火山链接）
        // > 临时隧道（ngrok，开启时带令牌）> keys.json: publicBaseUrl（常驻穿透地址）
        publicUrl = meta.sourceUrl;
        const tunnelBase = tunnelPublicUrl();
        const base = (tunnelBase || getKeyField('publicBaseUrl')).replace(/\/+$/, '');
        if (!publicUrl && base) {
          publicUrl = `${base}/api/assets/${resourceId}`;
          if (tunnelBase) publicUrl += `?k=${tunnelToken()}`;
        }
      }
      if (!publicUrl) {
        sendJson(res, 400, {
          ok: false,
          error: '该素材没有公网 URL，无法入库（官方 CreateAsset 仅支持公网 URL，不支持 base64）。'
            + '生成结果（图片/视频）自带火山公网链接可直接入库；本地上传的文件需先提供公网地址。',
        });
        return true;
      }

      // 素材组不存在/未配置时自动创建（AIGC 组，回写 keys.json）
      let arkId = null;
      try {
        arkId = await createArkAsset({ groupId, url: publicUrl, name, assetType: type });
      } catch (e) {
        if (/group/i.test(String(e.code || '') + e.message)) {
          await createArkAssetGroup();
          arkId = await createArkAsset({ groupId: undefined, url: publicUrl, name, assetType: type });
        } else throw e;
      }
      if (!arkId) { sendJson(res, 500, { ok: false, error: 'CreateAsset 未返回素材 ID' }); return true; }

      // 本地素材记录映射，并轮询过审结果
      if (resourceId) updateAssetMeta(resourceId, { arkAssetId: arkId, arkStatus: 'Processing' });
      const final = await waitArkAssetActive(arkId, { timeoutMs: 150000 });
      if (resourceId) updateAssetMeta(resourceId, { arkStatus: final.Status, arkError: final.Error?.Message || null });

      sendJson(res, 200, {
        ok: final.Status === 'Active',
        arkId,
        status: final.Status,
        error: final.Error?.Message || null,
        url: publicUrl,
      });
      return true;
    }

    return false;
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e.message });
    return true;
  }
}
