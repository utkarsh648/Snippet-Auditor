import { createClient } from '@supabase/supabase-js';

const PROJECT_COLS = 'id, name, html, created_at, updated_at';
const POINTER_COLS = 'id, pointer_number, screen_name, notes, screen_state, target_type, target_selector, target_label, anchor_x, anchor_y, viewport_width, viewport_height, created_at, updated_at';
const POINTER_FIELDS = {
  screenName: 'screen_name', notes: 'notes', screenState: 'screen_state', targetType: 'target_type',
  targetSelector: 'target_selector', targetLabel: 'target_label', anchorX: 'anchor_x', anchorY: 'anchor_y',
  viewportWidth: 'viewport_width', viewportHeight: 'viewport_height'
};

const toProject = (r) => r && ({ id: r.id, name: r.name, html: r.html, createdAt: r.created_at, updatedAt: r.updated_at });
const toPointer = (r) => r && ({
  id: r.id, pointerNumber: r.pointer_number, screenName: r.screen_name, notes: r.notes,
  screenState: r.screen_state || 'Default',
  targetType: r.target_type || 'screen',
  targetSelector: r.target_selector ?? null,
  targetLabel: r.target_label ?? null,
  anchorX: r.anchor_x ?? null,
  anchorY: r.anchor_y ?? null,
  viewportWidth: r.viewport_width ?? null,
  viewportHeight: r.viewport_height ?? null,
  createdAt: r.created_at, updatedAt: r.updated_at
});

function check(error, what) {
  if (error) {
    // Supabase errors can include SQL detail; keep it in server logs only.
    console.error(`[store] ${what} failed: ${error.code || ''} ${error.message || ''}`);
    throw new Error(`Database error during ${what}.`);
  }
}

export function createSupabaseStore({ url, secretKey }) {
  if (!url || !secretKey) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY must be set on the server.');
  const db = createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });

  return {
    async getProjectWithHashes(id) {
      const { data, error } = await db.from('projects')
        .select(`${PROJECT_COLS}, dev_token_hash, qa_token_hash`).eq('id', id).maybeSingle();
      check(error, 'project lookup');
      if (!data) return null;
      return { ...toProject(data), devTokenHash: data.dev_token_hash, qaTokenHash: data.qa_token_hash };
    },

    async createProject({ id, name, html, devTokenHash, qaTokenHash }) {
      const { data, error } = await db.from('projects')
        .insert({ id, name, html, dev_token_hash: devTokenHash, qa_token_hash: qaTokenHash })
        .select(PROJECT_COLS).single();
      if (error && error.code === '23505') throw new Error(`A project with id "${id}" already exists.`);
      check(error, 'project create');
      return toProject(data);
    },

    async setTokenHashes(id, { devTokenHash, qaTokenHash }) {
      const patch = {};
      if (devTokenHash) patch.dev_token_hash = devTokenHash;
      if (qaTokenHash) patch.qa_token_hash = qaTokenHash;
      const { data, error } = await db.from('projects').update(patch).eq('id', id).select('id');
      check(error, 'token rotation');
      return Array.isArray(data) && data.length > 0;
    },

    async updateProject(id, patch, baseUpdatedAt) {
      const row = {};
      if (patch.name !== undefined) row.name = patch.name;
      if (patch.html !== undefined) row.html = patch.html;
      let q = db.from('projects').update(row).eq('id', id);
      if (baseUpdatedAt) q = q.eq('updated_at', baseUpdatedAt);
      const { data, error } = await q.select(PROJECT_COLS);
      check(error, 'project update');
      if (data && data.length) return toProject(data[0]);
      if (!baseUpdatedAt) return null;
      const { data: exists, error: e2 } = await db.from('projects').select('id').eq('id', id).maybeSingle();
      check(e2, 'project lookup');
      return exists ? 'conflict' : null;
    },

    async listPointers(projectId) {
      const [{ data, error }, { data: proj, error: e2 }] = await Promise.all([
        db.from('qa_pointers').select(POINTER_COLS).eq('project_id', projectId).order('pointer_number', { ascending: true }),
        db.from('projects').select('next_pointer_number').eq('id', projectId).maybeSingle()
      ]);
      check(error, 'pointer list');
      check(e2, 'pointer counter lookup');
      return { pointers: (data || []).map(toPointer), nextPointerNumber: proj ? proj.next_pointer_number : 1 };
    },

    async createPointer(projectId, f) {
      // The database function assigns the number atomically and never reuses one.
      const { data, error } = await db.rpc('create_qa_pointer', {
        p_project_id: projectId,
        p_screen_name: f.screenName,
        p_notes: f.notes,
        p_screen_state: f.screenState,
        p_target_type: f.targetType,
        p_target_selector: f.targetSelector,
        p_target_label: f.targetLabel,
        p_anchor_x: f.anchorX,
        p_anchor_y: f.anchorY,
        p_viewport_width: f.viewportWidth,
        p_viewport_height: f.viewportHeight
      });
      check(error, 'pointer create');
      const row = Array.isArray(data) ? data[0] : data;
      return toPointer(row);
    },

    async updatePointer(projectId, pointerId, patch) {
      const row = {};
      for (const [key, column] of Object.entries(POINTER_FIELDS)) {
        if (patch[key] !== undefined) row[column] = patch[key];
      }
      const { data, error } = await db.from('qa_pointers').update(row)
        .eq('id', pointerId).eq('project_id', projectId).select(POINTER_COLS);
      check(error, 'pointer update');
      return data && data.length ? toPointer(data[0]) : null;
    },

    async deletePointer(projectId, pointerId) {
      const { data, error } = await db.from('qa_pointers').delete()
        .eq('id', pointerId).eq('project_id', projectId).select('id');
      check(error, 'pointer delete');
      return Array.isArray(data) && data.length > 0;
    }
  };
}
