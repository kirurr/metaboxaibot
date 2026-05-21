import { useEffect, useMemo, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useForm, Controller, type SubmitHandler } from "react-hook-form";
import { Loader2, ArrowLeft } from "lucide-react";
import { Button } from "@/components/common/Button";
import { ModelSettingsPanel } from "@/components/admin/ModelSettingsPanel";
import { S3FileField } from "@/components/admin/S3FileField";
import { useAdminPromptModels } from "@/hooks/useAdminPromptModels";
import { useAdminPromptExample } from "@/hooks/useAdminPromptExample";
import { useCreatePromptExample, useUpdatePromptExample } from "@/hooks/useAdminPromptMutations";
import { useUIStore } from "@/stores/uiStore";
import type {
  PromptModelDto,
  CreatePromptExampleBody,
  UpdatePromptExampleBody,
} from "@metabox/shared-browser/dto";

type SectionValue = "design" | "video";

interface FormValues {
  section: SectionValue;
  modelId: string;
  prompt: string;
  mediaS3Key: string;
  thumbnailS3Key: string;
  modelSettings: Record<string, unknown>;
}

const DEFAULT_VALUES: FormValues = {
  section: "design",
  modelId: "",
  prompt: "",
  mediaS3Key: "",
  thumbnailS3Key: "",
  modelSettings: {},
};

function getDefaultSettings(model: PromptModelDto | undefined): Record<string, unknown> {
  if (!model?.settings) return {};
  const defaults: Record<string, unknown> = {};
  for (const def of model.settings) {
    defaults[def.key] = def.default ?? null;
  }
  return defaults;
}

function emptyToUndef(v: string): string | undefined {
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

function emptyToNull(v: string): string | null {
  const t = v.trim();
  return t.length > 0 ? t : null;
}

export default function AdminPromptEditor() {
  const { id } = useParams<{ id: string }>();
  const isEdit = !!id;
  const navigate = useNavigate();
  const pushToast = useUIStore((s) => s.pushToast);

  const modelsQuery = useAdminPromptModels();
  const promptQuery = useAdminPromptExample(id);
  const createMutation = useCreatePromptExample();
  const updateMutation = useUpdatePromptExample(id ?? "");

  const form = useForm<FormValues>({ defaultValues: DEFAULT_VALUES });
  const { register, handleSubmit, control, watch, setValue, reset, formState } = form;

  const section = watch("section");
  const modelId = watch("modelId");
  const settingsValues = watch("modelSettings");

  const models: PromptModelDto[] = modelsQuery.data?.models ?? [];
  const sectionModels = useMemo(
    () => models.filter((m) => m.section === section),
    [models, section],
  );
  const selectedModel = useMemo(() => models.find((m) => m.id === modelId), [models, modelId]);

  // Edit-mode: первичный reset формы по загруженным данным. Делаем ровно один
  // раз на каждый id — иначе любой повторный fetch (manual invalidate и т.п.)
  // снесёт несохранённые правки пользователя.
  const resetForIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isEdit || !id || !promptQuery.data) return;
    if (resetForIdRef.current === id) return;
    resetForIdRef.current = id;
    const p = promptQuery.data;
    const sectionVal: SectionValue =
      p.section === "video" || p.section === "design" ? p.section : "design";
    reset({
      section: sectionVal,
      modelId: p.model?.id ?? "",
      prompt: p.prompt,
      mediaS3Key: p.mediaS3Key ?? "",
      thumbnailS3Key: p.thumbnailS3Key ?? "",
      modelSettings: (p.modelSettings as Record<string, unknown> | null) ?? {},
    });
  }, [isEdit, id, promptQuery.data, reset]);

  const handleSectionChange = (next: SectionValue) => {
    if (next === section) return;
    setValue("section", next);
    // НЕ сбрасываем modelId/modelSettings — пользователь мог временно переключить
    // секцию и вернуться обратно. Если текущая модель не принадлежит новой
    // секции, dropdown отфильтрует её, но значение в форме сохранится; при
    // возврате в исходную секцию модель снова появится. Реальный сброс настроек
    // происходит только в handleModelChange — когда пользователь явно выбирает
    // другую модель.
  };

  const handleModelChange = (nextModelId: string) => {
    setValue("modelId", nextModelId);
    const nextModel = models.find((m) => m.id === nextModelId);
    setValue("modelSettings", getDefaultSettings(nextModel));
  };

  const handleSettingChange = (key: string, value: unknown) => {
    setValue("modelSettings", { ...(settingsValues ?? {}), [key]: value });
  };

  const onSubmit: SubmitHandler<FormValues> = async (values) => {
    // Реальная секция = секция выбранной модели. Защита от рассинхрона: если
    // юзер открыл edit, переключил таб секции и нажал Сохранить, не выбрав
    // модель для новой секции — сохраняем секцию исходной модели, чтобы не
    // получить запись с section="video" и моделью из design (или наоборот).
    const effectiveSection =
      selectedModel?.section === "design" || selectedModel?.section === "video"
        ? (selectedModel.section as SectionValue)
        : values.section;
    try {
      if (isEdit && id) {
        const body: UpdatePromptExampleBody = {
          modelId: values.modelId,
          prompt: values.prompt,
          section: effectiveSection,
          modelSettings: values.modelSettings,
          mediaS3Key: emptyToNull(values.mediaS3Key),
          thumbnailS3Key: emptyToNull(values.thumbnailS3Key),
        };
        await updateMutation.mutateAsync(body);
        pushToast({ type: "success", message: "Промпт обновлён" });
      } else {
        const body: CreatePromptExampleBody = {
          modelId: values.modelId,
          prompt: values.prompt,
          section: effectiveSection,
          modelSettings: values.modelSettings,
          mediaS3Key: emptyToUndef(values.mediaS3Key),
          thumbnailS3Key: emptyToUndef(values.thumbnailS3Key),
        };
        await createMutation.mutateAsync(body);
        pushToast({ type: "success", message: "Промпт создан" });
      }
      navigate("/admin/prompts");
    } catch (e) {
      pushToast({ type: "error", message: (e as Error).message });
    }
  };

  const initialLoading = isEdit && promptQuery.isLoading;
  const modelsLoading = modelsQuery.isLoading;
  const saving = createMutation.isPending || updateMutation.isPending;

  if (initialLoading || modelsLoading) {
    return (
      <div className="p-6">
        <div className="text-text-secondary">
          <Loader2 className="inline animate-spin" /> Загрузка
        </div>
      </div>
    );
  }

  if (isEdit && promptQuery.error) {
    return (
      <div className="p-6">
        <div className="text-danger">{(promptQuery.error as Error).message}</div>
        <Button variant="ghost" leftIcon={<ArrowLeft size={16} />} onClick={() => navigate(-1)}>
          Назад
        </Button>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-3xl">
      <div className="flex items-center gap-2 mb-4">
        <button
          type="button"
          onClick={() => navigate("/admin/prompts")}
          className="p-1.5 rounded hover:bg-bg-elevated text-text-secondary"
          title="Назад"
        >
          <ArrowLeft size={18} />
        </button>
        <h1 className="font-heading text-xl">
          {isEdit ? "Редактирование промпта" : "Новый промпт"}
        </h1>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-6">
        <div className="card p-5 flex flex-col gap-5">
          {/* Section */}
          <div className="flex flex-col gap-2">
            <label className="text-xs font-medium text-text-secondary">Секция</label>
            <div className="flex items-center gap-2">
              {(["design", "video"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => handleSectionChange(s)}
                  className={
                    section === s
                      ? "px-3 py-1.5 rounded text-sm bg-accent text-white"
                      : "px-3 py-1.5 rounded text-sm bg-bg-elevated text-text-secondary hover:text-text"
                  }
                >
                  {s === "design" ? "Design" : "Video"}
                </button>
              ))}
            </div>
          </div>

          {/* Model */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-text-secondary">Модель</label>
            <Controller
              control={control}
              name="modelId"
              rules={{ required: "Выберите модель" }}
              render={({ field, fieldState }) => {
                // Если выбранная модель не принадлежит активной секции, показываем
                // dropdown пустым — но НЕ трогаем form state. При возврате в исходную
                // секцию значение само "проявится" в списке.
                const displayValue = sectionModels.some((m) => m.id === field.value)
                  ? field.value
                  : "";
                return (
                  <>
                    <select
                      className="input"
                      value={displayValue}
                      onChange={(e) => handleModelChange(e.target.value)}
                    >
                      <option value="">— выберите —</option>
                      {sectionModels.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name} ({m.provider})
                        </option>
                      ))}
                    </select>
                    {fieldState.error && (
                      <div className="text-xs text-danger">{fieldState.error.message}</div>
                    )}
                  </>
                );
              }}
            />
          </div>

          {/* Prompt */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-text-secondary">Промпт</label>
            <textarea
              {...register("prompt", { required: "Введите промпт" })}
              className="input min-h-[120px] py-2"
              placeholder="Текст промпта…"
            />
            {formState.errors.prompt && (
              <div className="text-xs text-danger">{formState.errors.prompt.message}</div>
            )}
          </div>

          {/* Thumbnail */}
          <Controller
            control={control}
            name="thumbnailS3Key"
            render={({ field }) => (
              <S3FileField
                label="Превью (опционально)"
                kind="thumbnail"
                section={section}
                value={field.value}
                currentPreviewUrl={promptQuery.data?.thumbnailUrl ?? null}
                onChange={field.onChange}
                disabled={saving}
              />
            )}
          />

          {/* Media */}
          <Controller
            control={control}
            name="mediaS3Key"
            render={({ field }) => (
              <S3FileField
                label="Медиа (опционально)"
                kind="media"
                section={section}
                value={field.value}
                currentPreviewUrl={promptQuery.data?.mediaUrl ?? null}
                onChange={field.onChange}
                disabled={saving}
              />
            )}
          />
        </div>

        {/* Settings */}
        <div className="card p-5">
          <h2 className="text-sm font-semibold text-text mb-3">Настройки модели</h2>
          {!selectedModel || selectedModel.section !== section ? (
            <div className="text-sm text-text-hint italic">
              Сначала выберите модель — её настройки появятся здесь.
            </div>
          ) : (
            <ModelSettingsPanel
              settings={selectedModel.settings ?? []}
              values={settingsValues ?? {}}
              onChange={handleSettingChange}
            />
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button type="submit" loading={saving}>
            {isEdit ? "Сохранить" : "Создать"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => navigate("/admin/prompts")}
            disabled={saving}
          >
            Отмена
          </Button>
        </div>
      </form>
    </div>
  );
}
