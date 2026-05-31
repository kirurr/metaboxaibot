import { useQuery } from "@tanstack/react-query";
import { getTransactions, tokensKeys, type TransactionDto } from "@/api/auth";
import { ApiError } from "@/api/client";

interface State {
  transactions: TransactionDto[];
  loading: boolean;
  error: string | null;
}

/**
 * Загружает последние 20 транзакций токенов с `/auth/web-transactions`.
 * Если у юзера не привязан Telegram — api отдаёт пустой массив (а не 403),
 * поэтому empty-state рендерится без обработки кода.
 */
export function useTransactions(): State {
  const query = useQuery({
    queryKey: tokensKeys.transactions(),
    queryFn: getTransactions,
  });

  return {
    transactions: query.data?.transactions ?? [],
    loading: query.isLoading,
    error: query.error
      ? query.error instanceof ApiError
        ? query.error.message
        : "Не удалось загрузить транзакции"
      : null,
  };
}
