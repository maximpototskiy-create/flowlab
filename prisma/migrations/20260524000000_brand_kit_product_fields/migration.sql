-- Step 4.11: BrandKit fields for product context
-- Adds app store links, product pitch (short description for system prompt),
-- and ui_screenshots (newline-separated CDN URLs) so the runner can inject
-- the full brand context into every LLM call as a system prompt.
--
-- Note: Prisma model `BrandKit` is mapped to physical table `brand_kits`
-- (see @@map in schema.prisma), so the ALTER targets the snake_case name.

ALTER TABLE "brand_kits"
  ADD COLUMN IF NOT EXISTS "app_store_url"    TEXT,
  ADD COLUMN IF NOT EXISTS "google_play_url"  TEXT,
  ADD COLUMN IF NOT EXISTS "product_pitch"    TEXT,
  ADD COLUMN IF NOT EXISTS "ui_screenshots"   TEXT;
