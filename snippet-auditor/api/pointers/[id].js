// PATCH  /api/pointers/:id?projectId=…  { screenName?, notes? } → client only
// DELETE /api/pointers/:id?projectId=…                          → client only
// The pointer must belong to the project the token unlocks.
import { handler, send, readBody, errors, queryParam } from '../../lib/http.js';
import { requireAuth, ROLES } from '../../lib/auth.js';
import { getStore } from '../../lib/store/index.js';
import * as v from '../../lib/validate.js';

export default handler(async (req, res) => {
  if (req.method !== 'PATCH' && req.method !== 'DELETE') throw errors.methodNotAllowed();
  const body = req.method === 'PATCH' ? readBody(req) : null;
  const { project } = await requireAuth(req, body, [ROLES.CLIENT]);

  const id = queryParam(req, 'id');
  if (!v.isUuid(id)) throw errors.notFound('Pointer not found.');

  if (req.method === 'PATCH') {
    const patch = {};
    if (body.screenName !== undefined) patch.screenName = v.screenName(body.screenName);
    if (body.notes !== undefined) patch.notes = v.notes(body.notes);
    if (!Object.keys(patch).length) throw errors.badRequest('Nothing to update. Send screenName and/or notes.');
    const pointer = await getStore().updatePointer(project.id, id, patch);
    if (!pointer) throw errors.notFound('Pointer not found.');
    return send(res, 200, { pointer });
  }

  const deleted = await getStore().deletePointer(project.id, id);
  if (!deleted) throw errors.notFound('Pointer not found.');
  return send(res, 200, { deleted: true, id });
});
