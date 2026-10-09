// ============================================================
// dagEngine/topo.js — DAG 拓扑排序（Kahn 算法）+ 环检测
// 后端二次校验，防止前端绕过校验提交非法图
// ============================================================

/**
 * @param {Array<{id:string}>} nodes
 * @param {Array<{source:string,target:string}>} edges
 * @returns {{ order: string[] } | { error: string, cycle: string[] }}
 */
export function topoSort(nodes, edges) {
  const nodeIds = new Set(nodes.map((n) => n.id));
  const indeg = new Map();
  const adj = new Map();
  for (const id of nodeIds) { indeg.set(id, 0); adj.set(id, []); }

  for (const e of edges) {
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue;
    // 自环检测
    if (e.source === e.target) return { error: `节点 ${e.source} 存在自连接`, cycle: [e.source, e.source] };
    adj.get(e.source).push(e.target);
    indeg.set(e.target, indeg.get(e.target) + 1);
  }

  const queue = [];
  for (const [id, d] of indeg) if (d === 0) queue.push(id);

  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const next of adj.get(id)) {
      indeg.set(next, indeg.get(next) - 1);
      if (indeg.get(next) === 0) queue.push(next);
    }
  }

  if (order.length !== nodeIds.size) {
    const cycle = [...nodeIds].filter((id) => !order.includes(id));
    return { error: '检测到循环依赖，无法执行', cycle };
  }
  return { order };
}

/** 校验连线端口类型是否匹配 */
export const PORT_RULES = {
  image:  { accepts: ['image', 'video'],      label: '图片' },
  video:  { accepts: ['image', 'video', 'audio'], label: '视频' },
  audio:  { accepts: ['text', 'audio'],       label: '音频' },
  text:   { accepts: ['text'],                label: '文本' },
  timeline: { accepts: ['video', 'image'],    label: '时间线' },
  subject:  { accepts: ['image', 'text'],     label: '主体' },
  director: { accepts: ['video', 'image', 'text', 'audio'], label: '导演台' },
};

export function validateEdge(sourceType, targetType) {
  const rule = PORT_RULES[targetType];
  if (!rule) return { ok: false, reason: `未知目标节点类型 ${targetType}` };
  if (!rule.accepts.includes(sourceType)) {
    return { ok: false, reason: `${rule.label}节点的输入不支持${PORT_RULES[sourceType]?.label || sourceType}类型` };
  }
  return { ok: true };
}
