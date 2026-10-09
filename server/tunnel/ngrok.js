// ============================================================
// tunnel/ngrok.js — 临时内网穿透（ngrok）+ 安全开关
//   startTunnel()  启动 ngrok 隧道（首次自动下载到 bin/ngrok.exe），
//                  生成一次性访问令牌；公网请求须带 ?k=<令牌>
//   stopTunnel()   关闭隧道，令牌立即失效
//   guardRequest() 请求守卫：经隧道进来的请求（带 X-Forwarded-For）必须
//                  携带令牌；本机/局域网直连不受影响
// 说明：设计为「入库时临时开启、用完关闭」——隧道开启期间整个画布服务
//       对公网可见，令牌机制防止陌生人浏览/调用。
// ============================================================
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { getKeyField } from '../config/keys.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_LOCAL = path.join(__dirname, '../../bin/ngrok.exe');
const NGROK_ZIP_URL = 'https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip';
const NGROK_API = 'http://127.0.0.1:4040/api/tunnels';

const state = { child: null, url: null, token: null, startedAt: null, error: null };

export function tunnelStatus() {
  return {
    active: !!(state.child && state.url),
    url: state.url,
    token: state.token,
    startedAt: state.startedAt,
    error: state.error,
  };
}

/** 隧道公网地址（未开启返回 null），供入库拼 URL 用 */
export function tunnelPublicUrl() {
  return state.child && state.url ? state.url : null;
}

/** 当前隧道令牌 */
export function tunnelToken() {
  return state.token;
}

/** 请求守卫：true = 拒绝（公网请求未带令牌/令牌错误） */
export function guardRequest(req, u) {
  if (!(state.child && state.url)) return false;
  // 只有经 ngrok 转发的请求才带 X-Forwarded-For；本机直连放行
  if (!req.headers['x-forwarded-for'] && !req.headers['ngrok-client-ip'] && !req.headers['x-original-host']) return false;
  const k = u.searchParams.get('k') || req.headers['x-tunnel-token'] || '';
  return k !== state.token;
}

/** 定位 ngrok 可执行文件：keys.json ngrokPath > 项目 bin/ > 自动下载 */
async function resolveBinary() {
  const configured = getKeyField('ngrokPath');
  if (configured && fs.existsSync(configured)) return configured;
  if (fs.existsSync(BIN_LOCAL)) return BIN_LOCAL;
  try {
    return await downloadBinary();
  } catch (e) {
    throw new Error(
      '未找到 ngrok.exe 且自动下载失败（' + e.message + '）。'
      + '请到 https://ngrok.com/download 手动下载，解压后在 keys.json 的 ngrokPath 填入 ngrok.exe 完整路径'
    );
  }
}

/** 自动下载 ngrok（zip）并用内置解压提取 ngrok.exe */
async function downloadBinary() {
  const r = await fetch(NGROK_ZIP_URL, { redirect: 'follow' });
  if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}`);
  const zip = Buffer.from(await r.arrayBuffer());
  const exe = unzipEntry(zip, 'ngrok.exe');
  fs.mkdirSync(path.dirname(BIN_LOCAL), { recursive: true });
  fs.writeFileSync(BIN_LOCAL, exe);
  return BIN_LOCAL;
}

/** 零依赖 zip 单文件提取（EOCD → 中央目录 → 本地头 → inflateRaw） */
function unzipEntry(zipBuf, targetName) {
  let eocd = -1;
  for (let i = zipBuf.length - 22; i >= Math.max(0, zipBuf.length - 22 - 65535); i--) {
    if (zipBuf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('下载内容不是有效的 zip');
  const count = zipBuf.readUInt16LE(eocd + 10);
  let off = zipBuf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (zipBuf.readUInt32LE(off) !== 0x02014b50) break;
    const method = zipBuf.readUInt16LE(off + 10);
    const compSize = zipBuf.readUInt32LE(off + 20);
    const nameLen = zipBuf.readUInt16LE(off + 28);
    const extraLen = zipBuf.readUInt16LE(off + 30);
    const cmtLen = zipBuf.readUInt16LE(off + 32);
    const localOff = zipBuf.readUInt32LE(off + 42);
    const name = zipBuf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    if (name.toLowerCase() === targetName.toLowerCase()) {
      const lhNameLen = zipBuf.readUInt16LE(localOff + 26);
      const lhExtraLen = zipBuf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lhNameLen + lhExtraLen;
      const data = zipBuf.slice(dataStart, dataStart + compSize);
      return method === 0 ? Buffer.from(data) : inflateRawSync(data);
    }
    off += 46 + nameLen + extraLen + cmtLen;
  }
  throw new Error(`zip 中未找到 ${targetName}`);
}

/** 启动隧道（幂等） */
export async function startTunnel() {
  if (state.child && state.url) return tunnelStatus();
  const port = process.env.PORT ? Number(process.env.PORT) : 3210;
  const bin = await resolveBinary();
  const authtoken = getKeyField('ngrokAuthToken');
  const args = ['http', String(port), '--log=stdout', '--log-format=json'];
  if (authtoken) args.push('--authtoken=' + authtoken);

  state.token = crypto.randomBytes(16).toString('hex');
  state.error = null;
  state.startedAt = Date.now();
  state.url = null;
  // ngrok 免费版不允许走 http/s 代理（ERR_NGROK_9009）：剥离系统代理环境变量
  const env = { ...process.env };
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[k];
  const child = spawn(bin, args, { windowsHide: true, env });
  state.child = child;
  let lastErrLine = '';
  child.stderr.on('data', (d) => {
    // 记录 ngrok 自身报错（如 ERR_NGROK_xxxx），退出时带回给用户
    const m = d.toString().split('\n').filter((l) => /ERROR|failed|ngrok/i.test(l)).pop();
    if (m) lastErrLine = m.trim().slice(0, 300);
  });
  child.on('exit', (code) => {
    state.child = null;
    state.url = null;
    if (code && code !== 0) {
      state.error = 'ngrok 退出（code=' + code + '）'
        + (lastErrLine ? '：' + lastErrLine : (authtoken ? '' : '：免费版需在 keys.json 填 ngrokAuthToken'));
    }
  });
  child.on('error', (e) => { state.error = 'ngrok 启动失败：' + e.message; });

  // 轮询 ngrok 本地 API 获取公网地址（最多 15 秒）
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (!state.child) break; // 进程已退出
    try {
      const d = await fetch(NGROK_API).then((x) => x.json());
      const t = (d.tunnels || []).find((x) =>
        String(x.config?.addr || '').endsWith(':' + port) && x.public_url?.startsWith('https://'));
      if (t) {
        state.url = t.public_url.replace(/^http:\/\//, 'https://');
        return tunnelStatus();
      }
    } catch { /* ngrok API 尚未就绪 */ }
  }
  if (!state.url) {
    stopTunnel();
    throw new Error(state.error
      || 'ngrok 隧道启动超时（15 秒内未获得公网地址）。ngrok 免费版需要在 keys.json 的 ngrokAuthToken 填入 authtoken（ngrok.com 控制台获取）');
  }
  return tunnelStatus();
}

/** 关闭隧道（令牌随之失效） */
export function stopTunnel() {
  if (state.child) {
    try { state.child.kill(); } catch { /* noop */ }
  }
  state.child = null;
  state.url = null;
  state.token = null;
  state.startedAt = null;
  return { active: false };
}
