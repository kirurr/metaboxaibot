import { useQuery } from "@tanstack/react-query";
import { getDailyUsage, tokensKeys, type DailyUsageDto } from "@/api/auth";

interface State {
  days: DailyUsageDto[];
  loading: boolean;
}

/**
 * Дневной расход токенов за последние 28 дней (график на странице Tokens).
 * Бэкенд возвращает ровно 28 элементов (старый→новый) с zero-fill, либо
 * пустой массив для web-only юзера без привязанного Telegram.
 */
export function useDailyUsage(): State {
  const query = useQuery({
    queryKey: tokensKeys.dailyUsage(),
    queryFn: getDailyUsage,
  });

  return {
    days: query.data?.data ?? [],
    loading: query.isLoading,
  };
}
