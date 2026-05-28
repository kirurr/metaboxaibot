import { create } from "zustand";

export interface TrackedJobOutput {
  id: string;
  url: string | null;
  thumbnailUrl: string | null;
}

export interface PendingJob {
  /** dbJobId, возвращённый submit-эндпоинтом — совпадает с id job'а в галерее. */
  id: string;
  modelId: string;
  /** "image" | "video" | "audio" — нормализованная секция (design → image). */
  section: string;
  prompt: string;
  startedAt: number;
  /** WS-driven статус. По умолчанию pending; переключается на success/error из usePendingJobsSync. */
  status?: "pending" | "success" | "error";
  /** Заполняется на success — outputs из WS-уведомления, до refetch'а истории/галереи. */
  outputs?: TrackedJobOutput[];
  /** Заполняется на error — message из WS-уведомления. */
  errorMessage?: string;
}

interface PendingJobsState {
  pendingJobs: PendingJob[];
  add: (job: PendingJob) => void;
  markSuccess: (id: string, outputs: TrackedJobOutput[]) => void;
  markError: (id: string, errorMessage: string) => void;
  remove: (id: string) => void;
}

export const usePendingJobsStore = create<PendingJobsState>((set) => ({
  pendingJobs: [],
  add: (job) => set((s) => ({ pendingJobs: [job, ...s.pendingJobs] })),
  markSuccess: (id, outputs) =>
    set((s) => ({
      pendingJobs: s.pendingJobs.map((p) =>
        p.id === id ? { ...p, status: "success", outputs } : p,
      ),
    })),
  markError: (id, errorMessage) =>
    set((s) => ({
      pendingJobs: s.pendingJobs.map((p) =>
        p.id === id ? { ...p, status: "error", errorMessage } : p,
      ),
    })),
  remove: (id) => set((s) => ({ pendingJobs: s.pendingJobs.filter((p) => p.id !== id) })),
}));
