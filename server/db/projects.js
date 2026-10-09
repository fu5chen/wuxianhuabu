// ============================================================
// db/projects.js — 项目持久化（JSON 文件存储，对应数据库「项目表」）
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../data/projects');
fs.mkdirSync(DATA_DIR, { recursive: true });

const fileOf = (id) => path.join(DATA_DIR, `${id}.json`);

export function listProjects() {
  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json'));
  const list = [];
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf-8'));
      list.push({ id: j.id, name: j.name, updatedAt: j.updatedAt, nodeCount: (j.nodes || []).length });
    } catch { /* skip corrupted */ }
  }
  list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return list;
}

export function getProject(id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return null;
  try { return JSON.parse(fs.readFileSync(fileOf(id), 'utf-8')); } catch { return null; }
}

export function saveProject({ id, name, nodes, edges }) {
  const pid = id || crypto.randomUUID();
  const prev = getProject(pid);
  const doc = {
    id: pid,
    name: name || prev?.name || '未命名项目',
    nodes: nodes ?? prev?.nodes ?? [],
    edges: edges ?? prev?.edges ?? [],
    createdAt: prev?.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
  fs.writeFileSync(fileOf(pid), JSON.stringify(doc, null, 2), 'utf-8');
  return doc;
}

export function deleteProject(id) {
  try { fs.unlinkSync(fileOf(id)); return true; } catch { return false; }
}
