import { prisma } from "@/lib/db";
import { hashApiKey } from "@/lib/api-key";

/** Authenticate a plugin request via API key in Authorization header. Returns true if valid. */
export async function authenticatePlugin(
  request: Request,
  expectedServerId: string,
): Promise<boolean> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return false;

  const raw = authHeader.slice(7);
  const hash = hashApiKey(raw);

  const server = await prisma.server.findUnique({
    where: { id: expectedServerId },
    select: { apiKeyHash: true },
  });

  return server?.apiKeyHash === hash;
}
