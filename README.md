# Snippet-Auditor
# Snippet Auditor

HTML prototype editor with two private viewpoints that share one project:

- **Developer view** — edit HTML, Run (local preview only), Save (persists), read QA notes.
- **Client / review view**: see the latest *saved* HTML and leave visual QA notes. Click **Add note**, click the exact element or area in the preview, and a numbered marker appears with a composer. Screen, state and target are detected automatically.

No login. Each project has two random access links. The server hashes the token from the link, finds the project, and decides the role. The browser never talks to Supabase directly, and the Supabase secret key only exists on the server.

```
Browser ──► /api/* (token → project → role) ──► Supabase (projects, qa_pointers)
```

## Quick start (no Supabase needed)

Requires Node 22 (Vercel builds with Node 22.x).

```bash
npm install
DATA_DRIVER=file npm run create-project -- --name "Sample prototype" --html examples/onboarding.html
DATA_DRIVER=file npm run dev
```

`create-project` prints a developer link and a client link. Without `--id` it picks a neutral random id (for example `p-7k2m9xq4`), so links don't reveal the client or project name. Pass `--id checkout-flow` if you want a readable one, and `--html file.html` to start from existing HTML. Open them at http://localhost:3000. The file driver stores data in `.data/db.json` (git-ignored). It is for local development only.

## Connect Supabase

1. Create a Supabase project.
2. In **SQL Editor**, run `supabase/schema.sql`. It is safe to re-run.
3. Copy `.env.example` to `.env.local` and set `SUPABASE_URL` and `SUPABASE_SECRET_KEY` (Project Settings → API Keys → secret key, or the legacy `service_role` key).
4. Create the first project and save the two printed links in your password manager:

   ```bash
   npm run create-project -- --name "Checkout flow"
   npm run dev
   ```

If a link leaks, issue a new one. The old one stops working immediately:

```bash
npm run create-project -- --id <project-id> --rotate qa      # or dev, or both
```

## Upgrading an existing deployment (visual annotations)

Run the database migration **before** pushing the new code:

1. In Supabase → SQL Editor, run `supabase/migrations/002_visual_annotations.sql`. Re-running `supabase/schema.sql` does the same thing; both are safe to repeat.
2. Push the code. Vercel redeploys.

The migration only adds columns. Existing notes keep working as screen-level notes (`target_type = 'screen'`), and the previous app version keeps working against the migrated database, so the order above has no downtime.

## Visual QA annotations

```
Preview viewport
├── sandboxed iframe   ← the prototype, untouched
└── QA overlay         ← markers, hover highlight, selected outline, composer (Snippet Auditor DOM)
```

**Flow:** `+ Add note` → hover highlights targets → click → draft marker + composer (screen and target pre-filled) → write feedback → **Add note** (or Cmd/Ctrl+Enter). Esc cancels. Annotation mode consumes one click, so the prototype's own handlers never fire for that click, then ends. Outside annotation mode the prototype behaves normally.

**What is stored per note:** screen name and state, target type (`element` | `area` | `screen`), a stable CSS selector, an editable target label, an anchor (`anchorX` as a fraction of the viewport width, `anchorY` as a fraction of the full document height, so markers follow scrolling), and the viewport size at the time.

**Selector priority:** `data-qa-id` → unique `id` → semantic attribute (`name`, `aria-label`, `data-testid`, `href`…) → other `data-*` → stable class → DOM path (last resort).

**Label priority:** `aria-label` → `data-qa-label` → button or link text (with nearby context, e.g. "Connect button (Harbor Grocers)") → field label → `title` → `alt` → heading/text → a tag name.

**Re-finding a target:** a saved selector is tried first. If it no longer matches on the note's screen, the marker falls back to the saved anchor and the card shows "Target may have changed". The note is never deleted. Selecting a note scrolls the preview to its target and outlines it. If the note belongs to another screen, a hint says which one.

**Developer view:** the same markers, read-only, shown only in the QA tab. Code mode stays clean.

### Making a prototype annotation-friendly (optional)

Annotation works on any HTML, but these attributes make it precise and resilient to HTML changes:

```html
<section data-qa-screen="Household">               <!-- names the screen -->
  <div class="modal" data-qa-state="Add member dialog"> <!-- names a temporary state -->
  <button data-qa-id="continue-button">Continue</button> <!-- stable target id -->
  <div data-qa-id="member-list" data-qa-label="Household member list">
```

Screen detection uses the closest visible `data-qa-screen`, then `aria-current`, then the document title, then the URL hash, then "Current screen". State uses the last visible `data-qa-state`, otherwise "Default". `examples/onboarding.html` shows the convention.

### Why not a same-origin iframe?

The spec suggested reading the prototype DOM directly through a same-origin iframe. That would mean dropping the sandbox. Prototype JavaScript would then run with full access to the Snippet Auditor page, including the access token in its URL and the API. Instead, detection runs inside the sandboxed preview and reports over `postMessage`. Messages are accepted only from the expected frame (`event.source`) and only with a per-render channel id. This is the cross-origin path the spec itself recommends, so it won't need reworking later.

## Project structure

```
api/                     Vercel serverless functions (also run by dev-server.js locally)
  access.js              POST   /api/access
  project.js             GET | PATCH /api/project
  pointers/index.js      GET | POST  /api/pointers
  pointers/[id].js       PATCH | DELETE /api/pointers/:id
lib/
  auth.js                authorizeRequest(): the one place tokens are checked
  tokens.js              crypto-random tokens, SHA-256 hashing, constant-time compare
  validate.js            input limits (name 120, HTML 2 MB, screen name 150, notes 5,000)
  http.js                response envelope, errors, request logging (no tokens)
  store/supabase.js      production data driver
  store/file.js          local data driver (same behaviour)
public/                  static frontend (no build step)
  developer/index.html   developer viewpoint
  client/index.html      client viewpoint (contains no editor, Run or Save)
  assets/                app.css, api.js, editor.js, preview.js (sandbox + QA bridge),
                         annotations.js (overlay, markers, composer), qa-panel.js, developer.js, client.js
scripts/create-project.js
supabase/schema.sql      full schema (idempotent; includes migration 002)
supabase/migrations/     incremental migrations for existing databases
tests/api.test.js        permission, scoping and data-flow tests
dev-server.js            local dev server (deliberately not named server.js; see Troubleshooting)
vercel.json              routes /project/:id/dev and /project/:id/qa, security headers
```

The plan suggested top-level `developer/`, `client/` and `shared/` folders. They live under `public/` so that Vercel serves only the frontend and never exposes `lib/` or `api/` source as static files.

## Permissions

| Capability | Developer link | Client link |
|---|:---:|:---:|
| View preview (saved HTML) | ✓ | ✓ |
| View, edit and Run HTML | ✓ | ✗ |
| Save HTML and project title | ✓ | ✗ (403) |
| View QA pointers | ✓ | ✓ |
| Add, edit and delete QA pointers | ✗ (403) | ✓ |

A link opened on the wrong path (a client token on `/dev`) is redirected to the view its token allows.

## API

All responses use `{ success: true, data }` or `{ success: false, error: { code, message } }`.
Send the token as `Authorization: Bearer <token>` and the project as `?projectId=…`.

| Method | Path | Role | Notes |
|---|---|---|---|
| POST | `/api/access` | any | Body `{ projectId, token }` → `{ authorized, role, project }` |
| GET | `/api/project` | any | `{ id, name, html, createdAt, updatedAt }` |
| PATCH | `/api/project` | developer | `{ name?, html?, baseUpdatedAt? }`. Returns 409 if someone saved after `baseUpdatedAt` |
| GET | `/api/pointers` | any | `{ pointers, nextPointerNumber }` |
| POST | `/api/pointers` | client | `{ screenName, notes, screenState?, targetType?, targetSelector?, targetLabel?, anchorX?, anchorY?, viewportWidth?, viewportHeight? }`. The server assigns `pointerNumber`. Anchors are clamped to 0–1; non-numbers, non-finite values, non-positive sizes and unknown target types are rejected |
| PATCH | `/api/pointers/:id` | client | Any subset of the POST fields (`anchorX`/`anchorY` together). The note must belong to the project |
| DELETE | `/api/pointers/:id` | client | |

Bad, unknown or cross-project tokens all get the same `401` body, so a response never reveals whether a project or token exists.

## Behaviour notes

- **Run never saves.** Save sends the title and HTML in one request, and the Save button is disabled while a save is in flight.
- **Save conflicts.** If the project was saved from another tab or browser since you loaded it, Save stops with "newer version exists" and offers to overwrite.
- **QA saving.** New notes are saved explicitly with **Add note**. If that fails, the draft and its marker stay, and the button offers Retry. Edits to existing notes (screen, target label, notes, change target) autosave 700 ms after you stop, and also on blur and on Cmd/Ctrl+S.
- **Stable numbers.** Numbers come from `projects.next_pointer_number`, which only ever increases. Deleted numbers are never reused, even the highest one.
- **Delete confirmation.** Deleting a note asks for confirmation first.
- **Refresh in the client view** first saves any pending notes, then loads the latest saved HTML and QA notes without discarding unsaved edits.
- **Preview isolation.** The preview is a sandboxed `srcdoc` iframe without `allow-same-origin`, so prototype code cannot read the page, the token or the API.
- **Referrer-Policy: no-referrer** is set on every page. Without it, a link or image inside a prototype could send the page URL, token included, to another site.
- **Browser storage.** Only UI preferences (viewport, selected pointer, panel) are kept in localStorage. Tokens are never stored or logged.

## Tests

```bash
npm test
```

Runs 19 API tests against the local server with a temporary file database. They cover:

- role per token, and generic 401s
- client-cannot-save (403) and developer-cannot-write-QA (403)
- cross-project scoping
- stable numbering after deletes
- validation limits, and the save-conflict check
- the client page containing no editor
- the annotation payload round-trip, legacy screen-only notes, anchor clamping, invalid values, and change target keeping the number and text

For the manual developer, client and cross-view checks, see sections 78–82 of the implementation plan.

## Deploy (later phase)

1. Push to GitHub without `.env.local`.
2. Import the repo in Vercel and set `SUPABASE_URL` and `SUPABASE_SECRET_KEY` in Project Settings → Environment Variables.
3. Set `APP_BASE_URL` locally to the production URL before running `create-project`, so the printed links point there.

## Known limits (MVP)

- Access links are bearer credentials: anyone with a link has that view. Share them privately, and use `--rotate` if one leaks.
- The client view never shows source code, but the browser has to receive the HTML to render it. Someone opening devtools can read the rendered prototype.
- There is no rate limiting on `/api/access`. 256-bit tokens make guessing infeasible, but add rate limiting before any public launch.
- There is no realtime sync. Use Refresh to see the other side's changes.

## Troubleshooting

**Vercel shows `500 FUNCTION_INVOCATION_FAILED` on every page.**
Vercel auto-detects a root-level `server.js`, `app.js` or `index.js` as a Node server and sends all traffic to it. Keep the local server named `dev-server.js`. Also check that the project's **Framework Preset** is **Other** (`vercel.json` pins this with `"framework": null`), then redeploy.

**Pages load but show "Connection failed" or "The server could not load this project."**
The `/api` functions can't reach Supabase. Check that `SUPABASE_URL` and `SUPABASE_SECRET_KEY` are set in Vercel → Settings → Environment Variables for the **Production** environment, and redeploy after adding them (variables only apply to new deployments). Also confirm `supabase/schema.sql` was run. Vercel → Logs shows the exact error.

**"Access denied" with a link that worked locally.**
Projects created with `DATA_DRIVER=file` live only in `.data/db.json` on your machine. Create the project again against Supabase (Phase 3) to get links that work in production.