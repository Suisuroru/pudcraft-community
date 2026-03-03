-- CreateTable
CREATE TABLE "moderation_logs" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "content_type" TEXT NOT NULL,
    "content_id" TEXT,
    "content_snippet" VARCHAR(500) NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "ai_category" TEXT,
    "ai_reason" TEXT,
    "user_id" TEXT,
    "user_ip" TEXT,
    "reviewed" BOOLEAN NOT NULL DEFAULT false,
    "admin_note" TEXT,

    CONSTRAINT "moderation_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "moderation_logs_content_type_passed_idx" ON "moderation_logs"("content_type", "passed");

-- CreateIndex
CREATE INDEX "moderation_logs_created_at_idx" ON "moderation_logs"("created_at");

-- CreateIndex
CREATE INDEX "moderation_logs_reviewed_passed_idx" ON "moderation_logs"("reviewed", "passed");

-- AddForeignKey
ALTER TABLE "moderation_logs" ADD CONSTRAINT "moderation_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
