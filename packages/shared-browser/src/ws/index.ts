import type z from "zod";
import { exampleMessageToClient, exampleMessageToServer } from "./schemas.js";

export const clientToServerEvents = {
  "example:send": exampleMessageToServer,
};

export const serverToClientEvents = {
  "example:recieve": exampleMessageToClient,
};

type EventMap = Record<string, z.ZodType>;
type InferEvents<T extends EventMap> = {
  [K in keyof T]: (data: z.infer<T[K]>) => void;
};

export type ClientToServerEvents = InferEvents<typeof clientToServerEvents>;
export type ServerToClientEvents = InferEvents<typeof serverToClientEvents>;
