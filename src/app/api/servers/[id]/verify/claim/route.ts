export const dynamic = "force-dynamic";

import { resolve4, resolve6 } from "dns/promises";
import { isIP } from "net";

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { hashApiKey } from "@/lib/api-key";
import { getClientIp } from "@/lib/request-ip";
import { resolveServerCuid } from "@/lib/lookup";
import { serverLookupIdSchema } from "@/lib/validation";

/**
 * 将域名或 IP 解析为 IP 地址列表，用于校验请求来源。
 */
const LOOPBACK_ADDRS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function isLoopback(ip: string): boolean {
  return LOOPBACK_ADDRS.has(ip) || ip.startsWith("127.");
}

async function resolveHostIps(host: string): Promise<string[]> {
  if (isIP(host)) {
    return [host];
  }

  const ips: string[] = [];
  try {
    const ipv4 = await resolve4(host);
    ips.push(...ipv4);
  } catch {
    /* no A records */
  }
  try {
    const ipv6 = await resolve6(host);
    ips.push(...ipv6);
  } catch {
    /* no AAAA records */
  }

  return ips;
}

/**
 * POST /api/servers/:id/verify/claim
 *
 * 插件认领服务器。Auth via Bearer token (API Key / 认领密钥)。
 *
 * 两种场景：
 * 1. 认领密钥流程（verifyUserId 存在）— 需 IP 校验，成功后设置 ownerId
 * 2. 已有 owner 的 API Key 流程 — 无需 IP 校验，直接标记已验证
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const parsedId = serverLookupIdSchema.safeParse(id);
    if (!parsedId.success) {
      return NextResponse.json({ error: "无效的服务器 ID 格式" }, { status: 400 });
    }

    const cuid = await resolveServerCuid(parsedId.data);
    if (!cuid) {
      return NextResponse.json({ error: "服务器未找到" }, { status: 404 });
    }

    // 验证 Bearer token
    const authHeader = request.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "未授权" }, { status: 401 });
    }

    const rawKey = authHeader.slice(7);
    const keyHash = hashApiKey(rawKey);

    const server = await prisma.server.findUnique({
      where: { id: cuid },
      select: {
        isVerified: true,
        apiKeyHash: true,
        host: true,
        ownerId: true,
        verifyUserId: true,
        verifyExpiresAt: true,
      },
    });

    if (!server) {
      return NextResponse.json({ error: "服务器未找到" }, { status: 404 });
    }

    if (server.apiKeyHash !== keyHash) {
      return NextResponse.json({ error: "未授权" }, { status: 401 });
    }

    if (server.isVerified) {
      return NextResponse.json({ error: "服务器已被认领" }, { status: 409 });
    }

    // ── 场景 1: 认领密钥流程（有 verifyUserId）──
    if (server.verifyUserId) {
      if (!server.verifyExpiresAt || server.verifyExpiresAt < new Date()) {
        return NextResponse.json({ error: "认领密钥已过期，请重新生成" }, { status: 410 });
      }

      // IP 校验：请求来源必须与服务器 host 一致
      const clientIp = getClientIp(request);
      const serverIps = await resolveHostIps(server.host);

      // 回环地址匹配：客户端和服务器都在本机时放行
      // 生产环境 BLOCKED_HOST_PATTERNS 已禁止注册 localhost/内网 IP，此分支仅开发环境生效
      const serverIsLoopback = serverIps.some(isLoopback);
      const clientIsLoopback = clientIp === "unknown" || isLoopback(clientIp);
      const isLoopbackMatch = serverIsLoopback && clientIsLoopback;

      if (!isLoopbackMatch && (clientIp === "unknown" || serverIps.length === 0 || !serverIps.includes(clientIp))) {
        logger.warn("[verify/claim] IP mismatch", {
          serverId: cuid,
          clientIp,
          serverHost: server.host,
          resolvedIps: serverIps,
        });
        return NextResponse.json({ error: "请求来源 IP 与服务器地址不匹配" }, { status: 403 });
      }

      await prisma.server.update({
        where: { id: cuid },
        data: {
          isVerified: true,
          verifiedAt: new Date(),
          ownerId: server.verifyUserId,
          verifyToken: null,
          verifyExpiresAt: null,
          verifyUserId: null,
        },
      });

      return NextResponse.json({ success: true });
    }

    // ── 场景 2: 已有 owner 的 API Key 流程 ──
    await prisma.server.update({
      where: { id: cuid },
      data: {
        isVerified: true,
        verifiedAt: new Date(),
      },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error("[api/servers/[id]/verify/claim] Unexpected POST error", err);
    return NextResponse.json({ error: "服务器内部错误" }, { status: 500 });
  }
}
