-- AlterTable
ALTER TABLE "server_statuses" ADD COLUMN     "plugin_extra" JSONB;

-- AlterTable
ALTER TABLE "servers" ADD COLUMN     "last_plugin_report_at" TIMESTAMP(3);
