-- Step 4.11: BrandKit fields for product context
-- Adds app store links, product pitch (short description for system prompt),
-- and ui_screenshots (newline-separated CDN URLs) so the runner can inject
-- the full brand context into every LLM call as a system prompt.

ALTER TABLE "BrandKit"
  ADD COLUMN IF NOT EXISTS "app_store_url"    TEXT,
  ADD COLUMN IF NOT EXISTS "google_play_url"  TEXT,
  ADD COLUMN IF NOT EXISTS "product_pitch"    TEXT,
  ADD COLUMN IF NOT EXISTS "ui_screenshots"   TEXT;
