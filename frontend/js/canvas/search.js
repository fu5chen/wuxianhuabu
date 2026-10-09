// ============================================================
// canvas/search.js — 画布节点搜索（Ctrl+F）：定位并选中节点
// ============================================================
import { store } from '../store.js';
import { camera } from './camera.js';
import { NODE_TYPES, icon } from '../nodes/nodeRegistry.js';

const wrap = () => document.getElementById('canvasWrap');

export function openSearch() {
  const panel = document.getElementById('searchPanel');
  const input = document.getElementById('searchInput');
  const list = document.getElementById('searchList');
  panel.classList.remove('hidden');
  input.value = '';
  renderList('');
  input.focus();

  input.oninput = () => renderList(input.value.trim());
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
    if (e.key === 'Enter') {
      const first = list.querySelector('.sp-item');
      first?.click();
    }
  };
  panel.querySelector('.sp-close').onclick = close;

  function close() {
    panel.classList.add('hidden');
  }

  function renderList(keyword) {
    const kw = keyword.toLowerCase();
    const nodes = [...store.nodes.values()].filter((n) => !kw || n.name.toLowerCase().includes(kw) || (n.params?.prompt || '').toLowerCase().includes(kw));
    list.innerHTML = nodes.length ? '' : '<div class="sp-empty">无匹配节点</div>';
    for (const n of nodes.slice(0, 30)) {
      const def = NODE_TYPES[n.type] || NODE_TYPES.image;
      const div = document.createElement('div');
      div.className = 'sp-item';
      div.innerHTML = `<span class="nm-icon">${icon(def.icon)}</span><span class="sp-name">${escapeHtml(n.name)}</span><span class="sp-type">${def.label}</span>`;
      div.addEventListener('click', () => {
        centerOn(n);
        close();
      });
      list.appendChild(div);
    }
  }

  function centerOn(node) {
    store.selection.clear();
    store.selection.add(node.id);
    store.emit({ type: 'selection' });
    const rect = wrap().getBoundingClientRect();
    const scale = Math.max(camera.scale, 0.7);
    camera.set(rect.width / 2 - node.position.x * scale - 160 * scale, rect.height / 2 - node.position.y * scale - 150 * scale, scale);
    store.emit({ type: 'render' });
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
