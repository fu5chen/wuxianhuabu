// ============================================================
// dag/graph.js — DAG 解析 / 拓扑排序（Kahn）/ 环检测 / @引用解析 / 子图收集
// ============================================================
import { store } from '../store.js';
import { validateEdgeTypes, validateVideoRefs, escapeRegExp } from '../nodes/nodeRegistry.js';

/** 前端预校验：拓扑排序 + 环检测 */
export function topoSort(nodes, edges) {
  const ids = new Set(nodes.map((n) => n.id));
  const indeg = new Map([...ids].map((id) => [id, 0]));
  const adj = new Map([...ids].map((id) => [id, []]));
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue;
    adj.get(e.source).push(e.target);
    indeg.set(e.target, indeg.get(e.target) + 1);
  }
  const q = [...ids].filter((id) => indeg.get(id) === 0);
  const order = [];
  while (q.length) {
    const id = q.shift();
    order.push(id);
    for (const nx of adj.get(id)) {
      indeg.set(nx, indeg.get(nx) - 1);
      if (indeg.get(nx) === 0) q.push(nx);
    }
  }
  if (order.length !== ids.size) {
    const cycle = [...ids].filter((id) => !order.includes(id));
    return { error: '检测到循环依赖，无法执行', cycle };
  }
  return { order };
}

/** 收集 node 的全部祖先（含自身），用于单节点运行 */
export function collectSubgraph(nodeId) {
  const ids = new Set();
  const walk = (id) => {
    if (ids.has(id)) return;
    ids.add(id);
    for (const e of store.edges.values()) if (e.target === id) walk(e.source);
  };
  walk(nodeId);
  const nodes = [...ids].map((id) => store.getNode(id)).filter(Boolean);
  const edges = [...store.edges.values()].filter((e) => ids.has(e.source) && ids.has(e.target));
  return { nodes, edges };
}

/** 解析提示词中的 @节点名 引用：自动补连线（类型合法才建立）。
 *  按完整节点名匹配（支持含空格的名字，如 @图片 1），长名优先。
 *  返回 { linked, rejected }：rejected 是因超限等原因引用失败的具体原因列表 */
export function resolveReferences() {
  const nodesList = [...store.nodes.values()];
  const nameMap = new Map(nodesList.map((n) => [n.name.trim(), n]).filter(([k]) => k));
  const names = [...nameMap.keys()].sort((a, b) => b.length - a.length);
  if (!names.length) return { linked: 0, rejected: [] };
  const re = new RegExp('@(' + names.map(escapeRegExp).join('|') + ')(?=[\\s@，。,.;；:：]|$)', 'g');
  let linked = 0;
  const rejected = [];
  for (const node of nodesList) {
    const prompt = node.params?.prompt || '';
    if (!prompt.includes('@')) continue;
    re.lastIndex = 0;
    for (const m of prompt.matchAll(re)) {
      const src = nameMap.get(m[1]);
      if (!src || src.id === node.id) continue;
      const exists = [...store.edges.values()].some((e) => e.source === src.id && e.target === node.id);
      if (exists) continue;
      const v = validateEdgeTypes(src.type, node.type, src);
      if (!v.ok) { rejected.push(`@${m[1]} → ${node.name}：${v.reason}`); continue; }
      // 视频模型参考上限（2.0：图≤9/音≤3且≤15s；2.5：图≤50/音≤60s），超限 = @ 引用失败
      const rv = validateVideoRefs(node, [src], store.upstreamOf(node.id));
      if (!rv.ok) { rejected.push(`@${m[1]} → ${node.name}：${rv.reason}`); continue; }
      store.addEdge(src.id, node.id); linked++;
    }
  }
  return { linked, rejected };
}

/** 全图连线合法性校验（提交前） */
export function validateGraph() {
  for (const e of store.edges.values()) {
    const s = store.getNode(e.source), t = store.getNode(e.target);
    if (!s || !t) continue;
    const v = validateEdgeTypes(s.type, t.type, s);
    if (!v.ok) return v;
  }
  return { ok: true };
}
