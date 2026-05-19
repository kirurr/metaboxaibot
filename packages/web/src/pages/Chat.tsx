import Markdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  Copy,
  Download,
  File as FileIcon,
  ImageIcon,
  Menu,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  X,
  ArrowUp,
} from "lucide-react";
import clsx from "clsx";
import { useIsMobile } from "@/hooks/useIsMobile";
import { modelsForCapability, useModelsStore } from "@/stores/modelsStore";
import { useDialogsStore } from "@/stores/dialogsStore";
import { useAuthStore } from "@/stores/authStore";
import * as dialogsApi from "@/api/dialogs";
import type { DialogDto, MessageAttachmentDto, MessageDto } from "@/api/dialogs";
import type { WebModelDto } from "@/api/models";
import type { ApiError } from "@/api/client";
import { uploadChatFile, type ChatUploadDto } from "@/api/uploads";
import { markdownComponents } from "@/components/chat/MarkdownElements";

type Msg = {
  role: "user" | "ai";
  text: string;
  meta?: string;
  /** Локальный id для оптимистичных user-сообщений (бэк не возвращает их id до done). */
  localId?: string;
  /** Прикреплённые файлы — рендерятся над bubble. */
  attachments?: MessageAttachmentDto[];
};

/** `accept` для file picker'а — синхронизирован с серверным `isAllowedUploadMime`. */
const ACCEPT_MIMES =
  "image/png,image/jpeg,image/webp,image/gif,application/pdf,application/json," +
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document," +
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet," +
  "text/csv,text/plain,text/markdown";

/** Pending-аттач до отправки: либо в процессе загрузки, либо уже в S3. */
type PendingAttachment =
  | { id: string; status: "uploading"; file: File }
  | { id: string; status: "ready"; file: File; dto: ChatUploadDto }
  | { id: string; status: "error"; file: File; error: string };

const SECTION = "gpt";

/** Локализованный fallback для title диалога (когда `title === null`). */
function dialogTitle(d: DialogDto, fallback: string): string {
  return d.title ?? fallback;
}

function modelDisplayName(m: WebModelDto): string {
  return m.familyName ?? m.name;
}
function modelDesc(m: WebModelDto): string {
  return m.descriptionOverride ?? m.description;
}
function modelRate(m: WebModelDto): string {
  const n = (Math.round(m.tokenCostApprox / 10) * 10);
  const unit =
    m.tokenCostUnit === "msg"
      ? "/ msg"
      : m.tokenCostUnit === "mpx"
        ? "/ MP"
        : m.tokenCostUnit === "second"
          ? "/ sec"
          : m.tokenCostUnit === "kchar"
            ? "/ 1k chars"
            : m.tokenCostUnit === "mvideotoken"
              ? "/ M vtok"
              : "/ req";
  return `≈ ${n.toLocaleString("ru-RU")} т ${unit}`;
}

/**
 * "сейчас" / "5м" / "2ч" / "Вчера" / "Пн" / "Apr 28" — компактная подпись справа.
 * `t` обязателен, потому что часть строк (now/yesterday/weekday) локализована.
 */
function formatRelative(
  iso: string,
  t: (k: string, opts?: Record<string, unknown>) => string,
): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return t("chat.relTime.now");
  if (diffMin < 60) return t("chat.relTime.minutes", { n: diffMin });
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return t("chat.relTime.hours", { n: diffH });
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const dayStart = new Date(d);
  dayStart.setHours(0, 0, 0, 0);
  const diffDays = Math.floor((today.getTime() - dayStart.getTime()) / 86_400_000);
  if (diffDays === 1) return t("chat.relTime.yesterday");
  if (diffDays < 7) return t(`chat.relTime.weekday.${d.getDay()}`);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

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

  // null = «черновик», ещё не созданный на бэке. После первой отправки
  // вызовется `createDialog` и activeId станет реальным.
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [draft, setDraft] = useState(prefill);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [modelOpen, setModelOpen] = useState(false);
  const [modelId, setModelId] = useState<string>("");
  const [sideCollapsed, setSideCollapsed] = useState(false);
  const [sideOpen, setSideOpen] = useState(false);
  const [menuForId, setMenuForId] = useState<string | null>(null);

  // Pending-вложения: загружены в S3, но ещё не отправлены с сообщением.
  // Хранятся локально и сбрасываются после успешной отправки или newChat().
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);

  const sideVisible = isMobile ? sideOpen : !sideCollapsed;
  const sideRef = useRef<HTMLElement | null>(null);
  const modelPickRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Маркируем id диалогов, для которых история уже загружена/прогрета. Нужен
  // потому что после `createDialog` мы знаем, что диалог пустой, и эффект ниже
  // не должен ходить за `getMessages` — иначе он перетрёт оптимистично-добавленные
  // user-сообщение и placeholder AI-bubble.
  const loadedRef = useRef<string | null>(null);

  // Дефолтная модель — первая из каталога после загрузки.
  useEffect(() => {
    if (!modelId && chatModels.length > 0) setModelId(chatModels[0].id);
  }, [chatModels, modelId]);

  // Грузим список диалогов один раз после монтирования.
  useEffect(() => {
    loadDialogs(SECTION);
  }, [loadDialogs]);

  // Mobile drawer outside-click.
  useEffect(() => {
    if (!isMobile || !sideOpen) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (sideRef.current && !sideRef.current.contains(e.target as Node)) setSideOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
    };
  }, [isMobile, sideOpen]);

  // Model-pick popover outside-click.
  useEffect(() => {
    if (!modelOpen) return;
    const onDown = (e: MouseEvent) => {
      if (modelPickRef.current && !modelPickRef.current.contains(e.target as Node)) {
        setModelOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [modelOpen]);

  // Auto-scroll к низу при росте треда.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  // При смене активного диалога — подтягиваем его историю. Если он уже помечен
  // в `loadedRef` (например, только что создан в send() или ранее уже грузили),
  // повторного fetch не делаем.
  useEffect(() => {
    if (!activeId) {
      setMessages([]);
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
          setActiveId(null);
          removeFromStore(activeId);
        }
      })
      .finally(() => {
        if (!cancelled) setMessagesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeId, removeFromStore]);

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

  const autosize = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }, []);

  // Создание нового черновика — без обращения к бэку. Реальный POST вылетит на
  // первой отправке (см. send()).
  function newChat() {
    abortRef.current?.abort();
    setActiveId(null);
    setMessages([]);
    setDraft("");
    setSendError(null);
    setPendingAttachments([]);
    setSideOpen(false);
    setTimeout(() => taRef.current?.focus(), 0);
  }

  // Открыть system file picker. Допустимые MIME-типы синхронизированы с серверной
  // валидацией (см. `web-chat.ts`). multiple=true — можно прикрепить сразу пачку.
  function openFilePicker() {
    fileInputRef.current?.click();
  }

  function removePending(id: string) {
    setPendingAttachments((prev) => prev.filter((p) => p.id !== id));
  }

  // Грузим каждый файл параллельно через POST /web/chat-uploads. Каждый файл —
  // отдельный chip с состоянием uploading/ready/error. Send блокируется пока
  // есть uploading'и (см. checkSendable).
  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const list = Array.from(files);
    // Создаём pending-chips сразу для всех файлов, чтобы у юзера был визуальный
    // фидбек о начатой загрузке.
    const initial: PendingAttachment[] = list.map((file) => ({
      id: `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      status: "uploading",
      file,
    }));
    setPendingAttachments((prev) => [...prev, ...initial]);

    // Каждый upload — независимая promise, обновляем стейт по мере готовности.
    await Promise.all(
      initial.map(async (p) => {
        try {
          const dto = await uploadChatFile(p.file);
          setPendingAttachments((prev) =>
            prev.map((x) => (x.id === p.id ? { id: p.id, status: "ready", file: p.file, dto } : x)),
          );
        } catch (err) {
          const e = err as ApiError;
          const msg =
            e.code === "UNSUPPORTED_MEDIA_TYPE"
              ? t("chat.errorUnsupportedMedia")
              : e.code === "FILE_TOO_LARGE"
                ? t("chat.errorFileTooLarge")
                : e.message || t("chat.errorUploadFailed");
          setPendingAttachments((prev) =>
            prev.map((x) =>
              x.id === p.id ? { id: p.id, status: "error", file: p.file, error: msg } : x,
            ),
          );
        }
      }),
    );
  }

  // Дочитываемые из стейта в render'е — счётчики и блокировки кнопки Send.
  const uploadingCount = pendingAttachments.filter((p) => p.status === "uploading").length;
  const readyAttachments = pendingAttachments.filter(
    (p): p is Extract<PendingAttachment, { status: "ready" }> => p.status === "ready",
  );

  async function send() {
    const text = draft.trim();
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
        setActiveId(created.id);
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
    const optimisticAtts: MessageAttachmentDto[] = readyAttachments.map((p) => ({
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
    setTimeout(autosize, 0);

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
          onDone: ({ tokensUsed: used, balance }) => {
            tokensUsed = used;
            // Финализируем мету у последнего AI-сообщения.
            setMessages((m) => {
              const next = [...m];
              const last = next[next.length - 1];
              if (last && last.role === "ai") {
                const modelName = selectedModel ? modelDisplayName(selectedModel) : "AI";
                next[next.length - 1] = {
                  ...last,
                  meta: `${modelName} · ${used} tokens`,
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
      if (e.code !== "TELEGRAM_NOT_LINKED") {
        setSendError(e.message || t("chat.errorSend"));
      }
      setMessages((m) => m.filter((x) => x.localId !== localId + ".ai"));
    } finally {
      setSending(false);
      abortRef.current = null;
      if (dialogId && tokensUsed > 0) bumpInStore(dialogId);
    }
  }

  async function handleRename(id: string) {
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
  }

  async function handleDelete(id: string) {
    if (!window.confirm(t("chat.deletePrompt"))) return;
    try {
      await dialogsApi.deleteDialog(id);
      removeFromStore(id);
      if (activeId === id) {
        setActiveId(null);
        setMessages([]);
      }
    } catch (err) {
      const e = err as ApiError;
      setSendError(e.message || t("chat.errorDelete"));
    } finally {
      setMenuForId(null);
    }
  }

  const filteredDialogs = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return dialogs;
    return dialogs.filter((d) => dialogTitle(d, t("chat.newDialog")).toLowerCase().includes(q));
  }, [dialogs, search, t]);

  return (
    <div className={clsx("chat-shell", !isMobile && sideCollapsed && "side-collapsed")}>
      {sideVisible && (
        <aside ref={sideRef} className={clsx("chat-side", sideOpen && "open open-backdrop")}>
          <div className="cs-head">
            <button className="btn btn-primary btn-sm cs-new" onClick={newChat}>
              <Plus size={14} /> {t("chat.newDialogBtn")}
            </button>
            <button
              className="cs-collapse"
              title={isMobile ? t("chat.dialogsClose") : t("chat.dialogsCollapse")}
              onClick={() => {
                if (isMobile) setSideOpen(false);
                else setSideCollapsed(true);
              }}
            >
              {isMobile ? <X size={16} /> : <ChevronLeft size={16} />}
            </button>
          </div>
          <div className="cs-search">
            <Search size={14} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("chat.searchDialogs")}
            />
          </div>
          <div className="cs-list">
            {!dialogsLoaded && dialogsLoading && (
              <div className="cs-group">{t("chat.loadingDialogs")}</div>
            )}
            {dialogsLoaded && dialogsErrorCode === "TELEGRAM_NOT_LINKED" && (
              <div className="cs-group" style={{ color: "var(--text-secondary)" }}>
                {t("chat.linkTgToSeeDialogs")}
              </div>
            )}
            {dialogsLoaded && filteredDialogs.length === 0 && !dialogsErrorCode && (
              <div className="cs-group">{search ? t("common.empty") : t("chat.noDialogs")}</div>
            )}
            {filteredDialogs.length > 0 && <div className="cs-group">{t("chat.recent")}</div>}
            {filteredDialogs.map((d) => (
              <div key={d.id} style={{ position: "relative" }}>
                <button
                  className={clsx("cs-item", d.id === activeId && "active")}
                  onClick={() => {
                    setActiveId(d.id);
                    setSideOpen(false);
                  }}
                >
                  <div className="cs-title">{dialogTitle(d, t("chat.newDialog"))}</div>
                  <div className="cs-meta">
                    <span className="mono">{d.modelId}</span>
                    <span>{formatRelative(d.updatedAt, t)}</span>
                  </div>
                </button>
                <button
                  className="cs-item-menu"
                  aria-label={t("common.actions")}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuForId(menuForId === d.id ? null : d.id);
                  }}
                >
                  <MoreHorizontal size={14} />
                </button>
                {menuForId === d.id && (
                  <div className="cs-item-pop" onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => handleRename(d.id)}>
                      <Pencil size={13} /> {t("common.rename")}
                    </button>
                    <button className="danger" onClick={() => handleDelete(d.id)}>
                      <Trash2 size={13} /> {t("common.delete")}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </aside>
      )}

      <div className="chat-main">
        <div className="chat-head">
          {(isMobile ? !sideOpen : sideCollapsed) && (
            <button
              className="expand-side"
              title={t("chat.dialogsExpand")}
              onClick={() => {
                if (isMobile) setSideOpen(true);
                else setSideCollapsed(false);
              }}
            >
              <Menu size={18} />
            </button>
          )}
          <div className="chat-title">
            <div className="ct-name">
              {activeDialog ? dialogTitle(activeDialog, t("chat.newDialog")) : t("chat.newDialog")}
            </div>
            <div className="ct-sub">
              {messagesLoading
                ? t("chat.loadingHistory")
                : messages.length === 0
                  ? t("chat.startNew")
                  : t("chat.messagesCount", { count: messages.length })}
            </div>
          </div>
          <div className="ch-actions">
            <button className="btn btn-ghost btn-sm" onClick={newChat}>
              <Plus size={15} /> {t("chat.newShort")}
            </button>
            {!isMobile && activeDialog && (
              <button className="btn btn-ghost btn-sm" disabled title={t("chat.exportSoon")}>
                <Download size={15} /> Export
              </button>
            )}
          </div>
        </div>

        <div className="chat-scroll" ref={scrollRef}>
          {messages.length === 0 && !messagesLoading ? (
            <div className="chat-empty">
              <div className="ce-mark">
                <Sparkles size={28} />
              </div>
              <h2>{t("chat.startNew")}</h2>
              <p>{t("chat.startNewHint")}</p>
              <div className="ce-suggest">
                {STARTER_PROMPTS.map((s) => (
                  <button key={s} onClick={() => setDraft(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="chat-thread">
              {messages.map((m, i) => {
                if (m.role === "ai")
                  return <AiChatMessage key={`${i}.${m.localId}.ai`} message={m} />;
                return <UserChatMessage key={`${i}.${m.localId}.user`} message={m} />;
              })}

              {messagesLoading && (
                <div className="msg ai">
                  <div className="ai-mark">
                    <Sparkles size={16} />
                  </div>
                  <div className="bubble">
                    <span className="msg-typing">{t("common.loading")}</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {sendError && (
          <div className="chat-error">
            <span>{sendError}</span>
            <button onClick={() => setSendError(null)} aria-label={t("common.close")}>
              <X size={14} />
            </button>
          </div>
        )}

        <div className="composer">
          <div className="composer-inner">
            {pendingAttachments.length > 0 && (
              <div className="composer-attachments">
                {pendingAttachments.map((p) => (
                  <PendingChip key={p.id} pending={p} onRemove={() => removePending(p.id)} />
                ))}
              </div>
            )}
            <div className="composer-row">
              <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPT_MIMES}
                multiple
                style={{ display: "none" }}
                onChange={(e) => {
                  handleFiles(e.target.files);
                  // Сбрасываем value чтобы повторный пик того же файла сработал.
                  e.target.value = "";
                }}
              />
              <button
                className="tool"
                title={t("chat.promptAttach")}
                onClick={openFilePicker}
                disabled={sending}
              >
                <Paperclip size={18} />
              </button>
              <textarea
                ref={taRef}
                placeholder={t("chat.promptPlaceholder")}
                value={draft}
                rows={1}
                onInput={autosize}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              <button
                className="send"
                disabled={
                  (!draft.trim() && readyAttachments.length === 0) || sending || uploadingCount > 0
                }
                onClick={send}
                title={
                  sending
                    ? t("chat.sending")
                    : uploadingCount > 0
                      ? t("chat.waitUploads")
                      : t("chat.send")
                }
              >
                {sending ? <RefreshCw size={18} className="anim-spin" /> : <ArrowUp size={18} />}
              </button>
            </div>
            <div className="composer-foot">
              <div
                ref={modelPickRef}
                className="model-pick"
                onClick={() => setModelOpen(!modelOpen)}
              >
                <span className="mp-dot" />
                <span className="mp-name">
                  {selectedModel ? modelDisplayName(selectedModel) : t("common.loading")}
                </span>
                <ChevronDown size={13} />
                {modelOpen && (
                  <div className="mp-pop" onClick={(e) => e.stopPropagation()}>
                    {chatModels.map((m) => (
                      <button
                        key={m.id}
                        className={clsx("mp-row", m.id === modelId && "on")}
                        onClick={() => {
                          setModelId(m.id);
                          setModelOpen(false);
                        }}
                      >
                        <span className="mp-row-name">
                          {modelDisplayName(m)}
                          {m.id === modelId && <Check size={12} />}
                        </span>
                        <span className="mp-row-rate mono">{modelRate(m)}</span>
                        <span className="mp-row-desc">{modelDesc(m)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
							{/* TODO: add here tokens usage */}
              <span className="hint" style={{ marginLeft: "auto" }}>
                ~ <span className="mono">{Math.max(1, Math.round(draft.length / 4))}</span>{" "}
                {t("chat.tokensEst")}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function messageDtoToMsg(m: MessageDto): Msg {
  return {
    role: m.role === "user" ? "user" : "ai",
    text: m.content,
    ...(m.attachments && m.attachments.length > 0 ? { attachments: m.attachments } : {}),
  };
}

function formatBytes(bytes: number | null | undefined, t: (k: string) => string): string {
  if (!bytes || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} ${t("chat.byteShort")}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} ${t("chat.kbShort")}`;
  return `${(bytes / 1024 / 1024).toFixed(1)} ${t("chat.mbShort")}`;
}

/** Chip pending-загрузки в composer'е (uploading / ready / error). */
function PendingChip({ pending, onRemove }: { pending: PendingAttachment; onRemove: () => void }) {
  const { t } = useTranslation();
  const isImage =
    pending.status === "ready"
      ? pending.dto.kind === "image"
      : pending.file.type.startsWith("image/");
  // Для uploading-state делаем локальный preview через ObjectURL, чтобы юзер
  // видел картинку сразу, не дожидаясь S3-presigned. ObjectURL чистим на unmount.
  const previewUrl = useObjectUrl(pending.file, isImage);
  const finalUrl = pending.status === "ready" ? pending.dto.url : null;
  const url = finalUrl || previewUrl;
  return (
    <div
      className={
        "att-chip" +
        (pending.status === "error" ? " att-chip-error" : "") +
        (pending.status === "uploading" ? " att-chip-loading" : "")
      }
    >
      <div className="att-chip-icon">
        {isImage && url ? (
          <img src={url} alt={pending.file.name} />
        ) : isImage ? (
          <ImageIcon size={14} />
        ) : (
          <FileIcon size={14} />
        )}
      </div>
      <div className="att-chip-body">
        <div className="att-chip-name" title={pending.file.name}>
          {pending.file.name}
        </div>
        <div className="att-chip-meta">
          {pending.status === "uploading"
            ? t("chat.uploading")
            : pending.status === "error"
              ? pending.error
              : formatBytes(pending.file.size, t)}
        </div>
      </div>
      <button className="att-chip-remove" onClick={onRemove} aria-label={t("chat.removeFile")}>
        <X size={12} />
      </button>
    </div>
  );
}

/** Chip уже-сохранённого вложения внутри bubble треда. */
function AttachmentChip({ attachment }: { attachment: MessageAttachmentDto }) {
  const { t } = useTranslation();
  const isImage = attachment.kind === "image" && !!attachment.url;
  if (isImage) {
    // Картинку показываем превью с возможностью открыть полноразмер.
    return (
      <a
        href={attachment.url ?? "#"}
        target="_blank"
        rel="noreferrer"
        className="att-chip att-chip-image"
        title={attachment.name}
      >
        <img src={attachment.url ?? undefined} alt={attachment.name} />
      </a>
    );
  }
  const inner = (
    <>
      <div className="att-chip-icon">
        <FileIcon size={14} />
      </div>
      <div className="att-chip-body">
        <div className="att-chip-name" title={attachment.name}>
          {attachment.name}
        </div>
        <div className="att-chip-meta">{formatBytes(attachment.size, t)}</div>
      </div>
    </>
  );
  return attachment.url ? (
    <a
      href={attachment.url}
      target="_blank"
      rel="noreferrer"
      className="att-chip att-chip-link"
      title={attachment.name}
    >
      {inner}
    </a>
  ) : (
    <div className="att-chip">{inner}</div>
  );
}

/** Создаёт ObjectURL для локального File-preview, чистит при размонтировании. */
function useObjectUrl(file: File, enabled: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file, enabled]);
  return url;
}

function AiChatMessage({ message }: { message: Msg }) {
  return (
    <div className="msg ai rise">
      <div className="msg-block">
        {message.attachments && message.attachments.length > 0 && (
          <div className="msg-attachments">
            {message.attachments.map((a, ai) => (
              <AttachmentChip key={a.s3Key + ai} attachment={a} />
            ))}
          </div>
        )}

        {message.text.length === 0 && <div className="msg-typing">...</div>}

        <Markdown
          components={markdownComponents}
          rehypePlugins={[rehypeSanitize]}
          remarkPlugins={[remarkGfm]}
        >
          {message.text}
        </Markdown>

        {message.meta && (
          <div className="msg-meta">
            <span>{message.meta}</span>
            <div className="msg-actions">
              <button title="Copy" onClick={() => navigator.clipboard?.writeText(message.text)}>
                <Copy size={14} />
              </button>
              <button title="More">
                <MoreHorizontal size={14} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function UserChatMessage({ message }: { message: Msg }) {
  return (
    <div className="msg user rise">
      <div className="msg-block">
        {message.attachments && message.attachments.length > 0 && (
          <div className="msg-attachments">
            {message.attachments.map((a, ai) => (
              <AttachmentChip key={a.s3Key + ai} attachment={a} />
            ))}
          </div>
        )}
        <div className="bubble">
          {message.text.split("\n\n").map((p, k) => (
            <p key={k} style={{ margin: k === 0 ? 0 : "10px 0 0" }}>
              {p}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}
