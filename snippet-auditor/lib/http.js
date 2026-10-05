// Shared response helpers. Every API response uses the same envelope:
//   { success: true, data }   or   { success: false, error: { code, message } }

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const errors = {
  badRequest: (message = 'The request is not valid.') => new HttpError(400, 'BAD_REQUEST', message),
  unauthorized: () => new HttpError(401, 'UNAUTHORIZED', 'Unable to access this project.'),
  forbidden: (message = 'This link does not allow that action.') => new HttpError(403, 'FORBIDDEN', message),
  notFound: (message = 'Not found.') => new HttpError(404, 'NOT_FOUND', message),
  methodNotAllowed: () => new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.'),
  conflict: (message) => new HttpError(409, 'CONFLICT', message),
  tooLarge: (message) => new HttpError(413, 'TOO_LARGE', message)
};

function writeJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

export function send(res, status, data) {
  writeJson(res, status, { success: true, data });
}

export function sendError(res, err) {
  const known = err instanceof HttpError;
  if (!known) console.error('[api] unexpected error:', err && err.message ? err.message : err);
  writeJson(res, known ? err.status : 500, {
    success: false,
    error: {
      code: known ? err.code : 'INTERNAL_ERROR',
      message: known ? err.message : 'Something went wrong on the server.'
    }
  });
}

// Vercel parses JSON bodies into req.body; the local server does the same.
export function readBody(req) {
  const b = req.body;
  if (b == null || b === '') return {};
  if (typeof b === 'string') {
    try { return JSON.parse(b); } catch { throw errors.badRequest('Request body must be JSON.'); }
  }
  if (typeof b !== 'object' || Array.isArray(b)) throw errors.badRequest('Request body must be a JSON object.');
  return b;
}

export function queryParam(req, name) {
  const v = (req.query || {})[name];
  return Array.isArray(v) ? v[0] : v;
}

// Wrap a handler so thrown HttpErrors become proper responses,
// and log each request without credentials.
export function handler(fn) {
  return async (req, res) => {
    const started = Date.now();
    try {
      await fn(req, res);
    } catch (err) {
      sendError(res, err);
    } finally {
      const path = String(req.url || '').split('?')[0];
      const ctx = req.auth ? ` project=${req.auth.project.id} role=${req.auth.role}` : '';
      if (process.env.NODE_ENV !== 'test') {
        console.log(`[api] ${req.method} ${path} ${res.statusCode}${ctx} ${Date.now() - started}ms`);
      }
    }
  };
}
