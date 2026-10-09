// ============================================================
// logger.mjs — 服务端日志：info（运行日志）+ operation（操作日志）
// 写入 server/data/logs/，按天分文件；提供 tail 读取
//   info-YYYY-MM-DD.log       运行日志：启动 / 请求 / 错误
//   operation-YYYY-MM-DD.log  操作日志：谁在什么时候做了什么（建项目/上传/运行工作流/前端画布操作）
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, '../data/logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function time() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function write(kind, line) {
  const file = path.join(LOG_DIR, `${kind}-${stamp()}.log`);
  const full = `[${stamp()} ${time()}] ${line}\n`;
  try { fs.appendFileSync(file, full); } catch { /* 磁盘异常不阻断服务 */ }
  if (kind === 'info') console.log('[info]', line);
  else console.log('[op]', line);
}

export const logger = {
  /** 运行日志 */
  info: (msg) => write('info', msg),
  /** 操作日志（带统一前缀便于筛选） */
  op: (action, detail = '') => write('operation', `${action}${detail ? ' | ' + detail : ''}`),

  /** 读取某个日志文件末尾 N 行 */
  tail(kind, lines = 200) {
    const file = path.join(LOG_DIR, `${kind}-${stamp()}.log`);
    try {
      const text = fs.readFileSync(file, 'utf-8');
      return text.split('\n').filter(Boolean).slice(-lines);
    } catch {
      return [];
    }
  },

  LOG_DIR,
};
