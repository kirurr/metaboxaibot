import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Plus, Edit2, Trash2, Loader2, Image as ImageIcon } from "lucide-react";
import { Button } from "@/components/common/Button";
import { useListPromptExamples } from "@/hooks/useListPromptExamples";
import { useDeletePromptExample } from "@/hooks/useAdminPromptMutations";
import { useUIStore } from "@/stores/uiStore";

type SectionFilter = "" | "design" | "video";

const SECTIONS: { value: SectionFilter; label: string }[] = [
  { value: "", label: "Все" },
  { value: "design", label: "Design" },
  { value: "video", label: "Video" },
];

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("ru-RU", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export default function AdminPromptsList() {
  const navigate = useNavigate();
  const pushToast = useUIStore((s) => s.pushToast);
  const [section, setSection] = useState<SectionFilter>("");
  const { prompts, isLoading, isFetchingNextPage, hasNextPage, fetchNextPage, error } =
    useListPromptExamples(section || undefined);
  const deleteMutation = useDeletePromptExample();

  const handleDelete = (id: string, prompt: string) => {
    const preview = truncate(prompt, 60);
    if (!window.confirm(`Удалить промпт?\n\n«${preview}»`)) return;
    deleteMutation.mutate(id, {
      onSuccess: () => pushToast({ type: "success", message: "Промпт удалён" }),
      onError: (e) => pushToast({ type: "error", message: (e as Error).message }),
    });
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="font-heading text-xl mb-1">Промпты</h1>
          <p className="text-sm text-text-hint">Примеры промптов для секций Design и Video.</p>
        </div>
        <Button leftIcon={<Plus size={16} />} onClick={() => navigate("/admin/prompts/new")}>
          Создать
        </Button>
      </div>

      <div className="flex items-center gap-2 mb-4">
        {SECTIONS.map((s) => (
          <button
            key={s.value}
            type="button"
            onClick={() => setSection(s.value)}
            className={
              s.value === section
                ? "px-3 py-1.5 rounded text-sm bg-accent text-white"
                : "px-3 py-1.5 rounded text-sm bg-bg-elevated text-text-secondary hover:text-text"
            }
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="card overflow-hidden">
        {error ? (
          <div className="p-8 text-center text-danger">{(error as Error).message}</div>
        ) : isLoading ? (
          <div className="p-8 text-center text-text-secondary">
            <Loader2 className="inline animate-spin" /> Загрузка
          </div>
        ) : prompts.length === 0 ? (
          <div className="p-8 text-center text-text-secondary">Нет промптов</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-bg-elevated text-text-secondary">
              <tr>
                <th className="text-left px-3 py-2 w-16">Превью</th>
                <th className="text-left px-3 py-2">Промпт</th>
                <th className="text-left px-3 py-2">Модель</th>
                <th className="text-left px-3 py-2">Секция</th>
                <th className="text-left px-3 py-2">Создан</th>
                <th className="text-right px-3 py-2">Действия</th>
              </tr>
            </thead>
            <tbody>
              {prompts.map((p) => (
                <tr key={p.id} className="border-t border-border">
                  <td className="px-3 py-2">
                    {p.thumbnailUrl ? (
                      <img src={p.thumbnailUrl} alt="" className="w-12 h-12 rounded object-cover" />
                    ) : (
                      <div className="w-12 h-12 rounded bg-bg-elevated flex items-center justify-center text-text-hint">
                        <ImageIcon size={16} />
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 max-w-xl">
                    <div className="text-text">{truncate(p.prompt, 120)}</div>
                  </td>
                  <td className="px-3 py-2 text-text-secondary">{p.model?.name ?? "—"}</td>
                  <td className="px-3 py-2 text-text-secondary">{p.section}</td>
                  <td className="px-3 py-2 text-text-hint">{formatDate(p.createdAt)}</td>
                  <td className="px-3 py-2 text-right">
                    <div className="inline-flex items-center gap-1">
                      <Link
                        to={`/admin/prompts/${encodeURIComponent(p.id)}/edit`}
                        title="Редактировать"
                        className="p-1.5 hover:bg-bg-elevated rounded inline-flex"
                      >
                        <Edit2 size={14} />
                      </Link>
                      <button
                        type="button"
                        onClick={() => handleDelete(p.id, p.prompt)}
                        title="Удалить"
                        className="p-1.5 hover:bg-bg-elevated rounded text-danger"
                        disabled={deleteMutation.isPending}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {hasNextPage && (
        <div className="flex justify-center mt-4">
          <Button variant="ghost" loading={isFetchingNextPage} onClick={() => fetchNextPage()}>
            Загрузить ещё
          </Button>
        </div>
      )}
    </div>
  );
}
