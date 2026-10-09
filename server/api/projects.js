// ============================================================
// api/projects.js — 项目增删改查（画布 JSON 持久化）
// ============================================================
import { listProjects, getProject, saveProject, deleteProject } from '../db/projects.js';

export async function handleProjectApi({ req, res, u, body, sendJson }) {
  const parts = u.pathname.split('/').filter(Boolean); // ['api','projects', id?]
  const id = parts[2];
  const method = req.method;

  if (method === 'GET' && !id) return sendJson(res, 200, { projects: listProjects() });

  if (method === 'POST' && !id) {
    const doc = saveProject({ name: body?.name || '未命名项目', nodes: body?.nodes || [], edges: body?.edges || [] });
    return sendJson(res, 200, doc);
  }

  if (id) {
    if (method === 'GET') {
      const doc = getProject(id);
      if (!doc) return sendJson(res, 404, { error: '项目不存在' });
      return sendJson(res, 200, doc);
    }
    if (method === 'PUT') {
      const doc = saveProject({ id, name: body?.name, nodes: body?.nodes, edges: body?.edges });
      return sendJson(res, 200, doc);
    }
    if (method === 'DELETE') {
      return sendJson(res, 200, { ok: deleteProject(id) });
    }
  }
  return sendJson(res, 404, { error: 'not found' });
}
