/**
 * 功能开关。通过环境变量控制功能的启用/禁用。
 */

/**
 * 私密服务器功能是否启用。
 * 通过 NEXT_PUBLIC_ENABLE_PRIVATE_SERVERS 环境变量控制，默认禁用。
 */
export function isPrivateServersEnabled(): boolean {
  const value = process.env.NEXT_PUBLIC_ENABLE_PRIVATE_SERVERS;
  return value === "true" || value === "1";
}
