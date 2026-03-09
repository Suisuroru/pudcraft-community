import type { WebSocket } from "ws";

const connections = new Map<string, Set<WebSocket>>();

export function addConnection(serverId: string, ws: WebSocket): void {
  if (!connections.has(serverId)) {
    connections.set(serverId, new Set());
  }
  connections.get(serverId)!.add(ws);
}

export function removeConnection(serverId: string, ws: WebSocket): void {
  const set = connections.get(serverId);
  if (set) {
    set.delete(ws);
    if (set.size === 0) connections.delete(serverId);
  }
}

export function getConnections(serverId: string): Set<WebSocket> | undefined {
  return connections.get(serverId);
}

export function isServerConnected(serverId: string): boolean {
  const set = connections.get(serverId);
  return set !== undefined && set.size > 0;
}
