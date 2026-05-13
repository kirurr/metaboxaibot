import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  Copy,
  Download,
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
import type { DialogDto, MessageDto } from "@/api/dialogs";
import type { WebModelDto } from "@/api/models";
import { ApiError } from "@/api/client";

type Msg = {
  role: "user" | "ai";
  text: string;
  meta?: string;
  /** Локальный id для оптимистичных user-сообщений (бэк не возвращает их id до done). */
  localId?: string;
};

const SECTION = "gpt";

const STARTER_PROMPTS = [
  "Напиши план запуска продукта",
  "Объясни этот код строка за строкой",
  "Придумай название для бренда чая",
  "Сожми финансовый отчёт в 5 пунктов",
];

function modelDisplayName(m: WebModelDto): string {
  return m.familyName ?? m.name;
}
function modelDesc(m: WebModelDto): string {
  return m.descriptionOverride ?? m.description;
}
function modelRate(m: WebModelDto): string {
  const n = Math.round(m.tokenCostApprox / 10) * 10;
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

function dialogTitle(d: DialogDto): string {
  return d.title ?? "Новый диалог";
}

/** "сейчас" / "5м" / "2ч" / "Yest" / "Mon" / "Apr 28" — компактная подпись справа от треда. */
function formatRelative(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "сейчас";
  if (diffMin < 60) return `${diffMin}м`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}ч`;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const dayStart = new Date(d);
  dayStart.setHours(0, 0, 0, 0);
  const diffDays = Math.floor((today.getTime() - dayStart.getTime()) / 86_400_000);
  if (diffDays === 1) return "Вчера";
  if (diffDays < 7) {
    return ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"][d.getDay()];
  }
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

/**
 * Чат — sidebar c реальными диалогами пользователя (через `/web/dialogs`),
 * активная сессия с подгрузкой истории и SSE-стримом ответа.
 *
 * Все запросы под `webTelegramLinkedPreHandler` — если Telegram не привязан,
 * модалка открывается автоматически из `apiClient`.
 */
export default function Chat() {
  const isMobile = useIsMobile();
  const location = useLocation();
  const prefill = (location.state as { prefill?: string } | null)?.prefill ?? "";

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

  const sideVisible = isMobile ? sideOpen : !sideCollapsed;
  const sideRef = useRef<HTMLElement | null>(null);
  const modelPickRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
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
    setSideOpen(false);
    setTimeout(() => taRef.current?.focus(), 0);
  }

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    if (!selectedModel) {
      setSendError("Модель ещё не загрузилась");
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
        setSendError(e.message || "Не удалось создать диалог");
        return;
      }
    }

    // 2) Оптимистично добавляем user-сообщение + пустой AI-bubble.
    const localId = `local-${Date.now()}`;
    setMessages((m) => [
      ...m,
      { role: "user", text, localId },
      { role: "ai", text: "", localId: localId + ".ai" },
    ]);
    setDraft("");
    setTimeout(autosize, 0);

    // 3) Стримим ответ.
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let tokensUsed = 0;

    try {
      await dialogsApi.streamMessage(
        dialogId,
        text,
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
        setSendError(e.message || "Ошибка отправки");
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
      "Новое название",
      dialogTitle(current ?? ({ title: null } as DialogDto)),
    );
    if (!next || next.trim().length === 0) return;
    const title = next.trim();
    try {
      await dialogsApi.renameDialog(id, title);
      renameInStore(id, title);
    } catch (err) {
      const e = err as ApiError;
      setSendError(e.message || "Не удалось переименовать");
    } finally {
      setMenuForId(null);
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm("Удалить диалог? Историю восстановить нельзя.")) return;
    try {
      await dialogsApi.deleteDialog(id);
      removeFromStore(id);
      if (activeId === id) {
        setActiveId(null);
        setMessages([]);
      }
    } catch (err) {
      const e = err as ApiError;
      setSendError(e.message || "Не удалось удалить");
    } finally {
      setMenuForId(null);
    }
  }

  const filteredDialogs = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return dialogs;
    return dialogs.filter((d) => dialogTitle(d).toLowerCase().includes(q));
  }, [dialogs, search]);

  return (
    <div className={clsx("chat-shell", !isMobile && sideCollapsed && "side-collapsed")}>
      {sideVisible && (
        <aside ref={sideRef} className={clsx("chat-side", sideOpen && "open open-backdrop")}>
          <div className="cs-head">
            <button className="btn btn-primary btn-sm cs-new" onClick={newChat}>
              <Plus size={14} /> Новый диалог
            </button>
            <button
              className="cs-collapse"
              title={isMobile ? "Закрыть" : "Свернуть"}
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
              placeholder="Поиск по диалогам"
            />
          </div>
          <div className="cs-list">
            {!dialogsLoaded && dialogsLoading && <div className="cs-group">Загрузка…</div>}
            {dialogsLoaded && dialogsErrorCode === "TELEGRAM_NOT_LINKED" && (
              <div className="cs-group" style={{ color: "var(--text-secondary)" }}>
                Привяжите Telegram, чтобы видеть историю диалогов.
              </div>
            )}
            {dialogsLoaded && filteredDialogs.length === 0 && !dialogsErrorCode && (
              <div className="cs-group">{search ? "Ничего не найдено" : "Пока нет диалогов"}</div>
            )}
            {filteredDialogs.length > 0 && <div className="cs-group">Недавние</div>}
            {filteredDialogs.map((d) => (
              <div key={d.id} style={{ position: "relative" }}>
                <button
                  className={clsx("cs-item", d.id === activeId && "active")}
                  onClick={() => {
                    setActiveId(d.id);
                    setSideOpen(false);
                  }}
                >
                  <div className="cs-title">{dialogTitle(d)}</div>
                  <div className="cs-meta">
                    <span className="mono">{d.modelId}</span>
                    <span>{formatRelative(d.updatedAt)}</span>
                  </div>
                </button>
                <button
                  className="cs-item-menu"
                  aria-label="Действия"
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
                      <Pencil size={13} /> Переименовать
                    </button>
                    <button className="danger" onClick={() => handleDelete(d.id)}>
                      <Trash2 size={13} /> Удалить
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
              title="Диалоги"
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
              {activeDialog ? dialogTitle(activeDialog) : "Новый диалог"}
            </div>
            <div className="ct-sub">
              {messagesLoading
                ? "Загрузка истории…"
                : messages.length === 0
                  ? "Начните новый диалог"
                  : `${messages.length} сообщений`}
            </div>
          </div>
          <div className="ch-actions">
            <button className="btn btn-ghost btn-sm" onClick={newChat}>
              <Plus size={15} /> Новый
            </button>
            {!isMobile && activeDialog && (
              <button className="btn btn-ghost btn-sm" disabled title="Скоро">
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
              <h2>Начните новый диалог</h2>
              <p>Спросите, попросите написать или проанализировать — модель выбирается ниже.</p>
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
              {messages.map((m, i) => (
                <div key={i} className={"msg " + m.role + " rise"}>
                  {m.role === "ai" && (
                    <div className="ai-mark">
                      <Sparkles size={16} />
                    </div>
                  )}
                  <div style={{ minWidth: 0, flex: m.role === "user" ? "0 1 auto" : "1 1 auto" }}>
                    <div className="bubble">
                      {m.text.length === 0 && m.role === "ai" ? (
                        <span className="msg-typing">…</span>
                      ) : (
                        m.text.split("\n\n").map((p, k) => (
                          <p key={k} style={{ margin: k === 0 ? 0 : "10px 0 0" }}>
                            {p}
                          </p>
                        ))
                      )}
                    </div>
                    {m.role === "ai" && m.meta && (
                      <div className="msg-meta">
                        <span>{m.meta}</span>
                        <div className="msg-actions">
                          <button
                            title="Copy"
                            onClick={() => navigator.clipboard?.writeText(m.text)}
                          >
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
              ))}
              {messagesLoading && (
                <div className="msg ai">
                  <div className="ai-mark">
                    <Sparkles size={16} />
                  </div>
                  <div className="bubble">
                    <span className="msg-typing">Загрузка…</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {sendError && (
          <div className="chat-error">
            <span>{sendError}</span>
            <button onClick={() => setSendError(null)} aria-label="Закрыть">
              <X size={14} />
            </button>
          </div>
        )}

        <div className="composer">
          <div className="composer-inner">
            <div className="composer-row">
              <button className="tool" title="Attach" disabled>
                <Paperclip size={18} />
              </button>
              <textarea
                ref={taRef}
                placeholder="Спросить AI Box…"
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
                disabled={!draft.trim() || sending}
                onClick={send}
                title={sending ? "Отправка…" : "Отправить"}
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
                  {selectedModel ? modelDisplayName(selectedModel) : "Загрузка…"}
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
              <span className="hint" style={{ marginLeft: "auto" }}>
                ~ <span className="mono">{Math.max(1, Math.round(draft.length / 4))}</span> токенов
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
  };
}
