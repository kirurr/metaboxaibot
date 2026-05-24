import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import clsx from "clsx";
import { useIsMobile } from "@/hooks/useIsMobile";
import { modelsForCapability, useModelsStore } from "@/stores/modelsStore";
import { useDialogsStore } from "@/stores/dialogsStore";
import { useAuthStore } from "@/stores/authStore";
import * as dialogsApi from "@/api/dialogs";
import type { DialogDto } from "@/api/dialogs";
import type { WebModelDto } from "@/api/models";
import type { ApiError } from "@/api/client";
import {
  getAllModelSettings,
  resolveEffectiveSettings,
  setDialogModelSettings,
  setUserModelSettings,
  type ModelSettingsRoot,
} from "@/api/modelSettings";
import { ChatSidebar } from "@/components/chat/ChatSidebar";
import { ChatHeader } from "@/components/chat/ChatHeader";
import { ChatEmpty } from "@/components/chat/ChatEmpty";
import { ChatThread } from "@/components/chat/ChatThread";
import { ChatComposer } from "@/components/chat/ChatComposer";
import { dialogTitle, messageDtoToMsg, modelDisplayName } from "@/components/chat/chatHelpers";
import type { Msg, PendingAttachment } from "@/components/chat/chatTypes";

const SECTION = "gpt";

/**
 * Чат — sidebar c реальными диалогами пользователя (через `/web/dialogs`),
 * активная сессия с подгрузкой истории и SSE-стримом ответа.
 *
 * Все запросы под `webTelegramLinkedPreHandler` — если Telegram не привязан,
 * модалка открывается автоматически из `apiClient`.
 */
export default function Chat() {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const location = useLocation();
  const navigate = useNavigate();
  const { id: routeId } = useParams<{ id: string }>();
  const activeId = routeId ?? null;
  const prefill = (location.state as { prefill?: string } | null)?.prefill ?? "";

  // Стартовые промпты — массив из 4 ключей, чтобы локализовалось.
  const STARTER_PROMPTS = useMemo(
    () => [
      t("chat.starterPrompts.0"),
      t("chat.starterPrompts.1"),
      t("chat.starterPrompts.2"),
      t("chat.starterPrompts.3"),
    ],
    [t],
  );

  const allModels = useModelsStore((s) => s.models);
  const chatModels = useMemo(() => {
    const seen = new Set<string>();
    const out: WebModelDto[] = [];
    for (const m of modelsForCapability(allModels, "text")) {
      const key = m.familyId ?? m.id;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(m);
    }
    return out;
  }, [allModels]);

  const dialogs = useDialogsStore((s) => s.dialogs);
  const dialogsLoaded = useDialogsStore((s) => s.loaded);
  const dialogsLoading = useDialogsStore((s) => s.isLoading);
  const dialogsErrorCode = useDialogsStore((s) => s.errorCode);
  const loadDialogs = useDialogsStore((s) => s.load);
  const prependDialog = useDialogsStore((s) => s.prepend);
  const renameInStore = useDialogsStore((s) => s.rename);
  const removeFromStore = useDialogsStore((s) => s.remove);
  const bumpInStore = useDialogsStore((s) => s.bump);

  const setUser = useAuthStore((s) => s.setUser);
  const currentUser = useAuthStore((s) => s.user);

  // activeId = `useParams().id` (см. выше). null = «черновик», ещё не созданный
  // на бэке. После первой отправки send() сам делает navigate(`/chat/<id>`).
  const [messages, setMessages] = useState<Msg[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [draft, setDraft] = useState(prefill);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const [modelId, setModelId] = useState<string>("");
  const [sideCollapsed, setSideCollapsed] = useState(false);
  const [sideOpen, setSideOpen] = useState(false);
  const [menuForId, setMenuForId] = useState<string | null>(null);

  // Bumped by newChat() — composer effect refocuses textarea on change.
  const [focusKey, setFocusKey] = useState(0);

  // Pending-вложения: загружены в S3, но ещё не отправлены с сообщением.
  // Хранятся локально и сбрасываются после успешной отправки или newChat().
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);

  // Полный корень `/model-settings` — `{ [modelId]: {...}, "dialog:<id>": {...} }`.
  // Подтягиваем один раз на mount, мерджим клиент-сайдом через
  // resolveEffectiveSettings — те же приоритеты, что у бэкенда
  // (см. userStateService.getEffectiveDialogSettings).
  const [settingsRoot, setSettingsRoot] = useState<ModelSettingsRoot>({});

  const sideVisible = isMobile ? sideOpen : !sideCollapsed;
  const abortRef = useRef<AbortController | null>(null);
  // Дебаунсер PATCH-ей настроек: накапливаем diff per-bucket и шлём одним
  // запросом. 800мс совпадает с веб-аппом (GptManagementView.tsx:82-88).
  // Map хранит pending-изменения, которые ещё не ушли на сервер — флашатся
  // или по таймеру, или принудительно перед send() (иначе race: юзер набрал
  // system_prompt и сразу нажал Send до того, как timer успел стрельнуть).
  const settingsPendingRef = useRef<Map<string, Record<string, unknown>>>(new Map());
  const settingsTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const settingsInflightRef = useRef<Set<Promise<unknown>>>(new Set());
  // Маркируем id диалогов, для которых история уже загружена/прогрета. Нужен
  // потому что после `createDialog` мы знаем, что диалог пустой, и эффект ниже
  // не должен ходить за `getMessages` — иначе он перетрёт оптимистично-добавленные
  // user-сообщение и placeholder AI-bubble.
  const loadedRef = useRef<string | null>(null);

  // Дефолтная модель: most-recent-dialog.modelId, fallback на chatModels[0].
  // Ждём первой попытки load (success ИЛИ error), иначе race: chatModels
  // загружается раньше dialogs и эффект пикнул бы chatModels[0] до того, как
  // диалоги юзера успели подтянуться.
  useEffect(() => {
    if (modelId) return;
    if (chatModels.length === 0) return;
    if (!dialogsLoaded && !dialogsErrorCode) return;
    const recent = dialogs.find((d) => chatModels.some((m) => m.id === d.modelId));
    setModelId(recent ? recent.modelId : chatModels[0].id);
  }, [modelId, chatModels, dialogs, dialogsLoaded, dialogsErrorCode]);

  // Грузим список диалогов один раз после монтирования.
  useEffect(() => {
    loadDialogs(SECTION);
  }, [loadDialogs]);

  // Подтягиваем все настройки моделей одним запросом — клиент-сайд резолвим
  // эффективные значения из defaults + user-level + dialog override.
  // Игнорим ошибку (TELEGRAM_NOT_LINKED уже обрабатывает apiClient) — оставляем
  // settingsRoot={}, эффективные значения упадут на defaults.
  useEffect(() => {
    let cancelled = false;
    getAllModelSettings()
      .then((root) => {
        if (!cancelled) setSettingsRoot(root);
      })
      .catch(() => {
        /* ignore */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // На unmount — гасим pending-таймеры дебаунсера, чтобы не висели после ухода.
  useEffect(() => {
    const timers = settingsTimersRef.current;
    return () => {
      for (const id of Object.values(timers)) clearTimeout(id);
    };
  }, []);

  // При смене активного диалога — подтягиваем его историю. Если он уже помечен
  // в `loadedRef` (например, только что создан в send() или ранее уже грузили),
  // повторного fetch не делаем.
  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      loadedRef.current = null;
      return;
    }
    if (loadedRef.current === activeId) return;
    let cancelled = false;
    setMessagesLoading(true);
    setSendError(null);
    dialogsApi
      .getMessages(activeId)
      .then((items) => {
        if (cancelled) return;
        loadedRef.current = activeId;
        setMessages(items.map(messageDtoToMsg));
      })
      .catch((err: ApiError) => {
        if (cancelled) return;
        // 404 — диалог удалён, сбрасываем активный.
        if (err.status === 404) {
          removeFromStore(activeId);
          navigate("/chat", { replace: true });
        }
      })
      .finally(() => {
        if (!cancelled) setMessagesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeId, removeFromStore, navigate]);

  // При смене активного диалога / после reload — подтягиваем модель из самого
  // диалога. DialogDto.modelId — single source of truth (бэкенд берёт её при
  // streamMessage); без этого composer показывал бы last-used вместо реальной.
  useEffect(() => {
    if (!activeId) return;
    const dialog = dialogs.find((d) => d.id === activeId);
    if (dialog && dialog.modelId !== modelId) setModelId(dialog.modelId);
  }, [activeId, dialogs, modelId]);

  // На unmount или смену диалога — отменяем активный SSE-stream.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const selectedModel = useMemo(
    () => chatModels.find((m) => m.id === modelId) ?? chatModels[0],
    [chatModels, modelId],
  );
  const activeDialog = activeId ? dialogs.find((d) => d.id === activeId) : null;

  // Эффективные значения настроек для выбранной модели/диалога. Резолвится
  // клиент-сайд из defaults + user-level overrides + dialog overrides — те же
  // приоритеты, что у бэкенда в getEffectiveDialogSettings.
  const settingValues = useMemo(() => {
    if (!selectedModel) return {};
    return resolveEffectiveSettings(
      settingsRoot,
      selectedModel.id,
      activeId,
      selectedModel.settings,
    );
  }, [settingsRoot, selectedModel, activeId]);

  // Шлёт накопленный diff одной PATCH-ой и пишет промис в inflight-сет, чтобы
  // его можно было дождаться из flushSettings перед send().
  const flushBucket = useCallback((bucket: string) => {
    const changes = settingsPendingRef.current.get(bucket);
    if (!changes || Object.keys(changes).length === 0) return;
    settingsPendingRef.current.delete(bucket);
    const promise = bucket.startsWith("dialog:")
      ? setDialogModelSettings(bucket.slice("dialog:".length), changes)
      : setUserModelSettings(bucket, changes);
    const wrapped = promise.catch(() => {
      /* swallow — следующий патч заменит ошибочное состояние */
    });
    settingsInflightRef.current.add(wrapped);
    void wrapped.finally(() => settingsInflightRef.current.delete(wrapped));
  }, []);

  // Принудительный флаш: гасим все debounce-таймеры, шлём накопленные diff'ы и
  // ждём inflight-PATCH'ей. Вызывается в начале send() — иначе race: юзер
  // набрал system_prompt и сразу нажал Send до того, как 800мс таймер успел
  // стрельнуть → бэкенд читает старое состояние из БД.
  const flushSettings = useCallback(async () => {
    for (const [bucket, timer] of Object.entries(settingsTimersRef.current)) {
      clearTimeout(timer);
      delete settingsTimersRef.current[bucket];
      flushBucket(bucket);
    }
    if (settingsInflightRef.current.size > 0) {
      await Promise.all(settingsInflightRef.current);
    }
  }, [flushBucket]);

  // Изменение настройки: optimistic local + debounced PATCH.
  //   - Активный диалог есть → пишем в `dialog:<id>` (override только для этого треда).
  //   - Черновик (нет диалога) → пишем в user-level для текущей модели. Когда
  //     первое сообщение создаст диалог, бэкенд смержит user-level как defaults,
  //     так что мигрировать ничего не нужно.
  // Diff накапливается в `settingsPendingRef[bucket]` и уходит одним запросом
  // на debounce-таймер; flushSettings() умеет дернуть его принудительно.
  const updateSetting = useCallback(
    (key: string, value: unknown) => {
      if (!selectedModel) return;
      const bucket = activeId ? `dialog:${activeId}` : selectedModel.id;
      setSettingsRoot((prev) => ({
        ...prev,
        [bucket]: { ...(prev[bucket] ?? {}), [key]: value },
      }));
      const existing = settingsPendingRef.current.get(bucket) ?? {};
      settingsPendingRef.current.set(bucket, { ...existing, [key]: value });
      const existingTimer = settingsTimersRef.current[bucket];
      if (existingTimer) clearTimeout(existingTimer);
      settingsTimersRef.current[bucket] = setTimeout(() => {
        delete settingsTimersRef.current[bucket];
        flushBucket(bucket);
      }, 800);
    },
    [selectedModel, activeId, flushBucket],
  );

  // Текущий контекст диалога = high-water mark по `inputTokens+outputTokens`
  // среди всех ассистент-сообщений + грубая оценка для сообщений ПОСЛЕ
  // референсного ассистента (length/4 — тот же эвристик, что в composer'е).
  //
  // Почему high-water mark, а не просто последний ассистент: сервер режет
  // историю при превышении ~75% окна модели (см.
  // packages/api/src/ai/llm/truncate.ts:71 — `truncateInputDefault`). Поэтому
  // `inputTokens` нового ассистента может ОКАЗАТЬСЯ МЕНЬШЕ предыдущего —
  // и индикатор бы прыгал вниз. Берём максимум, чтобы значение росло
  // монотонно и честно показывало пик использования контекста.
  const currentContextTokens = useMemo(() => {
    let bestIdx = -1;
    let bestTokens = 0;
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role !== "ai") continue;
      const inT = m.inputTokens;
      const outT = m.outputTokens;
      if (typeof inT !== "number" || typeof outT !== "number") continue;
      const sum = inT + outT;
      if (sum > bestTokens) {
        bestTokens = sum;
        bestIdx = i;
      }
    }
    let total = bestTokens;
    // Сообщения после high-water mark (например, юзер только что отправил
    // следующий вопрос, ответ ещё стримится) — оцениваем по тексту.
    for (let i = bestIdx + 1; i < messages.length; i++) {
      total += Math.max(1, Math.round(messages[i].text.length / 4));
    }
    return total;
  }, [messages]);

  // Создание нового черновика — без обращения к бэку. Реальный POST вылетит на
  // первой отправке (см. send()).
  const newChat = useCallback(() => {
    abortRef.current?.abort();
    navigate("/chat");
    setMessages([]);
    setDraft("");
    setSendError(null);
    setPendingAttachments([]);
    setSideOpen(false);
    setFocusKey((k) => k + 1);
  }, [navigate]);

  const send = useCallback(async () => {
    const text = draft.trim();
    const readyAttachments = pendingAttachments.filter(
      (p): p is Extract<PendingAttachment, { status: "ready" }> => p.status === "ready",
    );
    const uploadingCount = pendingAttachments.filter((p) => p.status === "uploading").length;

    // Можно отправить только с текстом ИЛИ только с вложениями. Без всего — no-op.
    if ((!text && readyAttachments.length === 0) || sending) return;
    if (uploadingCount > 0) {
      setSendError(t("chat.waitUploads"));
      return;
    }
    if (!selectedModel) {
      setSendError(t("chat.errorModelLoading"));
      return;
    }

    setSendError(null);
    setSending(true);

    // 0) Флашим pending-PATCH настроек до createDialog/streamMessage. Иначе
    //    race: backend читает getEffectiveDialogSettings из БД, а debounce
    //    ещё не успел отослать system_prompt/temperature/etc.
    await flushSettings();

    // 1) Гарантируем существующий диалог на бэке.
    let dialogId = activeId;
    if (!dialogId) {
      try {
        const created = await dialogsApi.createDialog({
          section: SECTION,
          modelId: selectedModel.id,
          // Первое сообщение в качестве title — компактнее, чем «Новый диалог».
          title: text.slice(0, 60),
        });
        dialogId = created.id;
        prependDialog(created);
        // Помечаем как «уже прогретый», иначе message-loader-effect сбегает за
        // getMessages и затирает оптимистично-добавленные ниже messages.
        loadedRef.current = created.id;
        // replace: чёрновик и реальный диалог — одна логическая страница,
        // back-button не должен возвращать на пустой draft.
        navigate(`/chat/${created.id}`, { replace: true });
      } catch (err) {
        const e = err as ApiError;
        setSending(false);
        setSendError(e.message || t("chat.errorCreateDialog"));
        return;
      }
    }

    // Split attachments на images (для chatService.imageS3Keys) и documents
    // (для chatService.documentAttachments).
    const imageAtts = readyAttachments.filter((p) => p.dto.kind === "image");
    const docAtts = readyAttachments.filter((p) => p.dto.kind === "document");
    const imageS3Keys = imageAtts.map((p) => p.dto.s3Key);
    const documentAttachments = docAtts.map((p) => ({
      s3Key: p.dto.s3Key,
      mimeType: p.dto.mimeType,
      name: p.dto.name,
      size: p.dto.size,
    }));
    // DTO для оптимистичного user-bubble (показываем chip'ы прямо в треде).
    const optimisticAtts = readyAttachments.map((p) => ({
      s3Key: p.dto.s3Key,
      mimeType: p.dto.mimeType,
      name: p.dto.name,
      size: p.dto.size,
      url: p.dto.url,
      kind: p.dto.kind,
    }));

    // 2) Оптимистично добавляем user-сообщение + пустой AI-bubble.
    const localId = `local-${Date.now()}`;
    setMessages((m) => [
      ...m,
      {
        role: "user",
        text,
        localId,
        ...(optimisticAtts.length ? { attachments: optimisticAtts } : {}),
      },
      { role: "ai", text: "", localId: localId + ".ai" },
    ]);
    setDraft("");
    setPendingAttachments([]);

    // 3) Стримим ответ.
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let tokensUsed = 0;

    try {
      await dialogsApi.streamMessage(
        dialogId,
        {
          content: text,
          ...(imageS3Keys.length ? { imageS3Keys } : {}),
          ...(documentAttachments.length ? { documentAttachments } : {}),
        },
        {
          onChunk: (chunk) => {
            setMessages((m) => {
              const next = [...m];
              const last = next[next.length - 1];
              if (last && last.role === "ai") {
                next[next.length - 1] = { ...last, text: last.text + chunk };
              }
              return next;
            });
          },
          onDone: ({ tokensUsed: used, inputTokens, outputTokens, balance }) => {
            tokensUsed = used;
            // Финализируем мету у последнего AI-сообщения + сохраняем raw-токены
            // для composer-индикатора контекста (см. рендер ниже).
            setMessages((m) => {
              const next = [...m];
              const last = next[next.length - 1];
              if (last && last.role === "ai") {
                const modelName = selectedModel ? modelDisplayName(selectedModel) : "AI";
                // toFixed(4) → parseFloat: режем плавающий хвост 0.11643000000000002
                // до 0.1164, заодно убираем trailing zeros у целых/коротких значений.
                const usedFormatted = parseFloat(used.toFixed(4));
                next[next.length - 1] = {
                  ...last,
                  meta: `${modelName} · ${usedFormatted} ${t("chat.tokensSpent")}`,
                  inputTokens,
                  outputTokens,
                };
              }
              return next;
            });
            // Обновляем баланс юзера сразу — без отдельного запроса /web/balance.
            if (currentUser) {
              setUser({
                ...currentUser,
                tokenBalance: balance.tokenBalance,
                subscriptionTokenBalance: balance.subscriptionTokenBalance,
              });
            }
          },
          onError: ({ message }) => {
            setSendError(message);
            // Сносим placeholder AI-bubble — модель не успела ответить.
            setMessages((m) => m.filter((x) => x.localId !== localId + ".ai"));
          },
        },
        ctrl.signal,
      );
    } catch (err) {
      const e = err as ApiError;
      setSendError(e.message || t("chat.errorSend"));
      setMessages((m) => m.filter((x) => x.localId !== localId + ".ai"));
    } finally {
      setSending(false);
      abortRef.current = null;
      if (dialogId && tokensUsed > 0) bumpInStore(dialogId);
    }
  }, [
    draft,
    pendingAttachments,
    sending,
    selectedModel,
    activeId,
    currentUser,
    t,
    flushSettings,
    prependDialog,
    bumpInStore,
    setUser,
    navigate,
  ]);

  const handleRename = useCallback(
    async (id: string) => {
      const current = dialogs.find((d) => d.id === id);
      const next = window.prompt(
        t("chat.renamePrompt"),
        dialogTitle(current ?? ({ title: null } as DialogDto), t("chat.newDialog")),
      );
      if (!next || next.trim().length === 0) return;
      const title = next.trim();
      try {
        await dialogsApi.renameDialog(id, title);
        renameInStore(id, title);
      } catch (err) {
        const e = err as ApiError;
        setSendError(e.message || t("chat.errorRename"));
      } finally {
        setMenuForId(null);
      }
    },
    [dialogs, t, renameInStore],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      if (!window.confirm(t("chat.deletePrompt"))) return;
      try {
        await dialogsApi.deleteDialog(id);
        removeFromStore(id);
        if (activeId === id) {
          navigate("/chat");
          setMessages([]);
        }
      } catch (err) {
        const e = err as ApiError;
        setSendError(e.message || t("chat.errorDelete"));
      } finally {
        setMenuForId(null);
      }
    },
    [activeId, t, removeFromStore, navigate],
  );

  const onSelectDialog = useCallback(
    (id: string) => {
      navigate(`/chat/${id}`);
      setSideOpen(false);
    },
    [navigate],
  );

  const onCloseMobileDrawer = useCallback(() => setSideOpen(false), []);
  const onCollapseDesktop = useCallback(() => setSideCollapsed(true), []);
  const onExpandSide = useCallback(() => {
    if (isMobile) setSideOpen(true);
    else setSideCollapsed(false);
  }, [isMobile]);

  return (
    <div className={clsx("chat-shell", !isMobile && sideCollapsed && "side-collapsed")}>
      {sideVisible && (
        <ChatSidebar
          dialogs={dialogs}
          dialogsLoaded={dialogsLoaded}
          dialogsLoading={dialogsLoading}
          dialogsErrorCode={dialogsErrorCode}
          activeId={activeId}
          onSelectDialog={onSelectDialog}
          onNewChat={newChat}
          onRename={handleRename}
          onDelete={handleDelete}
          menuForId={menuForId}
          setMenuForId={setMenuForId}
          isMobile={isMobile}
          sideOpen={sideOpen}
          onCloseMobileDrawer={onCloseMobileDrawer}
          onCollapseDesktop={onCollapseDesktop}
        />
      )}

      <div className="chat-main">
        <ChatHeader
          activeDialog={activeDialog ?? null}
          messagesLoading={messagesLoading}
          messagesCount={messages.length}
          isMobile={isMobile}
          sideOpen={sideOpen}
          sideCollapsed={sideCollapsed}
          onExpandSide={onExpandSide}
          onNewChat={newChat}
        />

        {messages.length === 0 && !messagesLoading ? (
          <div className="chat-scroll">
            <ChatEmpty
              selectedModel={selectedModel}
              chatModels={chatModels}
              modelId={modelId}
              onSelectModel={setModelId}
              starterPrompts={STARTER_PROMPTS}
              onPickPrompt={setDraft}
            />
          </div>
        ) : (
          <ChatThread messages={messages} messagesLoading={messagesLoading} />
        )}

        {sendError && (
          <div className="chat-error">
            <span>{sendError}</span>
            <button onClick={() => setSendError(null)} aria-label={t("common.close")}>
              <X size={14} />
            </button>
          </div>
        )}

        <ChatComposer
          draft={draft}
          onDraftChange={setDraft}
          onSend={send}
          sending={sending}
          selectedModel={selectedModel}
          currentContextTokens={currentContextTokens}
          pendingAttachments={pendingAttachments}
          setPendingAttachments={setPendingAttachments}
          settingValues={settingValues}
          onUpdateSetting={updateSetting}
          focusKey={focusKey}
        />
      </div>
    </div>
  );
}
