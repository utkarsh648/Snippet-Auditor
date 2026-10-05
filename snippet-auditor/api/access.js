// POST /api/access  { projectId, token }
// Validates an access link and returns the role plus the saved project.
import { handler, send, readBody, errors } from '../lib/http.js';
import { requireAuth } from '../lib/auth.js';

export default handler(async (req, res) => {
  if (req.method !== 'POST') throw errors.methodNotAllowed();
  const body = readBody(req);
  const { role, project } = await requireAuth(req, body);
  send(res, 200, { authorized: true, role, project });
});
