import type z from "zod";
import {
  exampleMessageToClient,
  exampleMessageToServer,
  notificationSnapshotEvent,
  notificationNewEvent,
  notificationMarkSeenEvent,
  notificationDeleteEvent,
} from "./schemas.js";

export * from "./schemas.js";

export const clientToServerEvents = {
  "example:send": exampleMessageToServer,
  "notification:mark-seen": notificationMarkSeenEvent,
  "notification:delete": notificationDeleteEvent,
};

export const serverToClientEvents = {
  "example:recieve": exampleMessageToClient,
  "notification:snapshot": notificationSnapshotEvent,
  "notification:new": notificationNewEvent,
};

type EventMap = Record<string, z.ZodType>;
type InferEvents<T extends EventMap> = {
  [K in keyof T]: (data: z.infer<T[K]>) => void;
};

export type ClientToServerEvents = InferEvents<typeof clientToServerEvents>;
export type ServerToClientEvents = InferEvents<typeof serverToClientEvents>;
