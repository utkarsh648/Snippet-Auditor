// GET   /api/project?projectId=…   → saved project (developer + client)
// PATCH /api/project?projectId=…   { name?, html?, baseUpdatedAt? } → developer only
import { handler, send, readBody, errors } from '../lib/http.js';
import { requireAuth, ROLES } from '../lib/auth.js';
import { getStore } from '../lib/store/index.js';
import * as v from '../lib/validate.js';

export default handler(async (req, res) => {
  if (req.method === 'GET') {
    const { project } = await requireAuth(req, null);
    return send(res, 200, project);
  }

  if (req.method === 'PATCH') {
    const body = readBody(req);
    const { project } = await requireAuth(req, body, [ROLES.DEVELOPER]);
    const patch = {};
    if (body.name !== undefined) patch.name = v.projectName(body.name);
    if (body.html !== undefined) patch.html = v.html(body.html);
    if (!Object.keys(patch).length) throw errors.badRequest('Nothing to update. Send name and/or html.');
    const base = typeof body.baseUpdatedAt === 'string' ? body.baseUpdatedAt : null;

    const updated = await getStore().updateProject(project.id, patch, base);
    if (updated === 'conflict') {
      throw errors.conflict('This project was saved from somewhere else since you opened it.');
    }
    if (!updated) throw errors.unauthorized();
    return send(res, 200, updated);
  }

  throw errors.methodNotAllowed();
});
