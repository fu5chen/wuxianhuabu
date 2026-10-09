// ============================================================
// api/tasks.js — 工作流任务接口 + 模拟用户/额度
// ============================================================
import { startWorkflow, cancelRun } from '../scheduler/queue.js';
import { MODELS, estimateCredits, cancelNodeTask, getNodeTaskId } from '../aiAdapter/index.js';
import { logger } from '../logger.mjs';

// 模拟当前用户（生产环境接鉴权 + 数据库用户表）
const user = { id: 'u_demo', name: '演示用户', isVip: false, credits: 10000 };

export async function handleTaskApi({ req, res, u, body, sendJson, eventBus }) {
  const p = u.pathname;

  if (p === '/api/user' && req.method === 'GET') {
    return sendJson(res, 200, { user, models: MODELS });
  }

  if (p === '/api/tasks/run' && req.method === 'POST') {
    const { nodes, edges } = body || {};
    if (!Array.isArray(nodes) || !Array.isArray(edges)) return sendJson(res, 400, { error: 'nodes/edges 必填' });

    // 额度预校验（会员额度 / 积分校验）—— seedOnly 节点只播种不执行，不计消耗
    const total = nodes.reduce((s, n) => s + (n.seedOnly ? 0 : estimateCredits(n)), 0);
    if (user.credits < total) {
      return sendJson(res, 402, { error: `积分不足：本次预计消耗 ${total}，当前余额 ${user.credits}` });
    }

    try {
      const { runId, order } = startWorkflow({ nodes, edges }, eventBus);
      user.credits -= total;
      const typeSummary = nodes.reduce((m, n) => { m[n.type] = (m[n.type] || 0) + 1; return m; }, {});
      logger.op('运行工作流', `runId=${runId} 节点=${nodes.length} 连线=${edges.length} 类型=${JSON.stringify(typeSummary)} 消耗积分=${total} 余额=${user.credits}`);
      return sendJson(res, 200, { runId, order, creditsCost: total, creditsLeft: user.credits });
    } catch (e) {
      logger.op('运行工作流被拒绝', e.message);
      return sendJson(res, 400, { error: e.message, cycle: e.cycle || null });
    }
  }

  if (p === '/api/tasks/cancel' && req.method === 'POST') {
    return sendJson(res, 200, { ok: cancelRun(body?.runId) });
  }

  // 节点级取消（生成中节点的 Seedance 任务 DELETE + 本地中止）
  if (p === '/api/tasks/cancel-node' && req.method === 'POST') {
    const nodeId = body?.nodeId;
    const known = nodeId ? getNodeTaskId(nodeId) : null;
    const r = nodeId ? await cancelNodeTask(nodeId) : { ok: false, error: '缺少 nodeId' };
    if (r?.ok) logger.op('取消生成任务', `nodeId=${nodeId} taskId=${known || '预取消'}`);
    else logger.op('取消生成任务失败', `nodeId=${nodeId} 原因=${r?.error || '无进行中的生成任务'}`);
    return sendJson(res, 200, { ok: !!r?.ok, error: r?.error || null, pending: !!r?.pending, taskId: known });
  }

  // 查询节点当前任务 ID（调试/恢复用）
  if (p === '/api/tasks/node-task-id' && req.method === 'POST') {
    return sendJson(res, 200, { taskId: body?.nodeId ? getNodeTaskId(body.nodeId) : null });
  }

  return sendJson(res, 404, { error: 'not found' });
}
