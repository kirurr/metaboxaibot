import { useMutation } from "@tanstack/react-query";
import { createTokensOrder } from "@/api/billing";

/**
 * Создаёт заказ на покупку пакета токенов и редиректит на оплату.
 * Ошибки прокидываются в `onError` вызывающего (тост рисует компонент).
 */
export function useBuyTokens() {
  return useMutation({
    mutationFn: (productId: string) => createTokensOrder(productId),
    onSuccess: ({ paymentUrl }) => {
      window.location.href = paymentUrl;
    },
  });
}
