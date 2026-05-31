import { useQuery } from "@tanstack/react-query";
import { billingKeys, getCatalog } from "@/api/billing";

/** Каталог биллинга (подписки + пакеты токенов) из `/web/billing/catalog`. */
export function useCatalog() {
  return useQuery({
    queryKey: billingKeys.catalog(),
    queryFn: getCatalog,
  });
}
