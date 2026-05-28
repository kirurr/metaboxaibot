import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { galleryKeys } from "@/api/gallery";
import { useNotificationsStore } from "@/stores/notificationsStore";
import { usePendingJobsStore, type TrackedJobOutput } from "@/stores/pendingJobsStore";

/**
 * Глобальный sync pending-job'ов с WS-уведомлениями. Монтируется один раз
 * (см. router/guards.tsx → WSNotificationProvider), чтобы pending'и
 * подхватывались независимо от того, открыта ли страница /generate или /gallery.
 *
 * После success — auto-remove из store через SUCCESS_AUTO_REMOVE_MS, чтобы
 * pending не висел вечно если работа не попала на текущую страницу галереи
 * (gallery query за это время точно отрефетчится через invalidateQueries).
 */
const SUCCESS_AUTO_REMOVE_MS = 10000;

export function usePendingJobsSync() {
  const notifications = useNotificationsStore((s) => s.list);
  const pendingJobs = usePendingJobsStore((s) => s.pendingJobs);
  const markSuccess = usePendingJobsStore((s) => s.markSuccess);
  const markError = usePendingJobsStore((s) => s.markError);
  const removePending = usePendingJobsStore((s) => s.remove);
  const qc = useQueryClient();

  useEffect(() => {
    if (pendingJobs.length === 0) return;
    for (const pending of pendingJobs) {
      if (pending.status === "success") continue;
      const notif = notifications.find((n) => n.jobId === pending.id);
      if (!notif) continue;
      if (notif.type.endsWith("_success")) {
        const data = (notif.data ?? {}) as {
          outputs?: Array<{ id: string; outputUrl?: string | null }>;
        };
        const outputs: TrackedJobOutput[] = (data.outputs ?? []).map((o) => ({
          id: o.id,
          url: o.outputUrl ?? null,
          thumbnailUrl: null,
        }));
        markSuccess(pending.id, outputs);
        void qc.invalidateQueries({ queryKey: galleryKeys.all });
        const idToRemove = pending.id;
        setTimeout(() => removePending(idToRemove), SUCCESS_AUTO_REMOVE_MS);
      } else if (notif.type.endsWith("_error")) {
        if (pending.errorMessage !== notif.message) {
          markError(pending.id, notif.message);
        }
      }
    }
  }, [notifications, pendingJobs, markSuccess, markError, removePending, qc]);
}
