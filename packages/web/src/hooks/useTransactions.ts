import { useEffect, useState } from "react";
import { getTransactions, type TransactionDto } from "@/api/auth";
import { ApiError } from "@/api/client";

interface State {
  transactions: TransactionDto[];
  loading: boolean;
  error: string | null;
}

/**
 * Загружает последние 20 транзакций токенов с `/auth/web-transactions`.
 * Если у юзера не привязан Telegram — api отдаст пустой массив (а не 403),
 * чтобы можно было нормально отрендерить empty-state без обработки кода.
 */
export function useTransactions(): State {
  const [state, setState] = useState<State>({
    transactions: [],
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    getTransactions()
      .then((res) => {
        if (cancelled) return;
        setState({ transactions: res.transactions, loading: false, error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        const msg = err instanceof ApiError ? err.message : "Не удалось загрузить транзакции";
        setState({ transactions: [], loading: false, error: msg });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
