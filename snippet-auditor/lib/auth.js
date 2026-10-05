// The single authorization utility every endpoint uses.
// token → project → role. Callers never see token hashes.
import { getStore } from './store/index.js';
import { hashToken, hashesEqual } from './tokens.js';
import { isProjectId, isTokenShape } from './validate.js';
import { errors, queryParam } from './http.js';

export const ROLES = Object.freeze({ DEVELOPER: 'developer', CLIENT: 'client' });

export function readToken(req, body) {
  const header = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim();
  if (body && typeof body.token === 'string') return body.token.trim();
  return null;
}

export function readProjectId(req, body) {
  return queryParam(req, 'projectId') || (body && body.projectId) || null;
}

// Returns { project, role } or null. Never throws for bad credentials.
export async function authorizeRequest(token, projectId) {
  if (!isProjectId(projectId) || !isTokenShape(token)) return null;
  const project = await getStore().getProjectWithHashes(projectId);
  if (!project) return null;
  const hash = hashToken(token);
  let role = null;
  if (hashesEqual(hash, project.devTokenHash)) role = ROLES.DEVELOPER;
  else if (hashesEqual(hash, project.qaTokenHash)) role = ROLES.CLIENT;
  if (!role) return null;
  return { role, project: publicProject(project) };
}

// Strip internal fields before anything leaves the server.
export function publicProject(p) {
  return { id: p.id, name: p.name, html: p.html, createdAt: p.createdAt, updatedAt: p.updatedAt };
}

// Convenience for handlers: authorize or throw a generic 401,
// then optionally enforce allowed roles (403).
export async function requireAuth(req, body, allowedRoles) {
  const auth = await authorizeRequest(readToken(req, body), readProjectId(req, body));
  if (!auth) throw errors.unauthorized();
  req.auth = auth;
  if (allowedRoles && !allowedRoles.includes(auth.role)) {
    throw errors.forbidden(auth.role === ROLES.CLIENT
      ? 'The review link cannot change the project.'
      : 'Only the review link can change QA notes.');
  }
  return auth;
}
