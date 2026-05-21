-- AlterTable
ALTER TABLE "projects" ADD COLUMN "color" TEXT NOT NULL DEFAULT 'emerald';

-- CreateIndex
CREATE INDEX "projects_archived_at_idx" ON "projects"("archived_at");

-- CreateIndex
CREATE INDEX "workflows_updated_at_idx" ON "workflows"("updated_at" DESC);
