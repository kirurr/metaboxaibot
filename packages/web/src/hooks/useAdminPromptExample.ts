import { useQuery } from "@tanstack/react-query";
import { adminGetPromptExample } from "@/api/promptExamples";

export function useAdminPromptExample(id: string | undefined) {
  return useQuery({
    queryKey: ["adminPromptExample", id],
    queryFn: () => adminGetPromptExample(id!),
    enabled: !!id,
    // Editor использует данные только для первичного reset формы. Фоновые
    // refetch'и (например, при возврате на вкладку браузера) поверх несохранённых
    // правок были бы деструктивны — отключаем.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
