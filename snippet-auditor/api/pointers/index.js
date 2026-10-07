// GET  /api/pointers?projectId=…  → { pointers, nextPointerNumber } (developer + client)
// POST /api/pointers?projectId=…  { screenName, notes, screenState?, targetType?, targetSelector?, targetLabel?,
//                                   anchorX?, anchorY?, viewportWidth?, viewportHeight? } → client only.
// The server assigns the number. Older clients that send only screenName + notes create screen-level notes.
import { handler, send, readBody, errors } from '../../lib/http.js';
import { requireAuth, ROLES } from '../../lib/auth.js';
import { getStore } from '../../lib/store/index.js';
import * as v from '../../lib/validate.js';

export default handler(async (req, res) => {
  if (req.method === 'GET') {
    const { project } = await requireAuth(req, null);
    return send(res, 200, await getStore().listPointers(project.id));
  }

  if (req.method === 'POST') {
    const body = readBody(req);
    const { project } = await requireAuth(req, body, [ROLES.CLIENT]);
    const pointer = await getStore().createPointer(project.id, {
      screenName: v.screenName(body.screenName),
      notes: v.notes(body.notes),
      ...v.annotation(body, { partial: false })
    });
    return send(res, 201, { pointer });
  }

  throw errors.methodNotAllowed();
});
