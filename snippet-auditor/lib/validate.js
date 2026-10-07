import { errors } from './http.js';

export const LIMITS = {
  projectName: 120,
  htmlBytes: 2 * 1024 * 1024, // 2 MB (Vercel request bodies are capped at 4.5 MB)
  screenName: 150,
  notes: 5000,
  screenState: 100,
  targetSelector: 500,
  targetLabel: 150,
  viewport: 10000
};

export const TARGET_TYPES = ['screen', 'element', 'area'];

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

/* ---------- Visual annotation fields ---------- */

export function screenState(v) {
  if (v == null || v === '') return 'Default';
  if (typeof v !== 'string') throw errors.badRequest('Screen state must be text.');
  const s = v.trim() || 'Default';
  if (s.length > LIMITS.screenState) throw errors.badRequest(`Screen state must be ${LIMITS.screenState} characters or fewer.`);
  return s;
}

export function targetType(v) {
  if (v == null) return 'screen';
  if (!TARGET_TYPES.includes(v)) throw errors.badRequest('Target type must be screen, element or area.');
  return v;
}

function optionalText(v, max, label) {
  if (v == null) return null;
  if (typeof v !== 'string') throw errors.badRequest(`${label} must be text.`);
  const s = v.trim();
  if (!s) return null;
  if (s.length > max) throw errors.badRequest(`${label} must be ${max} characters or fewer.`);
  return s;
}
export const targetSelector = (v) => optionalText(v, LIMITS.targetSelector, 'Target selector');
export const targetLabel = (v) => optionalText(v, LIMITS.targetLabel, 'Target label');

// Fractions of the preview: rejected if not a finite number, clamped to 0–1.
export function anchor(v, label) {
  if (v == null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw errors.badRequest(`${label} must be a number between 0 and 1.`);
  return Math.min(1, Math.max(0, v));
}

export function viewportSize(v, label) {
  if (v == null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw errors.badRequest(`${label} must be a positive number.`);
  return Math.min(LIMITS.viewport, Math.max(1, Math.round(v)));
}

/**
 * Validates the annotation part of a pointer payload.
 * create: fills defaults so old clients that send only screenName + notes still work.
 * patch:  returns only the fields that were sent.
 */
export function annotation(body, { partial }) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  if (!partial || has('screenState')) out.screenState = screenState(body.screenState);
  if (!partial || has('targetType')) out.targetType = targetType(body.targetType);
  if (!partial || has('targetSelector')) out.targetSelector = targetSelector(body.targetSelector);
  if (!partial || has('targetLabel')) out.targetLabel = targetLabel(body.targetLabel);
  if (has('anchorX') !== has('anchorY')) throw errors.badRequest('Send anchorX and anchorY together.');
  if (!partial || has('anchorX')) {
    out.anchorX = anchor(body.anchorX, 'anchorX');
    out.anchorY = anchor(body.anchorY, 'anchorY');
    if ((out.anchorX == null) !== (out.anchorY == null)) throw errors.badRequest('Send anchorX and anchorY together.');
  }
  if (!partial || has('viewportWidth')) out.viewportWidth = viewportSize(body.viewportWidth, 'viewportWidth');
  if (!partial || has('viewportHeight')) out.viewportHeight = viewportSize(body.viewportHeight, 'viewportHeight');
  if (out.targetType === 'element' && !out.targetSelector) {
    throw errors.badRequest('An element target needs a targetSelector.');
  }
  return out;
}
