import { NextResponse } from "next/server";
import { requireAdmin, isAdminError } from "@/lib/admin";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { adminModerationLogActionSchema } from "@/lib/validation";

/**
 * PATCH /api/admin/moderation/:id — 管理员标记已阅 / 添加备注。
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const adminResult = await requireAdmin();
    if (isAdminError(adminResult)) {
      return NextResponse.json({ error: adminResult.error }, { status: adminResult.status });
    }

    const { id } = await params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "请求体必须是合法 JSON" }, { status: 400 });
    }

    const parsed = adminModerationLogActionSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "校验失败", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const existing = await prisma.moderationLog.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!existing) {
      return NextResponse.json({ error: "日志不存在" }, { status: 404 });
    }

    const data: { reviewed?: boolean; adminNote?: string } = {};
    if (parsed.data.reviewed !== undefined) {
      data.reviewed = parsed.data.reviewed;
    }
    if (parsed.data.adminNote !== undefined) {
      data.adminNote = parsed.data.adminNote;
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "没有可更新的字段" }, { status: 400 });
    }

    await prisma.moderationLog.update({
      where: { id },
      data,
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error("[api/admin/moderation/[id]] Unexpected PATCH error", err);
    return NextResponse.json({ error: "服务器内部错误" }, { status: 500 });
  }
}
