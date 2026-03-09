-- CreateIndex
CREATE INDEX "servers_status_visibility_discoverable_idx" ON "servers"("status", "visibility", "discoverable");
