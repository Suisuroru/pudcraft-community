-- AlterTable
ALTER TABLE "servers" ADD COLUMN     "api_key_hash" TEXT,
ADD COLUMN     "application_form" JSONB,
ADD COLUMN     "join_mode" TEXT NOT NULL DEFAULT 'open',
ADD COLUMN     "visibility" TEXT NOT NULL DEFAULT 'public';

-- CreateTable
CREATE TABLE "server_applications" (
    "id" TEXT NOT NULL,
    "server_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "form_data" JSONB,
    "review_note" TEXT,
    "reviewed_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "server_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "server_invites" (
    "id" TEXT NOT NULL,
    "server_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "max_uses" INTEGER,
    "used_count" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "server_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "server_members" (
    "id" TEXT NOT NULL,
    "server_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "joined_via" TEXT NOT NULL,
    "mc_username" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "server_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whitelist_syncs" (
    "id" TEXT NOT NULL,
    "server_id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMP(3),
    "acked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whitelist_syncs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "server_applications_server_id_status_idx" ON "server_applications"("server_id", "status");

-- CreateIndex
CREATE INDEX "server_applications_user_id_idx" ON "server_applications"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "server_applications_server_id_user_id_key" ON "server_applications"("server_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "server_invites_code_key" ON "server_invites"("code");

-- CreateIndex
CREATE INDEX "server_invites_server_id_idx" ON "server_invites"("server_id");

-- CreateIndex
CREATE INDEX "server_members_server_id_idx" ON "server_members"("server_id");

-- CreateIndex
CREATE INDEX "server_members_user_id_idx" ON "server_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "server_members_server_id_user_id_key" ON "server_members"("server_id", "user_id");

-- CreateIndex
CREATE INDEX "whitelist_syncs_server_id_status_idx" ON "whitelist_syncs"("server_id", "status");

-- CreateIndex
CREATE INDEX "whitelist_syncs_member_id_idx" ON "whitelist_syncs"("member_id");

-- AddForeignKey
ALTER TABLE "server_applications" ADD CONSTRAINT "server_applications_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_applications" ADD CONSTRAINT "server_applications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_applications" ADD CONSTRAINT "server_applications_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_invites" ADD CONSTRAINT "server_invites_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_invites" ADD CONSTRAINT "server_invites_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_members" ADD CONSTRAINT "server_members_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_members" ADD CONSTRAINT "server_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whitelist_syncs" ADD CONSTRAINT "whitelist_syncs_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whitelist_syncs" ADD CONSTRAINT "whitelist_syncs_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "server_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;
