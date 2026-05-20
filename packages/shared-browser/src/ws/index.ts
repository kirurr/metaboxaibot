import type z from "zod";
import {
  notificationSnapshotEvent,
  notificationNewEvent,
  notificationMarkSeenEvent,
  notificationDeleteEvent,
} from "./schemas.js";

export * from "./schemas.js";

export const clientToServerEvents = {
  "notification:mark-seen": notificationMarkSeenEvent,
  "notification:delete": notificationDeleteEvent,
};

export const serverToClientEvents = {
  "notification:snapshot": notificationSnapshotEvent,
  "notification:new": notificationNewEvent,
};

type EventMap = Record<string, z.ZodType>;
type InferEvents<T extends EventMap> = {
  [K in keyof T]: (data: z.infer<T[K]>) => void;
};

export type ClientToServerEvents = InferEvents<typeof clientToServerEvents>;
export type ServerToClientEvents = InferEvents<typeof serverToClientEvents>;
