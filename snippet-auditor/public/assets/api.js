// Browser API client. The access token from the page URL is sent in the
// Authorization header; it is never written to storage or logged.

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function createApi(projectId, token) {
  const qs = '?projectId=' + encodeURIComponent(projectId);

  async function call(method, path, body) {
    let res;
    try {
      res = await fetch(path, {
        method,
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch {
      throw new ApiError(0, 'NETWORK', 'Connection failed. Check your connection and try again.');
    }
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON response */ }
    if (!res.ok || !json || json.success !== true) {
      const err = (json && json.error) || {};
      throw new ApiError(res.status, err.code || 'ERROR', err.message || 'Something went wrong. Try again.');
    }
    return json.data;
  }

  return {
    access: () => call('POST', '/api/access', { projectId, token }),
    getProject: () => call('GET', '/api/project' + qs),
    updateProject: (patch) => call('PATCH', '/api/project' + qs, patch),
    listPointers: () => call('GET', '/api/pointers' + qs),
    createPointer: (data) => call('POST', '/api/pointers' + qs, data).then((d) => d.pointer),
    updatePointer: (id, patch) => call('PATCH', '/api/pointers/' + encodeURIComponent(id) + qs, patch).then((d) => d.pointer),
    deletePointer: (id) => call('DELETE', '/api/pointers/' + encodeURIComponent(id) + qs)
  };
}
