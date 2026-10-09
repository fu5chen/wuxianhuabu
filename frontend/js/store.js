// ============================================================
// store.js — 全局状态：节点 / 连线 / 相机 / 选择 / 撤销重做
// ============================================================
import { createNodeData } from './nodes/nodeRegistry.js';

class Store {
  constructor() {
    this.nodes = new Map();      // id -> node data
    this.edges = new Map();      // id -> {id, source, target, sourcePort, targetPort}
    this.groups = new Map();     // groupId -> Set(nodeId)
    this.groupNames = new Map(); // groupId -> 组名
    this.groupPads = new Map();  // groupId -> {l,t,r,b} 组框四周的扩展边距（拖拽手柄调节大小）
    this.camera = { x: 0, y: 0, scale: 1 };
    this.selection = new Set();  // node ids
    this.projectId = null;
    this.projectName = '未命名项目';
    this.dirty = false;

    this.listeners = new Set();
    this._undoStack = [];
    this._redoStack = [];
    this._typeCounter = {};
  }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(evt) { for (const fn of this.listeners) fn(evt); }

  // ---------- 命名 ----------
  nextNodeName(type) {
    const label = ({ image: '图片', video: '视频', text: '文本', audio: '音频', timeline: '时间线', subject: '主体', director: '导演台', media: '素材' })[type] || type;
    this._typeCounter[label] = (this._typeCounter[label] || 0) + 1;
    return `${label} ${this._typeCounter[label]}`;
  }
  syncCounters() {
    for (const n of this.nodes.values()) {
      const m = /^(.+?) (\d+)$/.exec(n.name);
      if (m) this._typeCounter[m[1]] = Math.max(this._typeCounter[m[1]] || 0, Number(m[2]));
    }
  }

  // ---------- 历史 ----------
  snapshot() {
    return JSON.stringify({
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()],
      groups: [...this.groups].map(([g, ids]) => [g, [...ids]]),
      groupNames: this.groupNames ? [...this.groupNames] : [],
    });
  }
  pushHistory() {
    this._undoStack.push(this.snapshot());
    if (this._undoStack.length > 80) this._undoStack.shift();
    this._redoStack.length = 0;
  }
  restore(json) {
    const d = JSON.parse(json);
    this.nodes = new Map(d.nodes.map((n) => [n.id, n]));
    this.edges = new Map(d.edges.map((e) => [e.id, e]));
    this.groups = new Map((d.groups || []).map(([g, ids]) => [g, new Set(ids)]));
    this.groupNames = new Map(d.groupNames || []);
    this.groupPads = new Map(d.groupPads || []);
    this.selection.clear();
    this.emit({ type: 'reload' });
  }
  undo() {
    if (!this._undoStack.length) return false;
    this._redoStack.push(this.snapshot());
    this.restore(this._undoStack.pop());
    return true;
  }
  redo() {
    if (!this._redoStack.length) return false;
    this._undoStack.push(this.snapshot());
    this.restore(this._redoStack.pop());
    return true;
  }

  // ---------- 节点 ----------
  addNode(type, worldPos, extra = {}) {
    const data = createNodeData(type, this.nextNodeName(type), worldPos);
    Object.assign(data, extra);
    this.nodes.set(data.id, data);
    this.dirty = true;
    this.emit({ type: 'node_added', node: data });
    return data;
  }
  removeNodes(ids) {
    const idSet = new Set(ids);
    // 级联删除相关连线
    for (const [eid, e] of this.edges) {
      if (idSet.has(e.source) || idSet.has(e.target)) this.edges.delete(eid);
    }
    for (const id of idSet) this.nodes.delete(id);
    for (const id of idSet) this.selection.delete(id);
    this.dirty = true;
    this.emit({ type: 'reload' });
  }
  getNode(id) { return this.nodes.get(id); }
  moveNodes(deltas) { // deltas: Map<id, {x,y}>
    for (const [id, pos] of deltas) {
      const n = this.nodes.get(id);
      if (n) { n.position.x = pos.x; n.position.y = pos.y; }
    }
    this.dirty = true;
    this.emit({ type: 'nodes_moved' });
  }
  updateNode(id, patch) {
    const n = this.nodes.get(id);
    if (!n) return;
    Object.assign(n, patch);
    this.dirty = true;
    this.emit({ type: 'node_updated', node: n });
  }

  // ---------- 连线 ----------
  addEdge(source, target, sourcePort = 'out', targetPort = 'in') {
    // 防重：同源同目标已存在则跳过
    for (const e of this.edges.values()) {
      if (e.source === source && e.target === target && e.sourcePort === sourcePort) return null;
    }
    const edge = { id: `e_${crypto.randomUUID().slice(0, 8)}`, source, target, sourcePort, targetPort };
    this.edges.set(edge.id, edge);
    this.dirty = true;
    this.emit({ type: 'edge_added', edge });
    return edge;
  }
  removeEdge(edgeId) {
    this.edges.delete(edgeId);
    this.dirty = true;
    this.emit({ type: 'reload' });
  }
  edgesOf(nodeId) {
    return [...this.edges.values()].filter((e) => e.source === nodeId || e.target === nodeId);
  }
  upstreamOf(nodeId) {
    return [...this.edges.values()].filter((e) => e.target === nodeId).map((e) => this.nodes.get(e.source)).filter(Boolean);
  }

  // ---------- 序列化 ----------
  toJSON() {
    return {
      name: this.projectName,
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()],
      groups: [...this.groups].map(([g, ids]) => [g, [...ids]]),
      groupNames: this.groupNames ? [...this.groupNames] : [],
    };
  }
  loadJSON(doc, projectId) {
    this.nodes = new Map((doc.nodes || []).map((n) => [n.id, n]));
    this.edges = new Map((doc.edges || []).map((e) => [e.id, e]));
    this.groups = new Map((doc.groups || []).map(([g, ids]) => [g, new Set(ids)]));
    this.groupNames = new Map(doc.groupNames || []);
    this.groupPads = new Map(doc.groupPads || []);
    this.projectName = doc.name || '未命名项目';
    this.projectId = projectId || doc.id || null;
    this.selection.clear();
    this._undoStack.length = 0;
    this._redoStack.length = 0;
    this.syncCounters();
    this.dirty = false;
    this.emit({ type: 'reload' });
  }
  clear() {
    this.nodes.clear();
    this.edges.clear();
    this.groups.clear();
    this.groupNames?.clear();
    this.groupPads?.clear();
    this.selection.clear();
    this.dirty = true;
    this.emit({ type: 'reload' });
  }

  // ---------- 分组 ----------
  /** 把若干节点合成一个组（已在不同组的会合并进新组），返回 groupId */
  groupNodes(ids, name) {
    const gid = `g_${crypto.randomUUID().slice(0, 8)}`;
    const members = new Set(ids);
    // 清掉这些节点所在的旧组
    for (const [g, set] of this.groups) {
      for (const id of ids) set.delete(id);
      if (!set.size) this.groups.delete(g);
    }
    this.groups.set(gid, members);
    this.groupNames = this.groupNames || new Map();
    this.groupNames.set(gid, name || `Group ${this.groups.size}`);
    this.dirty = true;
    this.emit({ type: 'groups_changed', groupId: gid });
    return gid;
  }
  /** 重命名分组 */
  renameGroup(gid, name) {
    this.groupNames = this.groupNames || new Map();
    if (!this.groupNames.has(gid)) return;
    this.groupNames.set(gid, name);
    this.dirty = true;
    this.emit({ type: 'groups_changed', groupId: gid });
  }
  /** 解组：把选中节点从其所在组移除 */
  ungroupNodes(ids) {
    for (const [g, set] of this.groups) {
      for (const id of ids) set.delete(id);
      if (!set.size) { this.groups.delete(g); this.groupNames?.delete(g); this.groupPads?.delete(g); }
    }
    this.dirty = true;
    this.emit({ type: 'groups_changed' });
  }
  /** 调整组框大小（右/下方向扩展边距，屏幕像素） */
  resizeGroup(gid, pad) {
    this.groupPads = this.groupPads || new Map();
    this.groupPads.set(gid, pad);
    this.dirty = true;
  }
  /** 节点所在组的全部成员（含自身）；不在组内返回 [自身] */
  getGroupMembers(nodeId) {
    for (const set of this.groups.values()) {
      if (set.has(nodeId)) return [...set];
    }
    return [nodeId];
  }
}

export const store = new Store();

// 测试/调试钩子：浏览器控制台或自动化测试可直接访问画布状态
if (typeof window !== 'undefined') window.__wbStore = store;
