// ============================================================
// aiChat/chat.js — AI 对话助手（本地规则引擎）
// 生产环境：将 interpret() 替换为 LLM 服务 + function calling
// ============================================================
import { store } from '../store.js';
import { NODE_TYPES } from '../nodes/nodeRegistry.js';

const TYPE_WORDS = {
  图片: 'image', 图: 'image',
  视频: 'video',
  文本: 'text', 文字: 'text',
  音频: 'audio', 语音: 'audio', 音乐: 'audio',
  时间线: 'timeline',
  主体: 'subject', 角色: 'subject',
  导演台: 'director', 导演: 'director',
};

export function interpret(text) {
  const t = text.trim();
  if (!t) return '请输入指令';

  // 清空画布
  if (/清空|清掉|删除所有/.test(t)) {
    if (!store.nodes.size) return '画布已经是空的';
    store.pushHistory();
    store.clear();
    return '已清空画布';
  }

  // 运行
  if (/^(运行|执行|开始生成|跑一下)/.test(t)) {
    import('../main.js').then((m) => m.runWorkflow());
    return '好的，正在运行工作流…';
  }

  // 保存
  if (/保存/.test(t)) {
    import('../main.js').then((m) => m.saveProject());
    return '正在保存项目…';
  }

  // 连线：连接/连到/接 A 到 B
  const link = /(?:连接?|接)\s*@?(图片|视频|文本|音频|时间线|主体|导演台)\s*(\d+)\s*(?:到|至|→|->|和)\s*@?(图片|视频|文本|音频|时间线|主体|导演台)\s*(\d+)/.exec(t);
  if (link) {
    const a = findNode(`${link[1]} ${link[2]}`);
    const b = findNode(`${link[3]} ${link[4]}`);
    if (!a) return `找不到节点「${link[1]} ${link[2]}」`;
    if (!b) return `找不到节点「${link[3]} ${link[4]}」`;
    import('../nodes/nodeRegistry.js').then(({ validateEdgeTypes }) => {
      const v = validateEdgeTypes(a.type, b.type);
      if (!v.ok) return;
      store.pushHistory();
      store.addEdge(a.id, b.id);
    });
    import('../main.js').then((m) => m.renderAll());
    return `已连接「${a.name}」→「${b.name}」`;
  }

  // 创建节点：创建/新建/添加 一个/一个 图片节点，可选提示词「，提示词是...」
  const create = /(?:创建|新建|添加|加)\s*(?:一?个?)?\s*(图片|视频|文本|文字|音频|语音|音乐|时间线|主体|角色|导演台)/.exec(t);
  if (create) {
    const type = TYPE_WORDS[create[1]];
    const prompt = /(?:提示词|描述|内容)[是为：:]\s*(.+)/.exec(t)?.[1];
    store.pushHistory();
    const cx = store.camera.x + window.innerWidth / 2 / store.camera.scale - 160;
    const cy = store.camera.y + window.innerHeight / 2 / store.camera.scale - 150;
    const node = store.addNode(type, { x: cx, y: cy });
    if (prompt) node.params.prompt = prompt;
    store.emit({ type: 'node_added', node });
    import('../main.js').then((m) => m.renderAll());
    return `已创建「${node.name}」${prompt ? `，提示词：${prompt}` : ''}。可以拖动右侧端口连线，或直接点击生成。`;
  }

  // 修改提示词：把 图片1 的提示词改成/改为 ...
  const mod = /(?:把|将)\s*@?(图片|视频|文本|音频)\s*(\d+)\s*的?(?:提示词|描述)(?:改成|改为|换成|设为|设置为)\s*(.+)/.exec(t);
  if (mod) {
    const node = findNode(`${mod[1]} ${mod[2]}`);
    if (!node) return `找不到节点「${mod[1]} ${mod[2]}」`;
    node.params.prompt = mod[3].trim();
    store.dirty = true;
    import('../main.js').then((m) => m.scheduleAutosave());
    import('../main.js').then((m) => m.renderAll());
    return `已更新「${node.name}」的提示词`;
  }

  if (/帮助|能做什么|指令/.test(t)) {
    return '支持的指令：\n· 创建一个图片节点（视频/文本/音频/时间线/主体/导演台）\n· 连接图片1到视频1\n· 把图片1的提示词改成 一只太空猫\n· 运行 / 保存 / 清空画布';
  }

  return '我没有理解这条指令。试试：创建一个图片节点 / 连接图片1到视频1 / 运行。接入 LLM 服务后可支持更自然的画布操作。';
}

function findNode(name) {
  return [...store.nodes.values()].find((n) => n.name === name);
}
