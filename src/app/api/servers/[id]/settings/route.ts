export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { isActiveUserError, requireActiveUser } from "@/lib/auth-guard";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { resolveServerCuid } from "@/lib/lookup";
import { serverLookupIdSchema, updateServerSettingsSchema } from "@/lib/validation";

/**
 * PUT /api/servers/:id/settings — 更新服务器私域设置（可见性、加入模式、申请表单）。
 * 仅服务器 owner 可操作。
 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
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

    const existing = await prisma.server.findUnique({
      where: { id: cuid },
      select: {
        id: true,
        ownerId: true,
        visibility: true,
        joinMode: true,
        applicationForm: true,
      },
    });

    if (!existing) {
      return NextResponse.json({ error: "服务器未找到" }, { status: 404 });
    }

    if (!existing.ownerId || existing.ownerId !== userId) {
      return NextResponse.json({ error: "无权限" }, { status: 403 });
    }

    const body: unknown = await request.json();
    const parsed = updateServerSettingsSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "校验失败", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const { visibility, discoverable, joinMode, applicationForm } = parsed.data;

    const updateData: Record<string, unknown> = {};
    if (visibility !== undefined) {
      updateData.visibility = visibility;
      // 切换为公开时自动关闭 discoverable（公开服务器不需要此开关）
      if (visibility === "public") {
        updateData.discoverable = false;
      }
    }
    if (discoverable !== undefined) {
      updateData.discoverable = discoverable;
    }
    if (joinMode !== undefined) {
      updateData.joinMode = joinMode;
    }
    if (applicationForm !== undefined) {
      updateData.applicationForm = applicationForm;
    }

    const updated = await prisma.server.update({
      where: { id: existing.id },
      data: updateData,
      select: {
        id: true,
        visibility: true,
        discoverable: true,
        joinMode: true,
        applicationForm: true,
        updatedAt: true,
      },
    });

    return NextResponse.json({
      success: true,
      data: {
        visibility: updated.visibility,
        discoverable: updated.discoverable,
        joinMode: updated.joinMode,
        applicationForm: updated.applicationForm,
        updatedAt: updated.updatedAt.toISOString(),
      },
    });
  } catch (err) {
    logger.error("[api/servers/[id]/settings] Unexpected PUT error", err);
    return NextResponse.json({ error: "服务器内部错误" }, { status: 500 });
  }
}
