import { apiClient } from "./client";

export interface PlanPeriod {
  priceRub: string;
  discountPct: number;
}

export interface PlanDto {
  id: string;
  name: string;
  tokens: number;
  /** Периоды: M1 / M3 / M6 / M12. M1 всегда есть, остальные — по скидкам. */
  periods: Partial<Record<"M1" | "M3" | "M6" | "M12", PlanPeriod>>;
}

export interface TokenPackDto {
  id: string;
  name: string;
  tokens: number;
  priceRub: string;
  badge: string | null;
}

export interface CatalogDto {
  subscriptions: PlanDto[];
  tokenPackages: TokenPackDto[];
}

export const billingKeys = {
  all: ["billing"] as const,
  catalog: () => [...billingKeys.all, "catalog"] as const,
};

export function getCatalog() {
  return apiClient<CatalogDto>("/web/billing/catalog");
}

export function createSubscriptionOrder(planId: string, period: "M1" | "M3" | "M6" | "M12") {
  return apiClient<{ orderId: string; paymentUrl: string }, { planId: string; period: string }>(
    "/web/billing/subscription-invoice",
    {
      method: "POST",
      body: { planId, period },
    },
  );
}

export function createTokensOrder(productId: string) {
  return apiClient<{ orderId: string; paymentUrl: string }, { productId: string }>(
    "/web/billing/tokens-invoice",
    { method: "POST", body: { productId } },
  );
}

export function getOrderStatus(orderId: string) {
  return apiClient<{ status: "PENDING" | "PAID" | "FAILED" | string }>(
    `/web/billing/order/${encodeURIComponent(orderId)}/status`,
  );
}
