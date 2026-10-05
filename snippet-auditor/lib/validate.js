import { errors } from './http.js';

export const LIMITS = {
  projectName: 120,
  htmlBytes: 2 * 1024 * 1024, // 2 MB (Vercel request bodies are capped at 4.5 MB)
  screenName: 150,
  notes: 5000
};

const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TOKEN = /^(dev|qa)_[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isProjectId = (v) => typeof v === 'string' && PROJECT_ID.test(v);
export const isTokenShape = (v) => typeof v === 'string' && TOKEN.test(v);
export const isUuid = (v) => typeof v === 'string' && UUID.test(v);

export function projectName(v) {
  if (typeof v !== 'string') throw errors.badRequest('Project name must be text.');
  const name = v.trim();
  if (!name) throw errors.badRequest('Project name cannot be empty.');
  if (name.length > LIMITS.projectName) throw errors.badRequest(`Project name must be ${LIMITS.projectName} characters or fewer.`);
  return name;
}

export function html(v) {
  if (typeof v !== 'string') throw errors.badRequest('HTML must be text.');
  if (Buffer.byteLength(v, 'utf8') > LIMITS.htmlBytes) throw errors.tooLarge('HTML is too large to save. The limit is 2 MB.');
  return v;
}

export function screenName(v) {
  if (typeof v !== 'string') throw errors.badRequest('Screen name must be text.');
  const s = v.trim();
  if (!s) throw errors.badRequest('Add a screen name before saving this pointer.');
  if (s.length > LIMITS.screenName) throw errors.badRequest(`Screen name must be ${LIMITS.screenName} characters or fewer.`);
  return s;
}

export function notes(v) {
  if (v == null) return '';
  if (typeof v !== 'string') throw errors.badRequest('Notes must be text.');
  if (v.length > LIMITS.notes) throw errors.badRequest(`Notes must be ${LIMITS.notes} characters or fewer.`);
  return v;
}
