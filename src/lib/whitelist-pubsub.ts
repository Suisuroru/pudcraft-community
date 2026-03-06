import { getRedisConnection } from "@/lib/redis";

export const WHITELIST_CHANNEL = "whitelist:change";

export interface WhitelistChangeMessage {
  serverId: string;
  syncId: string;
  action: "add" | "remove";
  mcUsername: string;
}

/** Publish a whitelist change event. */
export async function publishWhitelistChange(
  message: WhitelistChangeMessage,
): Promise<void> {
  const redis = getRedisConnection();
  await redis.publish(WHITELIST_CHANNEL, JSON.stringify(message));
}
