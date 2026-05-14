import { useQuery } from "@tanstack/react-query";
import { adminListPromptModels } from "@/api/promptExamples";

export function useAdminPromptModels() {
  return useQuery({
    queryKey: ["adminPromptModels"],
    queryFn: adminListPromptModels,
    staleTime: Infinity,
  });
}
