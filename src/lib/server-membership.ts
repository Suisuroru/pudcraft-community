import { prisma } from "@/lib/db";

/** Check if a user is a member of a private/unlisted server. */
export async function isServerMember(serverId: string, userId: string): Promise<boolean> {
  const member = await prisma.serverMember.findUnique({
    where: { unique_server_member: { serverId, userId } },
    select: { id: true },
  });
  return member !== null;
}

/** Check if user can see server address based on visibility and membership. */
export async function canSeeServerAddress(
  server: { visibility: string; ownerId: string | null },
  userId: string | undefined,
  userRole: string | undefined,
  serverId: string,
): Promise<boolean> {
  if (server.visibility === "public") return true;
  if (!userId) return false;
  if (userRole === "admin") return true;
  if (server.ownerId === userId) return true;
  return isServerMember(serverId, userId);
}

/** Require server ownership for console operations. */
export async function requireServerOwner(
  serverId: string,
  userId: string,
): Promise<{ id: string; ownerId: string | null } | null> {
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    select: { id: true, ownerId: true },
  });
  if (!server || server.ownerId !== userId) return null;
  return server;
}
