-- BRANDS
CREATE TABLE "brands" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "color" TEXT NOT NULL DEFAULT 'emerald',
    "icon_url" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),
    CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "brands_slug_key" ON "brands"("slug");
CREATE INDEX "brands_archived_at_idx" ON "brands"("archived_at");
CREATE INDEX "brands_created_at_idx" ON "brands"("created_at" DESC);
ALTER TABLE "brands" ADD CONSTRAINT "brands_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ASSETS (referenced by brand_kit_assets and run_steps, so create before them)
CREATE TABLE "assets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "brand_id" UUID,
    "project_id" UUID,
    "storage_path" TEXT NOT NULL,
    "cdn_url" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "mime_type" TEXT,
    "size_bytes" BIGINT,
    "width" INTEGER,
    "height" INTEGER,
    "duration_sec" DOUBLE PRECISION,
    "source" TEXT NOT NULL,
    "model" TEXT,
    "prompt" TEXT,
    "seed" BIGINT,
    "metadata" JSONB,
    "run_step_id" UUID,
    "uploaded_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "assets_brand_id_idx" ON "assets"("brand_id");
CREATE INDEX "assets_project_id_idx" ON "assets"("project_id");
CREATE INDEX "assets_source_idx" ON "assets"("source");
CREATE INDEX "assets_kind_idx" ON "assets"("kind");
CREATE INDEX "assets_created_at_idx" ON "assets"("created_at" DESC);
ALTER TABLE "assets" ADD CONSTRAINT "assets_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "assets" ADD CONSTRAINT "assets_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "assets" ADD CONSTRAINT "assets_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- BRAND_KITS
CREATE TABLE "brand_kits" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "brand_id" UUID NOT NULL,
    "colors" TEXT,
    "fonts" TEXT,
    "voice" TEXT,
    "voice_clone_ids" TEXT,
    "lexicon_allow" TEXT,
    "lexicon_avoid" TEXT,
    "banned_themes" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "brand_kits_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "brand_kits_brand_id_key" ON "brand_kits"("brand_id");
ALTER TABLE "brand_kits" ADD CONSTRAINT "brand_kits_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brands"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- BRAND_KIT_ASSETS
CREATE TABLE "brand_kit_assets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "brand_kit_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "brand_kit_assets_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "brand_kit_assets_brand_kit_id_idx" ON "brand_kit_assets"("brand_kit_id");
ALTER TABLE "brand_kit_assets" ADD CONSTRAINT "brand_kit_assets_brand_kit_id_fkey" FOREIGN KEY ("brand_kit_id") REFERENCES "brand_kits"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "brand_kit_assets" ADD CONSTRAINT "brand_kit_assets_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- PROJECTS: add brand_id (nullable for legacy projects)
ALTER TABLE "projects" ADD COLUMN "brand_id" UUID;
CREATE INDEX "projects_brand_id_idx" ON "projects"("brand_id");
ALTER TABLE "projects" ADD CONSTRAINT "projects_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- WORKFLOWS: add variation_group_id
ALTER TABLE "workflows" ADD COLUMN "variation_group_id" TEXT;
CREATE INDEX "workflows_variation_group_id_idx" ON "workflows"("variation_group_id");

-- RUNS
CREATE TABLE "runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workflow_id" UUID NOT NULL,
    "triggered_by" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "total_cost_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "graph_snapshot" JSONB NOT NULL,
    CONSTRAINT "runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "runs_workflow_id_idx" ON "runs"("workflow_id");
CREATE INDEX "runs_triggered_by_idx" ON "runs"("triggered_by");
CREATE INDEX "runs_started_at_idx" ON "runs"("started_at" DESC);
ALTER TABLE "runs" ADD CONSTRAINT "runs_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "runs" ADD CONSTRAINT "runs_triggered_by_fkey" FOREIGN KEY ("triggered_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RUN_STEPS
CREATE TABLE "run_steps" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "node_id" TEXT NOT NULL,
    "node_type" TEXT NOT NULL,
    "model" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "cost_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "input_params" JSONB,
    "output_data" JSONB,
    "error_message" TEXT,
    "fal_request_id" TEXT,
    CONSTRAINT "run_steps_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "run_steps_run_id_idx" ON "run_steps"("run_id");
CREATE INDEX "run_steps_model_idx" ON "run_steps"("model");
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ASSETS: now safely add the run_step_id FK (run_steps table now exists)
ALTER TABLE "assets" ADD CONSTRAINT "assets_run_step_id_fkey" FOREIGN KEY ("run_step_id") REFERENCES "run_steps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- USAGE LOG
CREATE TABLE "usage_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "brand_id" UUID,
    "project_id" UUID,
    "workflow_id" UUID,
    "model" TEXT NOT NULL,
    "cost_usd" DOUBLE PRECISION NOT NULL,
    "duration_sec" DOUBLE PRECISION,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "usage_log_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "usage_log_user_id_occurred_at_idx" ON "usage_log"("user_id", "occurred_at" DESC);
CREATE INDEX "usage_log_brand_id_occurred_at_idx" ON "usage_log"("brand_id", "occurred_at" DESC);
CREATE INDEX "usage_log_model_occurred_at_idx" ON "usage_log"("model", "occurred_at" DESC);
