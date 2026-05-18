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

const SECTION_ACTIVE_STATE: Record<MediaSection, string> = {
  design: "DESIGN_ACTIVE",
  video: "VIDEO_ACTIVE",
  audio: "AUDIO_ACTIVE",
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
  // Auto-activate debounce. Любая смена «текущей модели» — открытие view с
  // initialModelId, переключение picker, тап варианта в карусели — взводит
  // 3-секундный таймер на full activate (state → *_ACTIVE + Telegram-пинг).
  // Это убирает обязательность тапа «Активировать»: standalone-модели и
  // переключения семейств тоже фиксируются. Дедуп по lastActivatedRef:
  // если target — то что уже активно в боте, таймер не ставится, чтобы не
  // спамить чат одинаковыми «Модель X активирована».
  const autoActivateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastActivatedRef = useRef<string | null>(null);
  // Mount-guard для async-задач auto-activate. autoActivate ждёт
  // selectChainRef перед fetch'ем — за это время компонент может быть
  // unmounted (tab-switch в ManagementPage делает conditional-render → unmount,
  // X-close webview). Без guard'а activate улетел бы «вдогонку» и notify
  // прилетел бы юзеру когда он уже на другой вкладке.
  const mountedRef = useRef(true);
  // Версионный токен «текущей activate-операции». Каждый запуск (schedule,
  // ручной activate, smen варианта) инкрементирует counter; autoActivate
  // запоминает свою версию на старте и после await проверяет, что версия не
  // изменилась — иначе значит другой код перехватил инициативу и наш fetch
  // дублировался бы. Сравнение по modelId не годится, потому что mode change
  // на ту же модель должен инвалидировать предыдущий in-flight activate
  // (старый mode) и запустить новый (с актуальным mode) — у обоих modelId
  // одинаков, только version отличается.
  const activateOpRef = useRef(0);
  // Popup-таймер на «Активирована» — храним чтобы очистить на unmount,
  // иначе setState отрабатывает на размонтированном компоненте.
  const popupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const AUTO_ACTIVATE_DELAY_MS = 3000;

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
        // Сид для дедупа авто-активаций: если бот уже в *_ACTIVE на activeId,
        // считаем «эта модель только что активирована» — повторный activate
        // на ту же модель не отправит сообщение в чат. Если state другой
        // (юзер ушёл в /menu и state в IDLE), ref остаётся null и через 3с
        // случится legitimate activate.
        if (activeId && state.state === SECTION_ACTIVE_STATE[section]) {
          lastActivatedRef.current = activeId;
        }
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

  const cancelAutoActivate = () => {
    if (autoActivateTimerRef.current) {
      clearTimeout(autoActivateTimerRef.current);
      autoActivateTimerRef.current = null;
    }
  };

  // Тихая авто-активация (без закрытия мини-аппы и без всплывающего popup'а):
  // ставится таймером после любой смены target-модели. Дождаться silent-select
  // очереди обязательно — иначе late selectModel мог бы переписать DB после
  // activate (см. handleModelActivate). После успеха обновляем lastActivatedRef
  // чтобы повторный target=та же модель не пинговал юзера снова.
  const autoActivate = async (modelId: string, opVersion: number) => {
    // Optimistic UI: запоминаем prev чтобы откатить при ошибке. Версия
    // operation захвачена в момент scheduleAutoActivate (synchronous каждый
    // setSchedule) — если за время await что-то перехватило (новый schedule,
    // ручной activate, smen варианта), activateOpRef.current уже больше нашей
    // opVersion и мы выходим, не запуская fetch.
    const prevActive = activeModelId;
    const prevState = stateStr;
    setHasPendingSelect(false);
    setActiveModelId(modelId);
    setState(SECTION_ACTIVE_STATE[section]);
    await selectChainRef.current.catch(() => void 0);
    // Tab-switch / X-close между взводом таймера и моментом fetch'а: компонент
    // unmounted, дальше слать activate бессмысленно — это привело бы к notify
    // «модель X активирована» когда юзер уже на video-вкладке или закрыл webview.
    if (!mountedRef.current) return;
    // Перехвачено более свежей operation (другая модель, новый mode на той же
    // модели, ручной activate) — наш fetch стал устаревшим, скипаем чтобы не
    // отправить дубль activate + notify.
    if (activateOpRef.current !== opVersion) return;
    try {
      await api.state.activate(section, modelId);
      // Между fetch'ем и его resolve компонент мог unmount'ся (tab-switch,
      // X-close webview). Любой setState отсюда уйдёт в «detached» React tree
      // и выдаст «state update on unmounted component». lastActivatedRef сам
      // по себе после unmount уже не важен — компонент-instance уходит.
      if (!mountedRef.current) return;
      // Версия могла подняться пока activate был в полёте — обновляем
      // lastActivatedRef только если мы всё ещё актуальная operation.
      if (activateOpRef.current === opVersion) {
        lastActivatedRef.current = modelId;
      }
    } catch (e) {
      console.error("[settings] auto-activate failed", modelId, e);
      // Тот же mount-guard для rollback-ветки: setActiveModelId на unmount'е
      // запрещён React'ом.
      if (!mountedRef.current) return;
      // Rollback только если мы всё ещё актуальная operation — иначе свежий
      // optimistic state принадлежит чьей-то более новой работе, и его откат
      // создал бы рассинхрон (model=новая / state=наш prev).
      if (activateOpRef.current === opVersion) {
        setActiveModelId((cur) => (cur === modelId ? prevActive : cur));
        setState((cur) => (cur === SECTION_ACTIVE_STATE[section] ? prevState : cur));
      }
    }
  };

  const scheduleAutoActivate = (modelId: string) => {
    if (!modelId) return;
    cancelAutoActivate();
    // Инкремент op ДО dedup-check — это инвалидирует любой pending in-flight
    // autoActivate даже если новый schedule сам ничего не запустит (dedup).
    // Без этого: in-flight autoActivate(A,op=N) висит, прилетает schedule(A) с
    // dedup hit, op остаётся N → in-flight долетит и активирует уже-устаревший
    // mode/state. Сейчас невозможно срабатывает (все callers сами разруливают
    // lastActivatedRef), но это инвариант на будущее.
    ++activateOpRef.current;
    // Дедуп: модель уже activated в боте — повторный activate idempotent но
    // sendModelActivatedNotification всё равно шлёт сообщение в чат, что для
    // авто-режима выглядит как спам. Пропускаем.
    if (modelId === lastActivatedRef.current) return;
    // Захватываем актуальную версию для нашего таймера — при срабатывании
    // через 3с autoActivate сравнит её с activateOpRef.current и скипнет, если
    // кто-то более свежий уже инкрементнул counter.
    const opVersion = activateOpRef.current;
    autoActivateTimerRef.current = setTimeout(() => {
      autoActivateTimerRef.current = null;
      void autoActivate(modelId, opVersion);
    }, AUTO_ACTIVATE_DELAY_MS);
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelAutoActivate();
      if (popupTimerRef.current) {
        clearTimeout(popupTimerRef.current);
        popupTimerRef.current = null;
      }
    };
  }, []);

  // Реагируем на смену picker'а (юзер переключился на другое семейство или
  // standalone-модель в выпадашке). Определяем target: для family — активная
  // модель внутри если она здесь, иначе familyDefaultModelId / первый член;
  // для standalone — сам id из picker'а. Срабатывает и на initial-mount после
  // загрузки (loading→false), чем покрывает сценарий «открыли через "Выбрать
  // модель" в боте — нужно автоактивировать через 3с».
  useEffect(() => {
    if (loading) return;
    const [pickerType, pickerId] = selectedPickerId.split("__");
    if (!pickerType || !pickerId) return;
    let target: string | undefined;
    if (pickerType === "family") {
      const members = models.filter((m) => m.familyId === pickerId);
      const belongsHere = members.some((m) => m.id === activeModelId);
      if (belongsHere) {
        target = activeModelId;
      } else {
        const familyDefaultId = members[0]?.familyDefaultModelId ?? null;
        const def =
          (familyDefaultId ? members.find((m) => m.id === familyDefaultId) : null) ?? members[0];
        target = def?.id;
      }
    } else if (pickerType === "standalone") {
      target = pickerId;
    }
    if (target) scheduleAutoActivate(target);
  }, [selectedPickerId, loading]);

  const handleModelActivate = async (modelId: string) => {
    // Юзер сам нажал «Активировать» — гасим pending таймер и поднимаем версию
    // operation. Cancel таймера спасает только если он ещё не выстрелил; если
    // autoActivate уже стартовал и сидит в await selectChainRef, ему нужен
    // сигнал «ты устарел» — инкремент activateOpRef сделает его post-await
    // check отрицательным, и он скипнет fetch + rollback.
    cancelAutoActivate();
    const opVersion = ++activateOpRef.current;
    const prevActive = activeModelId;
    const prevState = stateStr;
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
      // Webview мог закрыться/таб переключиться пока activate был в полёте —
      // setActivatedPopup/setTimeout сразу под этим try-блоком должен не
      // сработать в этом случае (state update on unmounted). closeMiniApp
      // тоже бесполезен (webview уже закрыт юзером).
      if (!mountedRef.current) return;
      if (activateOpRef.current === opVersion) {
        lastActivatedRef.current = modelId;
      }
    } catch (e) {
      console.error("[settings] activate failed", modelId, e);
      if (!mountedRef.current) return;
      // Откат оптимистичного UI только если мы всё ещё актуальная operation.
      // Иначе свежий optimistic state — от перехватившей операции, его перезапись
      // создала бы рассинхрон model=новая / state=наш prev.
      if (activateOpRef.current === opVersion) {
        setActiveModelId((cur) => (cur === modelId ? prevActive : cur));
        setState((cur) => (cur === SECTION_ACTIVE_STATE[section] ? prevState : cur));
      }
      return;
    }
    setActivatedPopup(true);
    if (popupTimerRef.current) clearTimeout(popupTimerRef.current);
    popupTimerRef.current = setTimeout(() => {
      popupTimerRef.current = null;
      setActivatedPopup(false);
    }, 3000);
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

    // scheduleAutoActivate ниже инкрементнёт activateOpRef и тем самым
    // перехватит любой pending in-flight autoActivate (на старую модель). Его
    // rollback после catch не затрёт наш свежий optimistic UI, потому что
    // его захваченная opVersion уже не равна текущей.
    setActiveModelId(modelId);
    setHasPendingSelect(true);
    selectChainRef.current = selectChainRef.current.then(() =>
      api.state.selectModel(section, modelId).catch((e) => {
        console.error("[settings] select-model failed", modelId, e);
      }),
    );
    // Поверх silent-select взводим debounced full activate — через 3с тишины
    // модель станет реально активной в боте (state → *_ACTIVE) без тапа
    // «Активировать». Silent-select с keepalive страхует ранний X-close:
    // если юзер закроет webview до 3с, БД-поле уже сохранено, server-side
    // trailing-debounce пришлёт обычный notify; activate просто не сработает.
    scheduleAutoActivate(modelId);
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
    // Mode change инвалидирует текущую активацию — бот должен заново спросить
    // слоты под новый mode. Раньше тут активная модель локально сбрасывалась
    // и юзер должен был жать «Активировать»; теперь через 3с реактивируем
    // авто. lastActivatedRef ресетим: иначе scheduleAutoActivate задедупит на
    // ту же модель (она уже считается активной) и таймер не встанет. Сам
    // activeModelId НЕ сбрасываем — picker'у нельзя видеть "" иначе на
    // следующем тике он подхватит familyDefault как target и через 3с
    // активирует чужую модель внутри семейства.
    if (modelId === activeModelId) {
      lastActivatedRef.current = null;
      scheduleAutoActivate(modelId);
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
