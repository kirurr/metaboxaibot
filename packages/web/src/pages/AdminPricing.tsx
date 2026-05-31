import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Save, RotateCcw } from "lucide-react";
import { adminApi, type ModelPricingDto, type PricingSnapshotDto } from "@/api/admin";
import { Button } from "@/components/common/Button";
import { Input } from "@/components/common/Input";
import { useUIStore } from "@/stores/uiStore";

/** Local per-row edit state (input — string чтобы пользователь мог печатать "0." или "1.2") */
interface RowEdit {
  multiplier?: string;
  note?: string;
}

const SECTION_ORDER = ["gpt", "design", "image", "video", "audio"] as const;
const SECTION_LABEL: Record<string, string> = {
  gpt: "Чат / LLM",
  design: "Дизайн",
  image: "Изображения",
  video: "Видео",
  audio: "Аудио",
};

function parseMultiplier(input: string | undefined, fallback: number): number | null {
  if (input === undefined || input === "") return fallback;
  const v = Number(input);
  if (!Number.isFinite(v)) return null;
  if (v <= 0 || v > 10) return null;
  return v;
}

function formatTokens(n: number): string {
  return n.toLocaleString("ru-RU", { maximumFractionDigits: 2 });
}

export default function AdminPricing() {
  const { t } = useTranslation();
  const pushToast = useUIStore((s) => s.pushToast);
  const [data, setData] = useState<PricingSnapshotDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);

  // Per-row local edits, ключ = modelId.
  const [edits, setEdits] = useState<Record<string, RowEdit>>({});

  // Global section local state.
  const [globalInput, setGlobalInput] = useState("");
  const [globalNote, setGlobalNote] = useState("");
  const [savingGlobal, setSavingGlobal] = useState(false);

  const reload = async () => {
    setLoading(true);
    try {
      const snapshot = await adminApi.pricing.getAll();
      setData(snapshot);
      setGlobalInput(snapshot.global ? String(snapshot.global.multiplier) : "");
      setGlobalNote(snapshot.global?.note ?? "");
      setEdits({});
    } catch (err) {
      pushToast({ type: "error", message: (err as Error).message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
  }, []);

  const grouped = useMemo(() => {
    if (!data) return new Map<string, ModelPricingDto[]>();
    const map = new Map<string, ModelPricingDto[]>();
    for (const m of data.models) {
      const arr = map.get(m.section) ?? [];
      arr.push(m);
      map.set(m.section, arr);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => a.name.localeCompare(b.name, "ru"));
    }
    return map;
  }, [data]);

  const orderedSections = useMemo(() => {
    if (!data) return [] as string[];
    const known = SECTION_ORDER.filter((s) => grouped.has(s));
    const extra = [...grouped.keys()].filter((s) => !known.includes(s as never));
    return [...known, ...extra];
  }, [data, grouped]);

  // ── Global save / clear ────────────────────────────────────────────────────
  const saveGlobal = async () => {
    const value = parseMultiplier(globalInput, NaN);
    if (value === null || Number.isNaN(value)) {
      pushToast({ type: "error", message: t("admin.multiplierRange") });
      return;
    }
    setSavingGlobal(true);
    try {
      await adminApi.pricing.setGlobal({
        multiplier: value,
        note: globalNote.trim() || null,
      });
      pushToast({ type: "success", message: t("admin.marginSaved") });
      await reload();
    } catch (err) {
      pushToast({ type: "error", message: (err as Error).message });
    } finally {
      setSavingGlobal(false);
    }
  };

  const clearGlobal = async () => {
    if (!confirm("Сбросить override и вернуться к значению из конфига?")) return;
    setSavingGlobal(true);
    try {
      await adminApi.pricing.deleteGlobal();
      pushToast({ type: "success", message: t("admin.overrideCleared") });
      await reload();
    } catch (err) {
      pushToast({ type: "error", message: (err as Error).message });
    } finally {
      setSavingGlobal(false);
    }
  };

  // ── Per-model save / clear ─────────────────────────────────────────────────
  const saveModel = async (m: ModelPricingDto) => {
    const edit = edits[m.id] ?? {};
    const nextMultiplier = parseMultiplier(edit.multiplier, m.multiplier);
    if (nextMultiplier === null) {
      pushToast({ type: "error", message: t("admin.multiplierRange") });
      return;
    }
    setSavingId(m.id);
    try {
      await adminApi.pricing.setModel(m.id, {
        multiplier: nextMultiplier,
        note: (edit.note ?? m.note ?? "").trim() || null,
      });
      pushToast({ type: "success", message: t("admin.modelSaved", { name: m.name }) });
      await reload();
    } catch (err) {
      pushToast({ type: "error", message: (err as Error).message });
    } finally {
      setSavingId(null);
    }
  };

  const clearModel = async (m: ModelPricingDto) => {
    if (!confirm(`Сбросить множитель для «${m.name}»?`)) return;
    setSavingId(m.id);
    try {
      await adminApi.pricing.deleteModel(m.id);
      pushToast({ type: "success", message: t("admin.modelCleared", { name: m.name }) });
      await reload();
    } catch (err) {
      pushToast({ type: "error", message: (err as Error).message });
    } finally {
      setSavingId(null);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  if (loading || !data) {
    return (
      <div className="p-8 text-center text-text-secondary">
        <Loader2 className="inline animate-spin" /> Загрузка
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 max-w-6xl">
      <div className="mb-4">
        <h1 className="text-2xl font-bold">Цены моделей</h1>
        <p className="text-text-secondary text-sm mt-1">
          Множители применяются ко ВСЕМ точкам расчёта цены: каталог, pre-flight checkBalance,
          финальный billing. Юзер платит ровно столько, сколько ему показали.
        </p>
      </div>

      {/* ── Global targetMargin override ──────────────────────────────────── */}
      <div className="card p-4 mb-6">
        <h2 className="text-lg font-semibold mb-2">Глобальная маржа (targetMargin)</h2>
        <p className="text-text-secondary text-sm mb-3">
          Перекрывает <code>config.billing.targetMargin</code> для всех моделей. Применяется поверх
          per-model множителей (значения перемножаются). Default из конфига:{" "}
          <strong>{data.configDefault}</strong>.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Input
            label="Override"
            type="number"
            step="0.01"
            value={globalInput}
            placeholder={`default: ${data.configDefault}`}
            onChange={(e) => setGlobalInput(e.target.value)}
          />
          <div className="md:col-span-2">
            <Input
              label="Комментарий (опционально)"
              value={globalNote}
              onChange={(e) => setGlobalNote(e.target.value)}
            />
          </div>
        </div>
        <div className="flex items-center gap-2 mt-4">
          <Button onClick={saveGlobal} loading={savingGlobal} leftIcon={<Save size={16} />}>
            Сохранить
          </Button>
          {data.global && (
            <Button
              variant="ghost"
              onClick={clearGlobal}
              disabled={savingGlobal}
              leftIcon={<RotateCcw size={16} />}
            >
              Сбросить
            </Button>
          )}
          {data.global && (
            <span className="text-xs text-text-hint ml-auto">
              {data.global.updatedBy ?? "—"} ·{" "}
              {new Date(data.global.updatedAt).toLocaleString("ru-RU")}
            </span>
          )}
        </div>
      </div>

      {/* ── Per-model table ───────────────────────────────────────────────── */}
      {orderedSections.map((section) => {
        const rows = grouped.get(section) ?? [];
        return (
          <div key={section} className="card overflow-hidden mb-4">
            <div className="px-4 py-2 bg-bg-elev-2 text-sm font-medium">
              {SECTION_LABEL[section] ?? section}
              <span className="text-text-hint ml-2">({rows.length})</span>
            </div>
            <table className="w-full text-sm">
              <thead className="bg-bg-elev text-text-secondary">
                <tr>
                  <th className="text-left px-3 py-2">Модель</th>
                  <th className="text-left px-3 py-2">Provider</th>
                  <th className="text-right px-3 py-2">База (✦)</th>
                  <th className="text-left px-3 py-2 w-28">Множитель</th>
                  <th className="text-right px-3 py-2">Итого (✦)</th>
                  <th className="text-left px-3 py-2">Комментарий</th>
                  <th className="text-right px-3 py-2 w-32"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => {
                  const edit = edits[m.id] ?? {};
                  const inputValue = edit.multiplier ?? String(m.multiplier);
                  const parsed = parseMultiplier(edit.multiplier, m.multiplier);
                  // Превью: текущая база (база сервера учитывает действующую маржу)
                  // × введённый множитель.
                  const preview = parsed === null ? null : Math.ceil(m.baseTokens * parsed);
                  const noteValue = edit.note ?? m.note ?? "";
                  const overridden = m.multiplier !== 1;
                  const dirty =
                    (edit.multiplier !== undefined && edit.multiplier !== String(m.multiplier)) ||
                    (edit.note !== undefined && edit.note !== (m.note ?? ""));
                  return (
                    <tr key={m.id} className="border-t border-border-default">
                      <td className="px-3 py-2">
                        <div className="font-medium">{m.name}</div>
                        <div className="text-xs text-text-hint">{m.id}</div>
                      </td>
                      <td className="px-3 py-2 text-text-hint">{m.provider}</td>
                      <td className="px-3 py-2 text-right font-mono">
                        {formatTokens(m.baseTokens)}
                      </td>
                      <td className="px-3 py-2">
                        <input
                          className="w-24 h-9 px-2 rounded border border-border-default bg-bg text-sm"
                          type="number"
                          step="0.01"
                          value={inputValue}
                          onChange={(e) =>
                            setEdits((prev) => ({
                              ...prev,
                              [m.id]: { ...prev[m.id], multiplier: e.target.value },
                            }))
                          }
                        />
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {preview === null ? (
                          <span className="text-danger">—</span>
                        ) : (
                          <>
                            {formatTokens(preview)}
                            {parsed !== null && parsed !== m.multiplier && (
                              <span className="text-xs text-text-hint ml-1">
                                ({m.multiplier}→{parsed})
                              </span>
                            )}
                          </>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <input
                          className="w-full h-9 px-2 rounded border border-border-default bg-bg text-sm"
                          type="text"
                          value={noteValue}
                          placeholder={overridden ? "" : "напр. -15% по акции"}
                          onChange={(e) =>
                            setEdits((prev) => ({
                              ...prev,
                              [m.id]: { ...prev[m.id], note: e.target.value },
                            }))
                          }
                        />
                        {m.updatedBy && (
                          <div className="text-xs text-text-hint mt-1">
                            {m.updatedBy} ·{" "}
                            {m.updatedAt ? new Date(m.updatedAt).toLocaleString("ru-RU") : ""}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => saveModel(m)}
                            disabled={savingId === m.id || !dirty}
                            title="Сохранить"
                            className="p-1.5 hover:bg-bg-elev-2 rounded disabled:opacity-30"
                          >
                            {savingId === m.id ? (
                              <Loader2 size={14} className="animate-spin" />
                            ) : (
                              <Save size={14} />
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => clearModel(m)}
                            disabled={savingId === m.id || !overridden}
                            title="Сбросить (multiplier = 1.0)"
                            className="p-1.5 hover:bg-bg-elev-2 rounded text-danger disabled:opacity-30"
                          >
                            <RotateCcw size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}
