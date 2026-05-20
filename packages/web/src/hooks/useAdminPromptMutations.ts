import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  adminCreatePromptExample,
  adminUpdatePromptExample,
  adminDeletePromptExample,
} from "@/api/promptExamples";
import type { CreatePromptExampleBody, UpdatePromptExampleBody } from "@metabox/shared-browser/dto";

function invalidatePromptLists(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["promptExamples"] });
}

export function useCreatePromptExample() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreatePromptExampleBody) => adminCreatePromptExample(body),
    onSuccess: () => invalidatePromptLists(qc),
  });
}

export function useUpdatePromptExample(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdatePromptExampleBody) => adminUpdatePromptExample(id, body),
    onSuccess: () => {
      invalidatePromptLists(qc);
      qc.invalidateQueries({ queryKey: ["adminPromptExample", id] });
    },
  });
}

export function useDeletePromptExample() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => adminDeletePromptExample(id),
    onSuccess: () => invalidatePromptLists(qc),
  });
}
