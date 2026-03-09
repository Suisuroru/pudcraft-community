export const dynamic = "force-dynamic";

import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { isActiveUserError, requireActiveUser } from "@/lib/auth-guard";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { resolveServerCuid } from "@/lib/lookup";
import { serverLookupIdSchema, createInviteSchema } from "@/lib/validation";
import type { ServerInviteItem } from "@/lib/types";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/servers/:id/invites
 * 列出服务器的所有邀请码（仅 owner 可访问）。
 */
export async function GET(_request: Request, { params }: RouteContext) {
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

    const invites = await prisma.serverInvite.findMany({
      where: { serverId: server.id },
      include: {
        creator: {
          select: { name: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const data: ServerInviteItem[] = invites.map((invite) => ({
      id: invite.id,
      code: invite.code,
      creatorName: invite.creator.name,
      maxUses: invite.maxUses,
      usedCount: invite.usedCount,
      expiresAt: invite.expiresAt?.toISOString() ?? null,
      createdAt: invite.createdAt.toISOString(),
    }));

    return NextResponse.json({ data });
  } catch (error) {
    logger.error("[api/servers/[id]/invites] Unexpected GET error", error);
    return NextResponse.json({ error: "服务器内部错误" }, { status: 500 });
  }
}

/**
 * POST /api/servers/:id/invites
 * 创建邀请码（仅 owner 可操作，需服务器 joinMode 包含 invite）。
 */
export async function POST(request: Request, { params }: RouteContext) {
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
      select: { id: true, psid: true, ownerId: true, joinMode: true },
    });

    if (!server) {
      return NextResponse.json({ error: "服务器未找到" }, { status: 404 });
    }

    if (!server.ownerId || server.ownerId !== userId) {
      return NextResponse.json({ error: "无权限" }, { status: 403 });
    }

    // 检查 joinMode 是否包含 invite
    if (server.joinMode !== "invite" && server.joinMode !== "apply_and_invite") {
      return NextResponse.json(
        { error: "当前加入模式不支持邀请码" },
        { status: 400 },
      );
    }

    const body: unknown = await request.json();
    const parsed = createInviteSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "校验失败", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const { maxUses, expiresInHours } = parsed.data;

    // 生成 16 位十六进制邀请码（8 字节熵）
    const code = randomBytes(8).toString("hex");

    // 计算过期时间
    const expiresAt =
      expiresInHours != null
        ? new Date(Date.now() + expiresInHours * 60 * 60 * 1000)
        : null;

    const invite = await prisma.serverInvite.create({
      data: {
        serverId: server.id,
        code,
        createdBy: userId,
        maxUses: maxUses ?? null,
        expiresAt,
      },
    });

    return NextResponse.json({
      success: true,
      data: {
        id: invite.id,
        code: invite.code,
        url: `/servers/${server.psid}/join/${invite.code}`,
        maxUses: invite.maxUses,
        usedCount: invite.usedCount,
        expiresAt: invite.expiresAt?.toISOString() ?? null,
        createdAt: invite.createdAt.toISOString(),
      },
    });
  } catch (error) {
    logger.error("[api/servers/[id]/invites] Unexpected POST error", error);
    return NextResponse.json({ error: "服务器内部错误" }, { status: 500 });
  }
}
