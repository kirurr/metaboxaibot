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

// Длина окна ожидания «юзер закончил тыкать варианты» перед тем как дёрнуть
// Telegram-нотификацию. 5с — компромисс: достаточно для серии быстрых
// tap'ов (1с между нажатиями типично), но не настолько большой чтобы юзер
// успел закрыть мини-аппу через крестик и не получить ping.
const SELECT_NOTIFY_DEBOUNCE_MS = 5000;

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
  // Debounce-таймер для notification после silent select (см. handleModelSelect).
  // Один на всю карточку — если юзер быстро прыгает между версиями, нам нужно
  // только последнее уведомление, на финальный выбор.
  const selectNotifyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Последний modelId, выбранный через handleModelSelect и ещё не
  // подтверждённый нотификацией. Нужен для pagehide / unmount path: если
  // юзер закроет мини-аппу до debounce-fire, мы успеем дослать notification.
  // null когда нет pending'а (после fire или после full activate).
  const lastSelectedRef = useRef<string | null>(null);
  // Цепочка in-flight selectModel вызовов. Activate await'ит её перед своим
  // собственным /state/activate — иначе late-arriving selectModel мог бы
  // переписать DB после activate (last-write-wins на сервере) и бот пошёл
  // бы по неактуальной модели. Цепь технически растёт на каждый тап, но
  // GC коллапсирует её как только финальный promise resolved'ится — после
  // того как юзер прекращает тапать, ссылка на тейл рушится естественно.
  const selectChainRef = useRef<Promise<unknown>>(Promise.resolve());
  // Маркер pending silent-select для UI: пока true, кнопка «Активировать»
  // остаётся кликабельной даже когда `isGloballyActive=true` — иначе после
  // тапа по чипу в активной секции юзер теряет аффорданс «применить и
  // закрыть» (кнопка disabled'ится с надписью «Активирована»).
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

  const SECTION_ACTIVE_STATE: Record<MediaSection, string> = {
    design: "DESIGN_ACTIVE",
    video: "VIDEO_ACTIVE",
    audio: "AUDIO_ACTIVE",
  };

  const handleModelActivate = async (modelId: string) => {
    // Full activate шлёт свою notification — гасим pending debounce от
    // прежних silent select'ов, иначе юзер получит два дубль-сообщения.
    if (selectNotifyTimerRef.current) {
      clearTimeout(selectNotifyTimerRef.current);
      selectNotifyTimerRef.current = null;
    }
    lastSelectedRef.current = null;
    setHasPendingSelect(false);
    setActiveModelId(modelId);
    setState(SECTION_ACTIVE_STATE[section]);
    // Дождаться очереди silent-select'ов прежде чем отправить activate —
    // иначе late selectModel(A) может прилететь после activate(B) и
    // переписать DB на A (бот тогда пойдёт по A, юзер ждал B).
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
   * Notification: schedule'им через 5с — даём юзеру допрыгать между
   * вариантами без N сообщений, но если он закроет мини-аппу через крестик,
   * через 5с всё равно прилетит подтверждение в чат и будет ясно что выбор
   * сохранён. Каждый новый select reset'ит таймер; full activate его гасит.
   */
  const handleModelSelect = (modelId: string) => {
    // No-op: тап по уже-активной модели не должен слать notification (юзер
    // получил бы «X активирована» для модели которая и так была активна).
    // Двойная проверка: `activeModelId` из closure может быть stale при
    // двойном tap'е в одном тике (React batching), а `lastSelectedRef` —
    // mutable, видит свежее значение из предыдущего вызова handleModelSelect.
    if (modelId === activeModelId || lastSelectedRef.current === modelId) return;

    setActiveModelId(modelId);
    lastSelectedRef.current = modelId;
    setHasPendingSelect(true);
    // Цепляем в `selectChainRef` — следующий activate будет ждать
    // завершения серии silent select'ов.
    selectChainRef.current = selectChainRef.current.then(() =>
      api.state.selectModel(section, modelId).catch((e) => {
        console.error("[settings] select-model failed", modelId, e);
      }),
    );
    if (selectNotifyTimerRef.current) {
      clearTimeout(selectNotifyTimerRef.current);
    }
    selectNotifyTimerRef.current = setTimeout(() => {
      selectNotifyTimerRef.current = null;
      lastSelectedRef.current = null;
      setHasPendingSelect(false);
      api.state.notifyModelChanged(section, modelId).catch((e) => {
        console.error("[settings] notify-model-changed failed", modelId, e);
      });
    }, SELECT_NOTIFY_DEBOUNCE_MS);
  };

  // Если юзер закрывает мини-аппу через крестик / переключает таб до того
  // как сработает 5-секундный debounce, его pending notification теряется и
  // он не понимает, сохранился ли выбор. Слушаем оба события:
  //  - `pagehide` — стандартное закрытие WebView, надёжно на Android.
  //  - `visibilitychange` (hidden) — fallback для iOS Telegram WebView, где
  //    `pagehide` может не сработать при swipe-close.
  // Дослaём через keepalive fetch (sendBeacon не несёт auth headers).
  // На unmount компонента (юзер свитчит секцию внутри мини-аппы): fire
  // pending немедленно через обычный fetch — компонент уже исчез, но
  // запрос успеет улететь.
  useEffect(() => {
    const fireIfPending = (beacon: boolean) => {
      const lastId = lastSelectedRef.current;
      const timer = selectNotifyTimerRef.current;
      if (!timer || !lastId) return;
      clearTimeout(timer);
      selectNotifyTimerRef.current = null;
      lastSelectedRef.current = null;
      if (beacon) {
        api.state.notifyModelChangedBeacon(section, lastId);
      } else {
        api.state.notifyModelChanged(section, lastId).catch(() => void 0);
      }
    };
    const onHide = () => fireIfPending(true);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") fireIfPending(true);
    };
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
      fireIfPending(false);
    };
  }, [section]);

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
    // Гасим pending notification: если debounce таймер ещё крутится после
    // прошлого silent select, без сброса юзер бы получил «X активирована»
    // через 5с, хотя из-за смены mode модель уже не «активна» в смысле UI.
    if (selectNotifyTimerRef.current && lastSelectedRef.current === modelId) {
      clearTimeout(selectNotifyTimerRef.current);
      selectNotifyTimerRef.current = null;
      lastSelectedRef.current = null;
      setHasPendingSelect(false);
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
