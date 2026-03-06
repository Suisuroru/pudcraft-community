export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { isActiveUserError, requireActiveUser } from "@/lib/auth-guard";
import { generateApiKey } from "@/lib/api-key";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { resolveServerCuid } from "@/lib/lookup";
import { serverLookupIdSchema } from "@/lib/validation";

/**
 * POST /api/servers/:id/api-key — 生成或重置服务器 API Key（仅 owner）。
 * 返回的明文密钥仅展示一次，之后只能重新生成。
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authResult = await requireActiveUser();
    if (isActiveUserError(authResult)) {
      return authResult.response;
    }
    const userId = authResult.user.id;

    const { id } = await params;
    const parsedId = serverLookupIdSchema.safeParse(id);
    if (!parsedId.success) {
      return NextResponse.json({ error: "无效的服务器 ID 格式" }, { status: 400 });
    }

    const cuid = await resolveServerCuid(parsedId.data);
    if (!cuid) {
      return NextResponse.json({ error: "服务器未找到" }, { status: 404 });
    }

    const server = await prisma.server.findUnique({
      where: { id: cuid },
      select: { id: true, ownerId: true },
    });

    if (!server) {
      return NextResponse.json({ error: "服务器未找到" }, { status: 404 });
    }

    if (!server.ownerId || server.ownerId !== userId) {
      return NextResponse.json({ error: "无权限" }, { status: 403 });
    }

    const { raw, hash } = generateApiKey();

    await prisma.server.update({
      where: { id: server.id },
      data: { apiKeyHash: hash },
    });

    return NextResponse.json({
      success: true,
      apiKey: raw,
      message: "API Key 已生成，请妥善保存。此密钥仅显示一次。",
    });
  } catch (error) {
    logger.error("[api/servers/[id]/api-key] Unexpected POST error", error);
    return NextResponse.json({ error: "服务器内部错误" }, { status: 500 });
  }
}
