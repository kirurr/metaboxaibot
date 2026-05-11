import { type RouteOptions } from "fastify";

export const unauthorizedResponse = {
  description: "Unauthorized",
  type: "object",
  properties: {
    error: { type: "string" },
  },
};

export const userNotFoundResponse = {
  description: "User not found",
  type: "object",
  properties: {
    error: { type: "string" },
  },
};

export const userIsBlockedResponse = {
  description: "User is blocked",
  type: "object",
  properties: {
    error: { type: "string" },
  },
};

export const forbiddenResponse = {
  description: "Forbidden",
  type: "object",
  properties: {
    error: { type: "string" },
  },
};

export const conflictResponse = {
  description: "Conflict",
  type: "object",
  properties: {
    error: { type: "string" },
  },
};

export const badRequestResponse = {
  description: "Bad request",
  type: "object",
  properties: {
    error: { type: "string" },
    code: { type: "string" },
  },
};

export const rateLimitResponse = {
  description: "Rate limit exceeded",
  type: "object",
  properties: {
    code: { type: "string" },
    error: { type: "string" },
    retryAfterSec: { type: "number" },
    attemptsLeft: { type: "number" },
  },
};

export const metaboxApiErrorResponse = {
  description: "Metabox API error",
  type: "object",
  properties: {
    error: { type: "string" },
    code: { type: "string" },
  },
};

export const gatewayErrorResponse = {
  description: "Gateway error",
  type: "object",
  properties: {
    error: { type: "string" },
  },
};

/**
 *
 * Used in 'onRoute' hook to add common response schemas, auth guard and tag to all endpoints within router.
 */
export function constructOpenAPIonRouteHook(routeOptions: RouteOptions, tags: string[]) {
  routeOptions.schema ??= {};
  routeOptions.schema.response ??= {};

  // @ts-expect-error response is unknown
  if (!routeOptions.schema.response[401]) {
    // @ts-expect-error response is unknown
    routeOptions.schema.response[401] = unauthorizedResponse;
  }
  // @ts-expect-error response is unknown
  if (!routeOptions.schema.response[404]) {
    // @ts-expect-error response is unknown
    routeOptions.schema.response[404] = userNotFoundResponse;
  }
  // @ts-expect-error response is unknown
  if (!routeOptions.schema.response[403]) {
    // @ts-expect-error response is unknown
    routeOptions.schema.response[403] = userIsBlockedResponse;
  }

  routeOptions.schema.tags ??= tags;
  routeOptions.schema.security ??= [
    {
      telegramAuth: [],
    },
  ];
}
