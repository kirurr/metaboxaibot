import { useInfiniteQuery } from "@tanstack/react-query";
import { listPromptExamples } from "@/api/promptExamples";

export function useListPromptExamples(section?: string) {
  const query = useInfiniteQuery({
    queryKey: ["promptExamples", section],
    queryFn: ({ pageParam }) => listPromptExamples({ cursor: pageParam, section, take: 5 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  const prompts = query.data?.pages.flatMap((p) => p.items) ?? [];

  return {
    prompts,
    isLoading: query.isLoading,
    isFetchingNextPage: query.isFetchingNextPage,
    hasNextPage: query.hasNextPage,
    fetchNextPage: query.fetchNextPage,
    error: query.error,
  };
}
