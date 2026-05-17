import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api/client.js";
import { useI18n } from "../../i18n.js";
import { MODEL_TRANSLATIONS } from "@metabox/shared-browser";
import type { Model, UserState } from "../../types.js";
import { StyledSelect } from "./StyledSelect.js";
import { FamilyCard } from "./FamilyCard.js";
import { StandaloneCard } from "./StandaloneCard.js";
import {
  getPickerIdForModel,
  buildPickerOptions,
  autoCorrectForCostMatrix,
  groupByFamily,
  isActiveSection,
} from "../../utils/mediaSettingsViewHelpers.js";
import { closeMiniApp } from "../../utils/telegram.js";

// ── MediaSettingsView ─────────────────────────────────────────────────────────

export type MediaSection = "design" | "video" | "audio";

const SECTION_ACTIVE_KEY: Record<MediaSection, keyof UserState> = {
  design: "designModelId",
  video: "videoModelId",
  audio: "audioModelId",
};

const SECTION_TITLE_KEY: Record<MediaSection, Parameters<ReturnType<typeof useI18n>["t"]>[0]> = {
  design: "imageSettings.title",
  video: "videoSettings.title",
  audio: "audioSettings.title",
};

const SECTION_SUBTITLE_KEY: Record<MediaSection, Parameters<ReturnType<typeof useI18n>["t"]>[0]> = {
  design: "imageSettings.subtitle",
  video: "videoSettings.subtitle",
  audio: "audioSettings.subtitle",
};

export function MediaSettingsView({
  section,
  initialModelId,
}: {
  section: MediaSection;
  initialModelId?: string;
}) {
  const { t, locale } = useI18n();
  const modelLocaleMap = MODEL_TRANSLATIONS[locale] ?? MODEL_TRANSLATIONS["en"] ?? {};
  const [models, setModels] = useState<Model[]>([]);
  const [allModelSettings, setAllModelSettings] = useState<Record<string, Record<string, unknown>>>(
    {},
  );
  const [activeModelId, setActiveModelId] = useState<string>("");
  const [stateStr, setState] = useState<string | undefined>();
  const [selectedPickerId, setSelectedPickerId] = useState<string>("");
  const [savedId, setSavedId] = useState<string | null>(null);
  const [selectedModes, setSelectedModes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [activatedPopup, setActivatedPopup] = useState(false);
  const debounceRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // Pending changes per model — batched and flushed as a single PATCH
  const pendingChangesRef = useRef<Record<string, Record<string, unknown>>>({});
  // Цепочка in-flight selectModel вызовов. Activate await'ит её перед своим
  // собственным /state/activate — иначе late-arriving selectModel мог бы
  // переписать DB после activate (last-write-wins на сервере) и бот пошёл
  // бы по неактуальной модели. Цепь технически растёт на каждый тап, но
  // GC коллапсирует её как только финальный promise resolved'ится — после
  // того как юзер прекращает тапать, ссылка на тейл рушится естественно.
  const selectChainRef = useRef<Promise<unknown>>(Promise.resolve());
  // Маркер «юзер тыкнул вариант с момента открытия мини-аппы» — кнопка
  // «Активировать» остаётся кликабельной даже когда `isGloballyActive=true`,
  // иначе после тапа по чипу в активной секции теряется аффорданс «применить
  // и закрыть» (кнопка disabled'ится с надписью «Активирована»). Сбрасывается
  // только при full activate. Server-side trailing debounce сам решает,
  // отправлять ли финальное Telegram-уведомление, поэтому клиенту хранить
  // pending-таймер больше не нужно.
  const [hasPendingSelect, setHasPendingSelect] = useState(false);

  useEffect(() => {
    Promise.all([api.models.list(section), api.state.get(), api.modelSettings.get()])
      .then(([ms, state, ms2]) => {
        setModels(ms);
        setAllModelSettings(ms2);
        setSelectedModes(state.selectedModes ?? {});
        const fromSection = (state[SECTION_ACTIVE_KEY[section]] as string | null) ?? undefined;
        // activeModelId always reflects the real bot state
        const activeId = fromSection && ms.some((m) => m.id === fromSection) ? fromSection : "";
        setActiveModelId(activeId);
        setState(state.state);
        // initialModelId only controls which card is shown in the picker (navigation only)
        const navTarget =
          initialModelId && ms.some((m) => m.id === initialModelId) ? initialModelId : activeId;
        setSelectedPickerId(
          navTarget
            ? getPickerIdForModel(navTarget, ms)
            : (buildPickerOptions(ms, modelLocaleMap)[0]?.id ?? ""),
        );
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [section]);

  // hasPendingSelect — флаг «юзер тыкнул вариант» — относится к конкретной
  // family-карточке. При переключении picker'а (юзер ушёл в другое семейство
  // моделей) пометка не должна тащиться следом, иначе activate-кнопка
  // активной модели В НОВОМ семействе ошибочно покажет «Активировать» вместо
  // «Активирована». Сбрасываем при смене selectedPickerId.
  useEffect(() => {
    setHasPendingSelect(false);
  }, [selectedPickerId]);

  const SECTION_ACTIVE_STATE: Record<MediaSection, string> = {
    design: "DESIGN_ACTIVE",
    video: "VIDEO_ACTIVE",
    audio: "AUDIO_ACTIVE",
  };

  const handleModelActivate = async (modelId: string) => {
    setHasPendingSelect(false);
    setActiveModelId(modelId);
    setState(SECTION_ACTIVE_STATE[section]);
    // Дождаться очереди silent-select'ов прежде чем отправить activate —
    // иначе late selectModel(A) может прилететь после activate(B) и
    // переписать DB на A (бот тогда пойдёт по A, юзер ждал B). Сервер,
    // получив activate, сам гасит pending trailing-debounce этого юзера
    // (cancelPendingNotify), так что дублёра уведомления не будет.
    await selectChainRef.current.catch(() => void 0);
    try {
      await api.state.activate(section, modelId);
    } catch (e) {
      console.error("[settings] activate failed", modelId, e);
      return;
    }
    setActivatedPopup(true);
    setTimeout(() => setActivatedPopup(false), 3000);
    closeMiniApp();
  };

  /**
   * Silent select при клике по версии/варианту в карусели карточки —
   * сохраняет выбор в БД (designModelId / videoModelId / audioModelId), но
   * НЕ переводит state бота в *_ACTIVE и НЕ закрывает мини-аппу. Бот при
   * следующем запросе уже использует выбранную модель. Кнопка
   * «Активировать» по-прежнему делает full activation.
   *
   * Telegram-уведомление полностью на сервере: server-side trailing-debounce
   * в /state/select-model сбрасывается на каждый тап, после 5с тишины шлёт
   * один пинг про финальную модель (с dedup'ом если юзер вернулся к
   * исходной). Клиенту не нужны debounce-таймеры или pagehide-листенеры —
   * X-close в Telegram WebView больше не теряет уведомление.
   *
   * `keepalive: true` на самом запросе (см. api.state.selectModel) гарантирует
   * что фетч переживёт закрытие WebView, даже если юзер тапнул и сразу X.
   */
  const handleModelSelect = (modelId: string) => {
    if (modelId === activeModelId) return;

    setActiveModelId(modelId);
    setHasPendingSelect(true);
    selectChainRef.current = selectChainRef.current.then(() =>
      api.state.selectModel(section, modelId).catch((e) => {
        console.error("[settings] select-model failed", modelId, e);
      }),
    );
  };

  const handleSettingChange = (modelId: string, key: string, value: unknown) => {
    const model = models.find((m) => m.id === modelId);
    // Use the latest accumulated pending changes as "current" so corrections
    // see the most recent values even before a re-render occurs.
    const current = {
      ...(allModelSettings[modelId] ?? {}),
      ...(pendingChangesRef.current[modelId] ?? {}),
    };
    const corrections = model ? autoCorrectForCostMatrix(model, key, value, current) : null;
    const allChanges: Record<string, unknown> = { [key]: value, ...(corrections ?? {}) };

    setAllModelSettings((prev) => ({
      ...prev,
      [modelId]: { ...(prev[modelId] ?? {}), ...allChanges },
    }));
    setSavedId(modelId);
    setTimeout(() => setSavedId((id) => (id === modelId ? null : id)), 1500);

    // Accumulate all changes for this model, then flush as a single PATCH after 800ms
    pendingChangesRef.current[modelId] = {
      ...(pendingChangesRef.current[modelId] ?? {}),
      ...allChanges,
    };
    console.log("[settings] change queued", modelId, pendingChangesRef.current[modelId]);
    clearTimeout(debounceRef.current[modelId]);
    debounceRef.current[modelId] = setTimeout(() => {
      const batch = pendingChangesRef.current[modelId];
      console.log("[settings] debounce fired", modelId, batch);
      if (!batch) return;
      delete pendingChangesRef.current[modelId];
      void api.modelSettings
        .set(modelId, batch)
        .then(() => {
          console.log("[settings] PATCH success", modelId, batch);
        })
        .catch((e) => {
          console.error("[settings] PATCH error", modelId, e);
        });
    }, 800);
  };

  const handleModeChange = (modelId: string, modeId: string) => {
    setSelectedModes((prev) => ({ ...prev, [modelId]: modeId }));
    api.state
      .setSelectedMode(modelId, modeId)
      .catch((e) => console.error("[settings] setSelectedMode failed", modelId, modeId, e));
    // Changing the mode invalidates the current "active" state — the bot needs
    // to be re-activated so it asks for the new mode. Drop active state locally
    // so the Activate button reappears for this model.
    if (modelId === activeModelId) {
      setActiveModelId("");
      setState(undefined);
    }
  };

  const handleReset = (modelId: string) => {
    const model = models.find((m) => m.id === modelId);
    if (!model) return;
    const defaults: Record<string, unknown> = {};
    for (const def of model.settings) {
      defaults[def.key] = def.default ?? null;
    }
    setAllModelSettings((prev) => ({ ...prev, [modelId]: defaults }));
    api.modelSettings
      .set(modelId, defaults)
      .catch((e) => console.error("[settings] reset failed", modelId, e));
  };

  const { families, standalone } = useMemo(() => groupByFamily(models), [models]);
  const pickerOptions = useMemo(
    () => buildPickerOptions(models, modelLocaleMap),
    [models, modelLocaleMap],
  );

  const [pickerType, pickerId] = selectedPickerId.split("__");
  const familyMembers = useMemo(
    () => (pickerType === "family" ? (families.get(pickerId) ?? []) : null),
    [pickerType, pickerId, families],
  );
  const standaloneModel = useMemo(
    () => (pickerType === "standalone" ? standalone.find((m) => m.id === pickerId) : null),
    [pickerType, pickerId, standalone],
  );

  if (loading) return <div className="page-loading">{t("common.loading")}</div>;

  return (
    <div className="page">
      {activatedPopup && <div className="activated-popup">{t("imageSettings.activatedPopup")}</div>}
      <div className="page-header">
        <h2>{t(SECTION_TITLE_KEY[section])}</h2>
        <p className="page-subtitle">{t(SECTION_SUBTITLE_KEY[section])}</p>
      </div>

      {pickerOptions.length > 1 && (
        <StyledSelect
          value={selectedPickerId}
          onChange={setSelectedPickerId}
          options={pickerOptions.map((opt) => ({ value: opt.id, label: opt.label }))}
        />
      )}

      {familyMembers && (
        <FamilyCard
          key={pickerId}
          members={familyMembers}
          activeModelId={activeModelId}
          activeState={stateStr}
          savedId={savedId}
          allModelSettings={allModelSettings}
          selectedModes={selectedModes}
          onModelActivate={handleModelActivate}
          onModelSelect={handleModelSelect}
          hasPendingSelect={hasPendingSelect}
          onSettingChange={(modelId, key, val) => handleSettingChange(modelId, key, val)}
          onModeChange={handleModeChange}
          onReset={handleReset}
        />
      )}

      {standaloneModel && (
        <StandaloneCard
          model={standaloneModel}
          isActive={
            activeModelId === standaloneModel.id &&
            isActiveSection(standaloneModel.section, stateStr)
          }
          activeState={stateStr}
          savedId={savedId}
          allModelSettings={allModelSettings}
          selectedModeId={selectedModes[standaloneModel.id]}
          onActivate={handleModelActivate}
          onSettingChange={(key, val) => handleSettingChange(standaloneModel.id, key, val)}
          onModeChange={(modeId) => handleModeChange(standaloneModel.id, modeId)}
          onReset={handleReset}
        />
      )}
    </div>
  );
}
