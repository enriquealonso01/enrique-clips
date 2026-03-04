

# Phase 2: Edge Functions, Image Upload, Run Triggering & Wiring

Phase 1 delivered the UI shell and database. Phase 2 connects everything: functional image uploads, run creation, project control API endpoints, and real-time run monitoring.

## 1. Initial Image Upload (Image Tab)
Wire the "Choose File" button in the Project Editor Image tab to actually upload images to the `project-assets` storage bucket.

- File input with drag-and-drop support
- Upload to `project-assets/{projectId}/initial-image/{filename}`
- Create an `assets` record with `type = 'initial_image'`
- Update `projects.initial_asset_id` to point to the new asset
- Show preview of uploaded image with replace/remove buttons
- Display loading state during upload

## 2. Run Now / Pause / Resume / Stop Wiring
Connect the action buttons on the Projects List and Run Monitor pages.

- **Run Now**: Insert a new `runs` row with `status = 'queued'`, navigate to Run Monitor
- **Pause**: Update run `status` to `'paused'`
- **Resume**: Update run `status` back to `'running'`
- **Stop**: Update run `status` to `'stopped'`
- Add confirmation dialogs for Stop
- Disable buttons based on current run state (e.g., can't pause a queued run)

## 3. Project Control API (Edge Functions)
Create edge functions for external automation, secured by project control tokens.

- **`project-control`** edge function handling routes:
  - `POST /trigger` — creates a new run for the project
  - `POST /pause` — pauses the active run
  - `POST /resume` — resumes a paused run
  - `POST /stop` — stops the active run
  - `GET /status` — returns current run status
- Token validation: hash the incoming `X-Project-Token` header and compare against `project_control_token_hash`
- Set `verify_jwt = false` in config.toml for this function

## 4. Upload-Post Webhook Receiver (Edge Function)
Create an edge function to receive webhook callbacks from Upload-Post.

- **`uploadpost-webhook`** edge function
- Receives POST with platform results payload
- Updates `publish_jobs.platform_results` and `publish_jobs.status`
- Set `verify_jwt = false` in config.toml

## 5. Runs History on Project Detail
Add a "Runs" section to the Project Editor showing past runs.

- List of recent runs with status badges, timestamps, and links to Run Monitor
- Visible below or as a tab in the Project Editor

## 6. Realtime for Run Monitor
Enable realtime on `runs`, `scenes`, and `run_logs` tables so the Run Monitor page auto-updates without polling.

- Add tables to `supabase_realtime` publication
- Replace `refetchInterval` polling with Supabase realtime subscriptions
- Live log streaming and progress updates

## 7. API Key Secure Storage
Store API keys as project-level encrypted values rather than plaintext in the projects table.

- The Upload-Post API key in the Publish tab currently saves to `uploadpost_api_key_encrypted` as plaintext
- Hash or encrypt before storing; show only configured/not-configured status
- Global settings keys (OpenAI, Gemini, Kling) stored as Cloud secrets via the secrets tool

## Technical Notes
- Edge functions use CORS headers for browser access
- Project control token is hashed with SHA-256 before comparison
- Realtime migration: `ALTER PUBLICATION supabase_realtime ADD TABLE runs, scenes, run_logs;`

