// ============================================================
// scheduler/queue.js — 工作流任务调度
// 收到运行请求 → 后端 DAG 拓扑排序 → 按依赖顺序逐节点执行
// 每步通过 eventBus 广播节点状态/进度/结果（SSE 推送前端）
// ============================================================
import crypto from 'node:crypto';
import { topoSort } from '../dagEngine/topo.js';
import { runNodeTask, estimateCredits } from '../aiAdapter/index.js';

/** runId -> { cancel:boolean, nodes:Map<nodeId, result> } */
const runs = new Map();

export function getRun(runId) { return runs.get(runId); }

export function cancelRun(runId) {
  const run = runs.get(runId);
  if (!run) return false;
  run.cancel = true;
  return true;
}

/**
 * 启动一次工作流执行（异步，不阻塞 HTTP 响应）
 * @param {object} payload { nodes, edges, entryNodeId? }
 * @param {object} eventBus
 * @returns {{ runId: string, order: string[] }} 或抛出 {message, cycle}
 */
export function startWorkflow(payload, eventBus) {
  const { nodes, edges } = payload;
  const result = topoSort(nodes, edges);
  if (result.error) {
    const err = new Error(result.error);
    err.cycle = result.cycle;
    throw err;
  }

  const runId = crypto.randomUUID();
  const run = { cancel: false, results: new Map(), status: 'running' };
  runs.set(runId, run);

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const incoming = new Map(); // nodeId -> [{source, ...}]
  for (const e of edges) {
    if (!incoming.has(e.target)) incoming.set(e.target, []);
    incoming.get(e.target).push(e);
  }

  eventBus.emit({ type: 'workflow_start', runId, order: result.order });

  (async () => {
    try {
      for (const nodeId of result.order) {
        if (run.cancel) { run.status = 'cancelled'; eventBus.emit({ type: 'workflow_cancelled', runId }); return; }
        const node = nodeMap.get(nodeId);
        if (!node) continue;

        // 编排类/可选执行：无提示词且无上游的纯容器节点直接标记跳过
        const needsRun = ['image', 'video', 'audio', 'text', 'subject'].includes(node.type)
          || (node.params && (node.params.prompt || node.params.autoRun));

        // 收集上游结果，注入 node.upstreamResults 供适配器使用
        const ups = (incoming.get(nodeId) || [])
          .map((e) => ({ source: e.source, result: run.results.get(e.source) }))
          .filter((x) => x.result);

        // seedOnly：单节点运行时，已有结果的上游节点只播种不重跑（避免点视频生成连图片也重新生成）
        if (!needsRun || node.seedOnly) {
          // 纯容器/素材节点：自身已上传的输出（如上传图）要作为结果传给下游，
          // 否则下游的参考图解析拿到 resourceId=null，@引用的图片就发不到生成模型
          const ex = node.outputs?.[0];
          const seed = ex?.resourceId
            ? { resourceId: ex.resourceId, url: ex.url, kind: ex.kind || String(ex.mime || '').split('/')[0], mime: ex.mime || null }
            : { resourceId: null, skipped: true, upstream: ups };
          run.results.set(nodeId, seed);
          eventBus.emit({ type: 'node_status', runId, nodeId, status: 'skipped' });
          continue;
        }

        eventBus.emit({ type: 'node_status', runId, nodeId, status: 'running', progress: 0 });
        try {
          const taskNode = { ...node, upstreamResults: ups.map((u) => u.result) };
          const out = await runNodeTask(taskNode, (p, extra) => {
            // extra 可携带 { taskId, taskType }（Seedance 任务），随 SSE 推给前端展示/取消
            eventBus.emit({ type: 'node_status', runId, nodeId, status: 'running', progress: p, ...(extra || {}) });
          });
          if (run.cancel) { run.status = 'cancelled'; eventBus.emit({ type: 'workflow_cancelled', runId }); return; }
          run.results.set(nodeId, out);
          eventBus.emit({ type: 'node_result', runId, nodeId, resourceId: out.resourceId, url: out.url, kind: out.kind, mime: out.mime || null, mock: !!out.mock, text: out.text || null });
          eventBus.emit({ type: 'node_status', runId, nodeId, status: 'success', progress: 100, credits: estimateCredits(node) });
        } catch (e) {
          eventBus.emit({ type: 'node_status', runId, nodeId, status: 'failed', error: String(e.message || e) });
          // 失败节点：下游依赖其输出的节点一并失败（简化策略：标记下游跳过）
        }
      }
      run.status = 'done';
      eventBus.emit({ type: 'workflow_done', runId });
    } catch (e) {
      run.status = 'error';
      eventBus.emit({ type: 'workflow_error', runId, error: String(e.message || e) });
    }
  })();

  return { runId, order: result.order };
}
