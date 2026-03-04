/**
 * PSID / UID 双格式 ID 解析工具。
 * 6 位纯数字 → PSID 查找；9 位纯数字 → UID 查找；其他 → 视为 CUID。
 */

import { prisma } from "@/lib/db";

const PSID_REGEX = /^\d{6}$/;
const UID_REGEX = /^\d{9}$/;

/** 是否为 6 位 PSID 格式 */
export function isPsidFormat(id: string): boolean {
  return PSID_REGEX.test(id);
}

/** 是否为 9 位 UID 格式 */
export function isUidFormat(id: string): boolean {
  return UID_REGEX.test(id);
}

/**
 * 解析服务器 ID：6 位数字按 PSID 查 DB 返回 CUID，否则原样返回。
 * 若 PSID 不存在返回 null。
 */
export async function resolveServerCuid(idOrPsid: string): Promise<string | null> {
  if (isPsidFormat(idOrPsid)) {
    const server = await prisma.server.findUnique({
      where: { psid: Number(idOrPsid) },
      select: { id: true },
    });
    return server?.id ?? null;
  }
  return idOrPsid;
}

/**
 * 解析用户 ID：9 位数字按 UID 查 DB 返回 CUID，否则原样返回。
 * 若 UID 不存在返回 null。
 */
export async function resolveUserCuid(idOrUid: string): Promise<string | null> {
  if (isUidFormat(idOrUid)) {
    const user = await prisma.user.findUnique({
      where: { uid: Number(idOrUid) },
      select: { id: true },
    });
    return user?.id ?? null;
  }
  return idOrUid;
}
