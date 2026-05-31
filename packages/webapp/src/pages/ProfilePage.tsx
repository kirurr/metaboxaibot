import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { api } from "../api/client.js";
import { useI18n } from "../i18n.js";
import type { TranslationKey } from "../i18n.js";
// import { BannerSlider } from "../components/BannerSlider.js";
import type { UserProfile, GalleryItem, GalleryFolder, Model, ModelSettingDef } from "../types.js";
import { openExternalLink, closeMiniApp } from "../utils/telegram.js";
import { SETTING_TRANSLATIONS } from "@metabox/shared-browser";
import { StyledSelect } from "../components/management/StyledSelect.js";
import { AvatarsPage } from "./AvatarsPage.js";

export type ProfileTab = "overview" | "gallery" | "account" | "avatars";

/**
 * Format a token amount with dynamic precision so small values never show as 0.00.
 * ≥ 0.01  → 2 decimal places  (e.g. 0.29, 12.50)
 * ≥ 0.001 → 3 decimal places  (e.g. 0.005)
 * < 0.001 → 4 decimal places  (e.g. 0.0003)
 */
function formatTokens(value: string | number): string {
  const n = Number(value);
  const abs = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  if (abs === 0) return "0.00";
  if (abs >= 0.01) return sign + abs.toFixed(2);
  if (abs >= 0.001) return sign + abs.toFixed(3);
  return sign + abs.toFixed(4);
}

const REASON_KEYS: Record<string, string> = {
  welcome_bonus: "profile.reason.welcome_bonus",
  ai_usage: "profile.reason.ai_usage",
  purchase: "profile.reason.purchase",
  metabox_purchase: "profile.reason.metabox_purchase",
  referral_bonus: "profile.reason.referral_bonus",
  admin: "profile.reason.admin",
  autotranslate: "profile.reason.autotranslate",
  describe_image: "profile.reason.describe_image",
  soul_creation: "profile.reason.soul_creation",
};

export function ProfilePage({
  initialSection,
  onGoToManagement,
}: {
  initialSection?: ProfileTab;
  onGoToManagement?: (section: string, modelId: string) => void;
}) {
  const { t } = useI18n();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ProfileTab>(initialSection ?? "overview");

  useEffect(() => {
    api.profile
      .get()
      .then(setProfile)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="page-loading">{t("common.loading")}</div>;
  if (error) return <div className="page-error">{error}</div>;
  if (!profile) return null;

  const firstName = profile.firstName ?? profile.username ?? `User ${profile.id.slice(-4)}`;
  const displayName = profile.lastName ? `${firstName} ${profile.lastName}` : firstName;

  return (
    <div className="page">
      {/* <BannerSlider /> */}

      <div className="profile-header">
        <div className="profile-avatar">{displayName[0].toUpperCase()}</div>
        <div className="profile-name">{displayName}</div>
        {profile.username && <div className="profile-username">@{profile.username}</div>}
      </div>

      <div className="profile-tabs">
        <button
          className={`profile-tabs__btn${activeTab === "overview" ? " profile-tabs__btn--active" : ""}`}
          onClick={() => setActiveTab("overview")}
        >
          {t("profile.tabOverview")}
        </button>
        <button
          className={`profile-tabs__btn${activeTab === "gallery" ? " profile-tabs__btn--active" : ""}`}
          onClick={() => setActiveTab("gallery")}
        >
          {t("profile.tabGallery")}
        </button>
        <button
          className={`profile-tabs__btn${activeTab === "account" ? " profile-tabs__btn--active" : ""}`}
          onClick={() => setActiveTab("account")}
        >
          {t("profile.tabAccount")}
        </button>
        <button
          className={`profile-tabs__btn${activeTab === "avatars" ? " profile-tabs__btn--active" : ""}`}
          onClick={() => setActiveTab("avatars")}
        >
          {t("profile.tabAvatars")}
        </button>
      </div>

      {activeTab === "overview" && <OverviewTab profile={profile} />}
      {activeTab === "gallery" && <GalleryTab onGoToManagement={onGoToManagement} />}
      {activeTab === "account" && <AccountTab profile={profile} />}
      {activeTab === "avatars" && <AvatarsPage />}
    </div>
  );
}

/* ── Subscription Countdown ────────────────────────────────────────────────── */

function useCountdown(endDate: string) {
  const { t, locale } = useI18n();
  const [text, setText] = useState("");
  const [urgent, setUrgent] = useState(false);

  useEffect(() => {
    const update = () => {
      const diff = new Date(endDate).getTime() - Date.now();
      if (diff <= 0) {
        setText(t("profile.countdown.expired"));
        setUrgent(true);
        return;
      }
      const days = Math.floor(diff / 86400000);
      const hours = Math.floor((diff % 86400000) / 3600000);
      const minutes = Math.floor((diff % 3600000) / 60000);
      const seconds = Math.floor((diff % 60000) / 1000);

      if (days >= 1) {
        let dayStr: string;
        if (locale === "ru") {
          const w = days === 1 ? "день" : days < 5 ? "дня" : "дней";
          dayStr = `${days} ${w}`;
        } else {
          dayStr = `${days} ${days === 1 ? t("profile.countdown.day") : t("profile.countdown.days")}`;
        }
        setText(dayStr);
        setUrgent(false);
      } else if (hours >= 1) {
        setText(
          t("profile.countdown.hMin").replace("{h}", String(hours)).replace("{m}", String(minutes)),
        );
        setUrgent(true);
      } else {
        setText(
          t("profile.countdown.minSec")
            .replace("{m}", String(minutes))
            .replace("{s}", String(seconds)),
        );
        setUrgent(true);
      }
    };
    update();
    const diff = new Date(endDate).getTime() - Date.now();
    const interval = setInterval(update, diff < 86400000 ? 1000 : 60000);
    return () => clearInterval(interval);
  }, [endDate, t, locale]);

  return { text, urgent };
}

/* ── Overview Tab ──────────────────────────────────────────────────────────── */

function OverviewTab({ profile }: { profile: UserProfile }) {
  const { t, locale } = useI18n();
  const sub = profile.subscription;
  const progressPct = sub ? Math.max(0, Math.min(100, (sub.daysLeft / sub.totalDays) * 100)) : 0;
  const countdown = useCountdown(sub?.endDate ?? "");

  return (
    <>
      <div className="balance-card">
        <div className="balance-card__label">{t("profile.balance")}</div>
        <div className="balance-card__amount">✦ {formatTokens(profile.tokenBalance)}</div>
        <div className="balance-card__breakdown">
          <span className="balance-card__breakdown-item">
            {t("profile.balanceSubscription")}: ✦ {formatTokens(profile.subscriptionTokenBalance)}
          </span>
          <span className="balance-card__breakdown-item">
            {t("profile.balancePurchased")}: ✦ {formatTokens(profile.purchasedTokenBalance)}
          </span>
        </div>
        <div className="balance-card__sub">
          {t("profile.referrals")}: {profile.referralCount}
        </div>
      </div>

      {sub && (
        <div className="sub-card">
          <div className="sub-card__header">
            <span className="sub-card__plan">{sub.planName}</span>
            <span className="sub-card__period">{sub.period}</span>
          </div>
          <div className="sub-card__days">
            <span
              className={`sub-card__days-left${countdown.urgent ? " sub-card__days-left--urgent" : ""}`}
            >
              {countdown.text}
            </span>
            <span className="sub-card__end-date">
              {t("profile.until")}{" "}
              {new Date(sub.endDate).toLocaleDateString(locale === "ru" ? "ru-RU" : "en-US")}
            </span>
          </div>
          <div className="sub-card__bar">
            <div className="sub-card__bar-fill" style={{ width: `${progressPct}%` }} />
          </div>
        </div>
      )}

      <div className="section-title">{t("profile.txHistory")}</div>
      {profile.transactions.length === 0 ? (
        <div className="empty-state">{t("profile.noTx")}</div>
      ) : (
        <ul className="tx-list">
          {profile.transactions.map((tx) => (
            <li key={tx.id} className="tx-item">
              <div className="tx-item__info">
                <span className="tx-item__reason">
                  {tx.description ||
                    (REASON_KEYS[tx.reason]
                      ? t(REASON_KEYS[tx.reason] as TranslationKey)
                      : tx.reason)}
                </span>
                {tx.modelId && tx.reason !== "purchase" && (
                  // Для покупок (subscription/token-package) в modelId лежит
                  // внутренний product/plan-id, который пользователю ничего
                  // не говорит — description выше уже описывает покупку
                  // понятным текстом. Показываем modelId только для AI-debit'ов
                  // (ai_usage / autotranslate / describe_image и т.п.).
                  <span className="tx-item__model">{tx.modelId}</span>
                )}
                <span className="tx-item__date">{new Date(tx.createdAt).toLocaleDateString()}</span>
              </div>
              <span className={`tx-item__amount tx-item__amount--${tx.type}`}>
                {tx.type === "credit" ? "+" : ""}
                {formatTokens(tx.amount)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/* ── Gallery Tab ───────────────────────────────────────────────────────────── */

const SECTIONS = ["image", "audio", "video"] as const;
type Section = (typeof SECTIONS)[number];

function sortFolders(arr: GalleryFolder[]): GalleryFolder[] {
  return [...arr].sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    if (a.isPinned && b.isPinned) {
      const pa = a.pinnedAt ?? "";
      const pb = b.pinnedAt ?? "";
      if (pa !== pb) return pa < pb ? -1 : 1;
    }
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function GalleryTab({
  onGoToManagement,
}: {
  onGoToManagement?: (section: string, modelId: string) => void;
}) {
  const { t } = useI18n();
  const [section, setSection] = useState<Section>("image");
  const [modelFilter, setModelFilter] = useState<string | null>(null);
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailsItem, setDetailsItem] = useState<GalleryItem | null>(null);
  // modelId → Model — used by the details modal to render setting labels and
  // option labels (settings page-style) instead of raw key/value strings.
  // Cached per section visit; refreshed when the active section chip changes.
  const [modelsById, setModelsById] = useState<Record<string, Model>>({});
  const [modelCounts, setModelCounts] = useState<Record<string, number>>({});

  // Folders state
  const [folders, setFolders] = useState<GalleryFolder[]>([]);
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const [folderModalItem, setFolderModalItem] = useState<GalleryItem | null>(null);
  const [editFolder, setEditFolder] = useState<GalleryFolder | null>(null);
  const [folderSelectOpen, setFolderSelectOpen] = useState(false);
  const [createFolderOpen, setCreateFolderOpen] = useState(false);
  const pendingFolderItemRef = useRef<GalleryItem | null>(null);

  const LIMIT = 20;

  const sectionLabels: Record<Section, string> = {
    image: `🎨 ${t("gallery.section.image")}`,
    audio: `🎧 ${t("gallery.section.audio")}`,
    video: `🎬 ${t("gallery.section.video")}`,
  };

  const loadFolders = useCallback(() => {
    api.gallery.folders
      .list()
      .then(setFolders)
      .catch(() => void 0);
  }, []);

  useEffect(() => {
    loadFolders();
  }, [loadFolders]);

  const resolveModelIdsForFilter = useCallback(
    (filter: string | null): { modelId?: string; modelIds?: string } => {
      if (!filter) return {};
      if (filter.startsWith("family:")) {
        const familyId = filter.slice(7);
        const ids = Object.values(modelsById)
          .filter((m) => m.familyId === familyId)
          .map((m) => m.id);
        return ids.length > 0 ? { modelIds: ids.join(",") } : {};
      }
      return { modelId: filter };
    },
    [modelsById],
  );

  const load = useCallback(
    (sec: Section, pg: number, mid: string | null, folderId: string | null) => {
      setLoading(true);
      setError(null);
      const modelParams = resolveModelIdsForFilter(mid);
      api.gallery
        .list({
          section: sec,
          page: pg,
          limit: LIMIT,
          ...modelParams,
          folderId: folderId ?? undefined,
        })
        .then((res) => {
          setItems(res.items);
          setTotal(res.total);
        })
        .catch((err: Error) => setError(err.message))
        .finally(() => setLoading(false));
    },
    [resolveModelIdsForFilter],
  );

  useEffect(() => {
    load(section, page, modelFilter, activeFolderId);
  }, [section, page, modelFilter, activeFolderId, load]);

  // Fetch model definitions + per-model generation counts on section change.
  // Failure is silent — the modal falls back to raw key/value rendering when
  // models are missing, and the select shows unsorted models when counts fail.
  // Note: gallery jobs use section "image" in the DB but model definitions
  // live under section "design" (legacy naming).
  useEffect(() => {
    let cancelled = false;
    const apiSection = section === "image" ? "design" : section;
    Promise.allSettled([api.models.list(apiSection), api.gallery.modelCounts(section)]).then(
      ([modelsResult, countsResult]) => {
        if (cancelled) return;
        if (modelsResult.status === "fulfilled") {
          const modelMap: Record<string, Model> = {};
          for (const m of modelsResult.value) modelMap[m.id] = m;
          setModelsById((prev) => ({ ...prev, ...modelMap }));
        }
        if (countsResult.status === "fulfilled") {
          const countMap: Record<string, number> = {};
          for (const c of countsResult.value) countMap[c.modelId] = c.count;
          setModelCounts((prev) => ({ ...prev, ...countMap }));
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [section]);

  const handleSectionChange = (sec: Section) => {
    setSection(sec);
    setModelFilter(null);
    setPage(1);
  };

  const handleModelFilterChange = (mid: string | null) => {
    setModelFilter(mid);
    setPage(1);
  };

  const handleFolderChange = (folderId: string | null) => {
    setActiveFolderId(folderId);
    setPage(1);
  };

  const handleSend = useCallback(async (outputId: string) => {
    await api.gallery.sendOutput(outputId);
  }, []);

  const handleDelete = useCallback(
    async (outputId: string) => {
      // Удаляем один output. Если это был последний в джобе — бэк снесёт всю
      // джобу (`jobDeleted: true`); локально просто фильтруем карточку.
      await api.gallery.deleteOutput(outputId);
      setItems((prev) => prev.filter((it) => it.id !== outputId));
      setTotal((prev) => Math.max(0, prev - 1));
      loadFolders();
    },
    [loadFolders],
  );

  const handleToggleFavorite = useCallback(
    async (item: GalleryItem) => {
      const favFolder = folders.find((f) => f.isDefault);
      const isFav = favFolder ? item.folderIds.includes(favFolder.id) : false;

      if (isFav && favFolder) {
        await api.gallery.favorites.remove(item.id);
        if (activeFolderId === favFolder.id) {
          setItems((prev) => prev.filter((it) => it.id !== item.id));
          setTotal((prev) => Math.max(0, prev - 1));
        } else {
          setItems((prev) =>
            prev.map((it) =>
              it.id === item.id
                ? { ...it, folderIds: it.folderIds.filter((id) => id !== favFolder.id) }
                : it,
            ),
          );
        }
        setFolders((prev) =>
          prev.map((f) => (f.id === favFolder.id ? { ...f, itemCount: f.itemCount - 1 } : f)),
        );
      } else {
        const { folderId } = await api.gallery.favorites.add(item.id);
        setItems((prev) =>
          prev.map((it) =>
            it.id === item.id ? { ...it, folderIds: [...it.folderIds, folderId] } : it,
          ),
        );
        const favAlreadyExists = folders.some((f) => f.id === folderId);
        setFolders((prev) => {
          if (!prev.find((f) => f.id === folderId)) return prev;
          return prev.map((f) => (f.id === folderId ? { ...f, itemCount: f.itemCount + 1 } : f));
        });
        if (!favAlreadyExists) {
          loadFolders();
        }
      }
    },
    [folders, activeFolderId, loadFolders],
  );

  const totalPages = Math.ceil(total / LIMIT);
  const favFolder = folders.find((f) => f.isDefault);

  const activeSectionKey = section === "image" ? "design" : section;

  const pickerOptions = useMemo(() => {
    const allModels = Object.values(modelsById).filter((m) => m.section === activeSectionKey);
    const familyCountMap = new Map<string, number>();
    for (const m of allModels) {
      if (m.familyId) {
        familyCountMap.set(
          m.familyId,
          (familyCountMap.get(m.familyId) ?? 0) + (modelCounts[m.id] ?? 0),
        );
      }
    }
    const seenFamilies = new Set<string>();
    const opts: { value: string; label: string; count: number }[] = [];
    for (const m of allModels) {
      if (m.familyId) {
        if (!seenFamilies.has(m.familyId)) {
          seenFamilies.add(m.familyId);
          opts.push({
            value: `family:${m.familyId}`,
            label: m.familyName ?? m.familyId,
            count: familyCountMap.get(m.familyId) ?? 0,
          });
        }
      } else {
        opts.push({ value: m.id, label: m.name, count: modelCounts[m.id] ?? 0 });
      }
    }
    return opts.sort((a, b) => b.count - a.count);
  }, [modelsById, modelCounts, activeSectionKey]);

  return (
    <>
      {/* Section chips */}
      <div className="gallery-folders" style={{ marginTop: 8 }}>
        {SECTIONS.map((sec) => (
          <button
            key={sec}
            className={`chip${section === sec ? " chip--active" : ""}`}
            onClick={() => handleSectionChange(sec)}
          >
            {sectionLabels[sec]}
          </button>
        ))}
      </div>

      {/* Folder chips */}
      <div className="gallery-folders">
        <button
          className={`chip${activeFolderId === null ? " chip--active" : ""}`}
          onClick={() => handleFolderChange(null)}
        >
          {t("gallery.folder.all")}
        </button>
        {folders.map((folder) => (
          <button
            key={folder.id}
            className={`chip${activeFolderId === folder.id ? " chip--active" : ""}`}
            onClick={() => handleFolderChange(folder.id)}
          >
            {folder.isDefault
              ? `♥ ${t("gallery.folder.favorites")}`
              : folder.isPinned
                ? `⭐ ${folder.name}`
                : folder.name}
            {folder.itemCount > 0 && (
              <span className="gallery-folders__count">{folder.itemCount}</span>
            )}
          </button>
        ))}
        <button
          className="chip gallery-folders__add"
          onClick={() => setCreateFolderOpen(true)}
          aria-label={t("gallery.folder.new")}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
        {folders.some((f) => !f.isDefault) && (
          <button
            className="chip gallery-folders__add"
            onClick={() => setFolderSelectOpen(true)}
            aria-label={t("gallery.folder.selectTitle")}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1.464 1.464 0 01-2.105.872l-.31-.17c-1.283-.698-2.686.705-1.987 1.987l.169.311c.446.82.023 1.841-.872 2.105l-.34.1c-1.4.413-1.4 2.397 0 2.81l.34.1a1.464 1.464 0 01.872 2.105l-.17.31c-.698 1.283.705 2.686 1.987 1.987l.311-.169a1.464 1.464 0 012.105.872l.1.34c.413 1.4 2.397 1.4 2.81 0l.1-.34a1.464 1.464 0 012.105-.872l.31.17c1.283.698 2.686-.705 1.987-1.987l-.169-.311a1.464 1.464 0 01.872-2.105l.34-.1c1.4-.413 1.4-2.397 0-2.81l-.34-.1a1.464 1.464 0 01-.872-2.105l.17-.31c.698-1.283-.705-2.686-1.987-1.987l-.311.169a1.464 1.464 0 01-2.105-.872l-.1-.34zM8 10.93a2.929 2.929 0 110-5.86 2.929 2.929 0 010 5.858z" />
            </svg>
          </button>
        )}
      </div>

      {pickerOptions.length > 0 && (
        <StyledSelect
          style={{ display: "inline-block" }}
          value={modelFilter ?? ""}
          onChange={(v) => handleModelFilterChange(v === "" ? null : v)}
          options={[
            { value: "", label: t("gallery.allModels") },
            ...pickerOptions.map((opt) => ({ value: opt.value, label: opt.label })),
          ]}
        />
      )}

      {loading && <div className="page-loading">{t("common.loading")}</div>}
      {error && <div className="page-error">{error}</div>}

      {!loading && !error && items.length === 0 && modelFilter !== null && (
        <div className="gallery-empty-model">
          <p className="gallery-empty-model__text">{t("gallery.emptyModel")}</p>
          {onGoToManagement && (
            <button
              className="btn btn--primary"
              onClick={() => onGoToManagement(activeSectionKey, modelFilter)}
            >
              {t("gallery.tryModel")}
            </button>
          )}
        </div>
      )}

      {!loading && !error && items.length === 0 && modelFilter === null && (
        <div className="empty-state">
          {activeFolderId ? t("gallery.folder.empty") : t("gallery.empty")}
        </div>
      )}

      {!loading && items.length > 0 && (
        <div className={`gallery-grid${section === "image" ? " gallery-grid--2col" : ""}`}>
          {items.map((item) => (
            <GalleryCard
              key={item.id}
              item={item}
              isFavorited={favFolder ? item.folderIds.includes(favFolder.id) : false}
              onSend={handleSend}
              onDelete={handleDelete}
              onOpenDetails={setDetailsItem}
              onToggleFavorite={handleToggleFavorite}
              onAddToFolder={setFolderModalItem}
            />
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="pagination">
          <button
            className="pagination__btn"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
          >
            {t("admin.prevPage")}
          </button>
          <span className="pagination__info">
            {page} / {totalPages}
          </span>
          <button
            className="pagination__btn"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
          >
            {t("admin.nextPage")}
          </button>
        </div>
      )}

      {detailsItem &&
        createPortal(
          <GalleryDetailsModal
            item={detailsItem}
            model={modelsById[detailsItem.modelId] ?? null}
            onClose={() => setDetailsItem(null)}
          />,
          document.body,
        )}

      {folderModalItem &&
        createPortal(
          <FolderPickerModal
            item={folderModalItem}
            folders={folders}
            onClose={() => setFolderModalItem(null)}
            onUpdate={(updatedItem) => {
              setFolderModalItem(updatedItem);
              setItems((prev) => prev.map((it) => (it.id === updatedItem.id ? updatedItem : it)));
              loadFolders();
            }}
            onCreateFolder={() => {
              pendingFolderItemRef.current = folderModalItem;
              setFolderModalItem(null);
              setCreateFolderOpen(true);
            }}
          />,
          document.body,
        )}

      {createFolderOpen &&
        createPortal(
          <FolderEditModal
            folder={null}
            onClose={() => {
              pendingFolderItemRef.current = null;
              setCreateFolderOpen(false);
            }}
            onSave={async (name) => {
              const created = await api.gallery.folders.create(name);
              setFolders((prev) => sortFolders([...prev, created]));
              setCreateFolderOpen(false);
              if (pendingFolderItemRef.current) {
                setFolderModalItem(pendingFolderItemRef.current);
                pendingFolderItemRef.current = null;
              }
            }}
          />,
          document.body,
        )}

      {folderSelectOpen &&
        createPortal(
          <FolderSelectModal
            folders={folders.filter((f) => !f.isDefault)}
            onClose={() => setFolderSelectOpen(false)}
            onSelect={(folder: GalleryFolder) => {
              setFolderSelectOpen(false);
              setEditFolder(folder);
            }}
          />,
          document.body,
        )}

      {editFolder &&
        createPortal(
          <FolderEditModal
            folder={editFolder}
            onClose={() => setEditFolder(null)}
            onSave={async (name, isPinned) => {
              const updated = await api.gallery.folders.update(editFolder.id, { name, isPinned });
              setFolders((prev) =>
                sortFolders(
                  prev.map((f) =>
                    f.id === updated.id ? { ...f, ...updated, itemCount: f.itemCount } : f,
                  ),
                ),
              );
              setEditFolder(null);
            }}
            onDelete={async () => {
              await api.gallery.folders.delete(editFolder.id);
              setFolders((prev) => prev.filter((f) => f.id !== editFolder.id));
              if (activeFolderId === editFolder.id) handleFolderChange(null);
              setEditFolder(null);
            }}
          />,
          document.body,
        )}
    </>
  );
}

/* ── Folder Picker Modal ───────────────────────────────────────────────────── */

function FolderPickerModal({
  item,
  folders,
  onClose,
  onUpdate,
  onCreateFolder,
}: {
  item: GalleryItem;
  folders: GalleryFolder[];
  onClose: () => void;
  onUpdate: (item: GalleryItem) => void;
  onCreateFolder: () => void;
}) {
  const { t } = useI18n();
  const [pending, setPending] = useState<string | null>(null);

  const toggle = async (folder: GalleryFolder) => {
    if (pending) return;
    setPending(folder.id);
    const isIn = item.folderIds.includes(folder.id);
    try {
      if (isIn) {
        await api.gallery.folders.removeItem(folder.id, item.id);
        onUpdate({ ...item, folderIds: item.folderIds.filter((id) => id !== folder.id) });
      } else {
        await api.gallery.folders.addItem(folder.id, item.id);
        onUpdate({ ...item, folderIds: [...item.folderIds, folder.id] });
      }
    } catch {
      // silent
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="modal-close" onClick={onClose} aria-label="close">
          ×
        </button>
        <div className="modal-title">{t("gallery.folder.addToFolder")}</div>
        <ul className="folder-picker__list">
          {folders.map((folder) => {
            const checked = item.folderIds.includes(folder.id);
            return (
              <li key={folder.id}>
                <button
                  type="button"
                  className={`folder-picker__item${checked ? " folder-picker__item--checked" : ""}`}
                  onClick={() => void toggle(folder)}
                  disabled={pending === folder.id}
                >
                  <span className="folder-picker__check">{checked ? "✓" : ""}</span>
                  <span className="folder-picker__name">
                    {folder.isDefault ? `♥ ${folder.name}` : folder.name}
                  </span>
                  {pending === folder.id && <span className="folder-picker__spinner">…</span>}
                </button>
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          className="btn btn--ghost folder-picker__create"
          onClick={onCreateFolder}
        >
          + {t("gallery.folder.createFirst")}
        </button>
        <div className="modal-actions">
          <button type="button" className="btn btn--primary" onClick={onClose}>
            {t("gallery.folder.done")}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Folder Select Modal ───────────────────────────────────────────────────── */

function FolderSelectModal({
  folders,
  onClose,
  onSelect,
}: {
  folders: GalleryFolder[];
  onClose: () => void;
  onSelect: (folder: GalleryFolder) => void;
}) {
  const { t } = useI18n();

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="modal-close" onClick={onClose} aria-label="close">
          ×
        </button>
        <div className="modal-title">{t("gallery.folder.selectTitle")}</div>
        <ul className="folder-picker__list">
          {folders.map((folder) => (
            <li key={folder.id}>
              <button
                type="button"
                className="folder-picker__item"
                onClick={() => onSelect(folder)}
              >
                <span className="folder-picker__name">
                  {folder.isPinned ? `⭐ ${folder.name}` : folder.name}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/* ── Folder Edit / Create Modal ────────────────────────────────────────────── */

function FolderEditModal({
  folder,
  onClose,
  onSave,
  onDelete,
}: {
  folder: GalleryFolder | null;
  onClose: () => void;
  onSave: (name: string, isPinned?: boolean) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(folder?.name ?? "");
  const [isPinned, setIsPinned] = useState(folder?.isPinned ?? false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const isCreate = folder === null;

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await onSave(name.trim(), isCreate ? undefined : isPinned);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!onDelete) return;
    setDeleting(true);
    try {
      await onDelete();
    } finally {
      setDeleting(false);
    }
  };

  if (confirmDelete) {
    return (
      <div className="modal-overlay" onClick={() => !deleting && setConfirmDelete(false)}>
        <div className="modal-card" onClick={(e) => e.stopPropagation()}>
          <div className="modal-title">{t("gallery.folder.deleteConfirmTitle")}</div>
          <div className="modal-text">{t("gallery.folder.deleteConfirmText")}</div>
          <div className="modal-actions">
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => setConfirmDelete(false)}
              disabled={deleting}
            >
              {t("gallery.folder.cancel")}
            </button>
            <button
              type="button"
              className="btn btn--danger"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? "…" : t("gallery.folder.delete")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="modal-close" onClick={onClose} aria-label="close">
          ×
        </button>
        <div className="modal-title">
          {isCreate ? t("gallery.folder.createTitle") : t("gallery.folder.editTitle")}
        </div>
        <input
          className="folder-edit__input"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("gallery.folder.namePlaceholder")}
          onKeyDown={(e) => e.key === "Enter" && void handleSave()}
        />
        {!isCreate && (
          <button
            type="button"
            className={`folder-edit__pin-btn${isPinned ? " folder-edit__pin-btn--active" : ""}`}
            onClick={() => setIsPinned((v) => !v)}
          >
            ⭐ {isPinned ? t("gallery.folder.unpin") : t("gallery.folder.pin")}
          </button>
        )}
        <div className="modal-actions">
          {!isCreate && onDelete && (
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => setConfirmDelete(true)}
            >
              {t("gallery.folder.delete")}
            </button>
          )}
          <button
            type="button"
            className="btn btn--primary"
            onClick={handleSave}
            disabled={saving || !name.trim()}
          >
            {saving ? "…" : t("gallery.folder.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Module-level handle to the single audio element currently playing across all
 * gallery cards. Starting a new playback invokes `stop` on the previous one so
 * overlapping clips are not possible.
 */
let activeGalleryAudio: { stop: () => void } | null = null;

function AudioPlayButton({
  resolveUrl,
  title,
}: {
  resolveUrl: () => Promise<string>;
  title: string;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);

  const stop = () => {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlaying(false);
    setLoading(false);
  };

  useEffect(() => {
    return () => {
      if (activeGalleryAudio?.stop === stop) activeGalleryAudio = null;
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, []);

  const toggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (playing || loading) {
      stop();
      if (activeGalleryAudio?.stop === stop) activeGalleryAudio = null;
      return;
    }
    // Halt any other card that is currently playing before we start.
    activeGalleryAudio?.stop();
    activeGalleryAudio = { stop };

    setLoading(true);
    let url: string;
    try {
      url = await resolveUrl();
    } catch {
      setLoading(false);
      if (activeGalleryAudio?.stop === stop) activeGalleryAudio = null;
      return;
    }
    const audio = new Audio(url);
    audioRef.current = audio;
    audio.addEventListener(
      "canplay",
      () => {
        setLoading(false);
        setPlaying(true);
      },
      { once: true },
    );
    audio.onended = () => {
      setPlaying(false);
      if (activeGalleryAudio?.stop === stop) activeGalleryAudio = null;
    };
    audio.play().catch(() => {
      setLoading(false);
      setPlaying(false);
      if (activeGalleryAudio?.stop === stop) activeGalleryAudio = null;
    });
  };

  return (
    <button
      className={`voice-picker__play-btn${playing ? " voice-picker__play-btn--playing" : ""}${loading ? " voice-picker__play-btn--loading" : ""}`}
      onClick={toggle}
      title={title}
    >
      {loading ? "⏳" : playing ? "⏹" : "▶"}
    </button>
  );
}

function GalleryCard({
  item,
  isFavorited,
  onSend,
  onDelete,
  onOpenDetails,
  onToggleFavorite,
  onAddToFolder,
}: {
  item: GalleryItem;
  isFavorited: boolean;
  onSend: (outputId: string) => Promise<void>;
  onDelete: (outputId: string) => Promise<void>;
  onOpenDetails: (item: GalleryItem) => void;
  onToggleFavorite: (item: GalleryItem) => Promise<void>;
  onAddToFolder: (item: GalleryItem) => void;
}) {
  const { t, locale } = useI18n();
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imgError, setImgError] = useState(false);
  // Local skeleton until <img> actually decodes — swapped to the real bitmap
  // on `onLoad`, cleared on `onError` so the placeholder doesn't hang forever.
  const [imgLoaded, setImgLoaded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoLoading, setVideoLoading] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [downloadingLightbox, setDownloadingLightbox] = useState(false);
  const [favLoading, setFavLoading] = useState(false);

  const isImage = item.section === "image";
  const isVideo = item.section === "video";
  const isAudio = item.section === "audio";

  const handleSend = async () => {
    setLoading(true);
    setError(null);
    try {
      await onSend(item.id);
      setSent(true);
      setTimeout(() => setSent(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const openVideo = async () => {
    if (videoLoading || videoUrl) return;
    setVideoLoading(true);
    try {
      const res = await api.gallery.previewUrl(item.id);
      setVideoUrl(res.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setVideoLoading(false);
    }
  };

  const resolveAudioUrl = async () => {
    const res = await api.gallery.previewUrl(item.id);
    return res.url;
  };

  const downloadLightboxOriginal = async () => {
    setDownloadingLightbox(true);
    try {
      const { url } = await api.gallery.originalUrl(item.id);
      openExternalLink(url);
    } catch {
      // silent
    } finally {
      setDownloadingLightbox(false);
    }
  };

  const handleConfirmDelete = async () => {
    setDeleting(true);
    try {
      await onDelete(item.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const handleToggleFavoriteClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (favLoading) return;
    setFavLoading(true);
    try {
      await onToggleFavorite(item);
    } finally {
      setFavLoading(false);
    }
  };

  const imageSrc = item.thumbnailUrl ?? item.previewUrl ?? item.outputUrl ?? "";

  return (
    <div className="gallery-card">
      <div className="gallery-card__top-actions">
        <button
          type="button"
          className={`gallery-card__fav${isFavorited ? " gallery-card__fav--active" : ""}`}
          onClick={handleToggleFavoriteClick}
          disabled={favLoading}
          title={isFavorited ? t("gallery.removeFromFav") : t("gallery.addToFav")}
          aria-label="Favorites"
        >
          {isFavorited ? "♥" : "♡"}
        </button>
        <button
          type="button"
          className="gallery-card__folder-btn"
          onClick={(e) => {
            e.stopPropagation();
            onAddToFolder(item);
          }}
          title={t("gallery.folder.addToFolder")}
          aria-label={t("gallery.folder.addToFolder")}
        >
          <svg width="13" height="11" viewBox="0 0 13 11" fill="currentColor" aria-hidden="true">
            <path d="M0 2.5A1.5 1.5 0 011.5 1H5l1.5 1.5H11.5A1.5 1.5 0 0113 4v5.5A1.5 1.5 0 0111.5 11h-10A1.5 1.5 0 010 9.5v-7z" />
          </svg>
        </button>
        <button
          type="button"
          className="gallery-card__delete"
          onClick={() => setConfirmDelete(true)}
          title={t("gallery.delete")}
          aria-label={t("gallery.delete")}
        >
          ×
        </button>
      </div>

      {isImage ? (
        <div
          className="gallery-card__preview"
          onClick={() => setLightboxOpen(true)}
          style={{ cursor: "zoom-in" }}
        >
          {!imgLoaded && imageSrc && <div className="gallery-skeleton" />}
          {!imgError && imageSrc && (
            <img
              src={imageSrc}
              alt={item.prompt}
              loading="lazy"
              onLoad={() => setImgLoaded(true)}
              onError={() => {
                setImgError(true);
                setImgLoaded(true);
              }}
            />
          )}
        </div>
      ) : isVideo ? (
        <div
          className="gallery-card__preview gallery-card__preview--video"
          onClick={openVideo}
          role="button"
          tabIndex={0}
        >
          {item.thumbnailUrl && !imgLoaded && <div className="gallery-skeleton" />}
          {item.thumbnailUrl && !imgError ? (
            <img
              src={item.thumbnailUrl}
              alt={item.prompt}
              loading="lazy"
              onLoad={() => setImgLoaded(true)}
              onError={() => {
                setImgError(true);
                setImgLoaded(true);
              }}
            />
          ) : (
            <div className="gallery-card__placeholder">🎬</div>
          )}
          <div className="gallery-card__video-overlay">{videoLoading ? "⏳" : "▶"}</div>
        </div>
      ) : isAudio ? (
        <div className="gallery-card__preview gallery-card__preview--audio">
          <AudioPlayButton resolveUrl={resolveAudioUrl} title={t("uploads.play")} />
        </div>
      ) : null}

      <div className="gallery-card__body">
        {isImage ? (
          // Design cards run two-up in a grid, so the single-row meta strip
          // overflows. Stack model / date vertically and drop the
          // prompt preview entirely — it's available in the details modal.
          <div className="gallery-card__meta gallery-card__meta--stacked">
            <span className="gallery-card__model" title={item.modelName}>
              {item.modelName}
            </span>
            {item.completedAt && (
              <span className="gallery-card__date">
                {new Date(item.completedAt).toLocaleDateString(locale === "ru" ? "ru-RU" : "en-US")}
              </span>
            )}
          </div>
        ) : (
          <>
            <div className="gallery-card__meta">
              <div className="gallery-card__model-row">
                <span className="gallery-card__model" title={item.modelName}>
                  {item.modelName}
                </span>
              </div>
              {item.completedAt && (
                <span className="gallery-card__date">
                  {new Date(item.completedAt).toLocaleDateString(
                    locale === "ru" ? "ru-RU" : "en-US",
                  )}
                </span>
              )}
            </div>
            <p className="gallery-card__prompt">{item.prompt}</p>
          </>
        )}
        {error && <p className="gallery-card__error">{error}</p>}
        <div className="gallery-card__actions">
          <button
            className={`gallery-card__btn${sent ? " gallery-card__btn--sent" : ""}`}
            onClick={handleSend}
            disabled={loading || sent}
          >
            {loading ? "…" : sent ? t("gallery.sent") : t("gallery.download")}
          </button>
          <button
            type="button"
            className="gallery-card__btn gallery-card__btn--secondary"
            onClick={() => onOpenDetails(item)}
          >
            {t("gallery.details")}
          </button>
        </div>
      </div>

      {confirmDelete &&
        createPortal(
          <div className="modal-overlay" onClick={() => !deleting && setConfirmDelete(false)}>
            <div className="modal-card" onClick={(e) => e.stopPropagation()}>
              <div className="modal-title">{t("gallery.confirmDeleteTitle")}</div>
              <div className="modal-text">{t("gallery.confirmDeleteText")}</div>
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => setConfirmDelete(false)}
                  disabled={deleting}
                >
                  {t("gallery.cancel")}
                </button>
                <button
                  type="button"
                  className="btn btn--danger"
                  onClick={handleConfirmDelete}
                  disabled={deleting}
                >
                  {deleting ? "…" : t("gallery.confirmDelete")}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
      {videoUrl &&
        createPortal(
          <div className="modal-overlay" onClick={() => setVideoUrl(null)}>
            <div className="video-modal" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className="modal-close"
                onClick={() => setVideoUrl(null)}
                aria-label="Close"
              >
                ×
              </button>
              <video src={videoUrl} controls autoPlay playsInline className="video-modal__player" />
            </div>
          </div>,
          document.body,
        )}
      {lightboxOpen &&
        createPortal(
          <div
            className="modal-overlay gallery-lightbox-overlay"
            onClick={() => setLightboxOpen(false)}
          >
            <div className="gallery-lightbox" onClick={(e) => e.stopPropagation()}>
              <div className="gallery-lightbox__header">
                <button
                  type="button"
                  className="gallery-lightbox__close"
                  onClick={() => setLightboxOpen(false)}
                  aria-label="Close"
                >
                  ×
                </button>
              </div>
              <img
                src={item.previewUrl ?? item.outputUrl ?? ""}
                alt={item.prompt}
                className="gallery-lightbox__img"
              />
              {error && <p className="gallery-card__error">{error}</p>}
              <div className="gallery-lightbox__actions">
                <button
                  type="button"
                  className={`gallery-card__btn${sent ? " gallery-card__btn--sent" : ""}`}
                  onClick={handleSend}
                  disabled={loading || sent}
                >
                  {loading ? "…" : sent ? t("gallery.sent") : t("gallery.download")}
                </button>
                <button
                  type="button"
                  className="gallery-card__btn"
                  onClick={() => void downloadLightboxOriginal()}
                  disabled={downloadingLightbox}
                >
                  {downloadingLightbox ? "…" : t("gallery.downloadOriginal")}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

// ── Setting display helpers ──────────────────────────────────────────────────

/** Picker companion fields — internal IDs/URLs without a user-visible meaning. */
const ALWAYS_HIDDEN_SETTING_KEYS = new Set([
  "voice_provider",
  "talking_photo_id",
  // Defensive: hide legacy avatar one-shot keys still present in some users'
  // modelSettings JSON from before the migration to mediaInputs.avatar_photo
  // (commit 1ff95dc). No code writes to them anymore — entry can be dropped
  // after a one-time DB cleanup.
  "avatar_photo_url",
  "avatar_photo_s3key",
  "image_asset_id", // surfaced via the avatar-picker fallback below
]);

const OPENAI_VOICE_NAMES: Record<string, string> = {
  alloy: "Alloy",
  ash: "Ash",
  coral: "Coral",
  echo: "Echo",
  fable: "Fable",
  nova: "Nova",
  onyx: "Onyx",
  sage: "Sage",
  shimmer: "Shimmer",
};

interface PickerCatalogs {
  heygenVoices?: Map<string, string>;
  didVoices?: Map<string, string>;
  elevenlabsVoices?: Map<string, string>;
  cartesiaVoices?: Map<string, string>;
  /** Cloned voices keyed by externalId AND by local UserVoice.id (for Cartesia
   *  pickers that persist the local id вместо external). */
  userVoices?: Map<string, string>;
  heygenAvatars?: Map<string, string>;
  /** HeyGen-uploaded photos keyed by externalId (matches image_asset_id). */
  userAvatarsHeygen?: Map<string, string>;
  /** HiggsField souls keyed by externalId (matches custom_reference_id). */
  userAvatarsHiggsfield?: Map<string, string>;
  motions?: Map<string, string>;
  soulStyles?: Map<string, string>;
}

function GalleryDetailsModal({
  item,
  model,
  onClose,
}: {
  item: GalleryItem;
  model: Model | null;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const [downloading, setDownloading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalogs, setCatalogs] = useState<PickerCatalogs>({});
  const [catalogsLoaded, setCatalogsLoaded] = useState(false);

  // Fetch picker catalogs (voices/avatars/motions/styles) needed to resolve
  // ID-shaped setting values into friendly names. Only the catalogs the
  // model actually uses are fetched, in parallel. Failures are silent — the
  // affected entries fall through to "—" or stay hidden.
  useEffect(() => {
    if (!model) {
      setCatalogsLoaded(true);
      return;
    }
    let cancelled = false;
    const types = new Set(model.settings.map((s) => s.type));
    const next: PickerCatalogs = {};
    const tasks: Promise<unknown>[] = [];

    const add = <T,>(p: Promise<T>, set: (data: T) => void) => {
      tasks.push(p.then((data) => !cancelled && set(data)).catch(() => void 0));
    };

    if (types.has("voice-picker")) {
      add(api.heygenVoices.list(), (data) => {
        next.heygenVoices = new Map(data.map((v) => [v.voice_id, v.name]));
      });
    }
    if (types.has("did-voice-picker")) {
      add(api.didVoices.list(), (data) => {
        next.didVoices = new Map(data.map((v) => [v.id, v.name]));
      });
    }
    if (types.has("elevenlabs-voice-picker")) {
      add(api.elevenlabsVoices.list(), (data) => {
        next.elevenlabsVoices = new Map(data.map((v) => [v.voice_id, v.name]));
      });
    }
    if (types.has("cartesia-voice-picker")) {
      add(api.cartesiaVoices.list(), (data) => {
        next.cartesiaVoices = new Map(data.map((v) => [v.voice_id, v.name]));
      });
    }
    if (
      types.has("voice-picker") ||
      types.has("did-voice-picker") ||
      types.has("elevenlabs-voice-picker") ||
      types.has("cartesia-voice-picker")
    ) {
      // Без provider-фильтра: showname-резолв нужен для всех клонированных
      // голосов юзера (Cartesia + legacy ElevenLabs). Индексируем и по
      // externalId, и по локальному UserVoice.id — Cartesia-picker сохраняет
      // именно локальный id, тогда как старые EL-записи могут быть на externalId.
      add(api.userVoices.list(), (data) => {
        const map = new Map<string, string>();
        for (const v of data) {
          if (v.externalId) map.set(v.externalId, v.name);
          map.set(v.id, v.name);
        }
        next.userVoices = map;
      });
    }
    if (types.has("avatar-picker")) {
      add(api.heygenAvatars.list({}), (data) => {
        next.heygenAvatars = new Map(data.items.map((a) => [a.avatar_id, a.avatar_name]));
      });
      add(api.userAvatars.list("heygen"), (data) => {
        next.userAvatarsHeygen = new Map(
          data.map((a) => [a.externalId ?? a.id, a.name] as [string, string]),
        );
      });
    }
    if (types.has("motion-picker")) {
      add(api.higgsfieldMotions.list(), (data) => {
        next.motions = new Map(data.map((m) => [m.id, m.name]));
      });
    }
    if (types.has("soul-picker")) {
      add(api.userAvatars.list("higgsfield_soul"), (data) => {
        next.userAvatarsHiggsfield = new Map(
          data.map((a) => [a.externalId ?? a.id, a.name] as [string, string]),
        );
      });
    }
    if (types.has("soul-style-picker")) {
      add(api.soulStyles.list(), (data) => {
        next.soulStyles = new Map(data.map((s) => [s.id, s.name]));
      });
    }

    Promise.all(tasks).finally(() => {
      if (cancelled) return;
      setCatalogs(next);
      setCatalogsLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [model]);

  // Build human-readable settings entries. Picker IDs are looked up in
  // `catalogs`; failures and never-useful companion keys are dropped from the
  // list entirely so the user only sees meaningful rows.
  const settingLocale = SETTING_TRANSLATIONS[locale] ?? SETTING_TRANSLATIONS["en"] ?? {};
  const rawSettings = item.modelSettings ?? {};

  const resolvePickerValue = (def: ModelSettingDef, value: unknown): string | null => {
    if (def.type === "motion-picker") {
      if (!Array.isArray(value) || value.length === 0) return null;
      return (
        value
          .map((m) => {
            const entry = m as { id?: string; strength?: number };
            const name = (entry.id && catalogs.motions?.get(entry.id)) ?? entry.id ?? "";
            if (!name) return null;
            return entry.strength !== undefined ? `${name} (${entry.strength})` : name;
          })
          .filter((s): s is string => !!s)
          .join(", ") || null
      );
    }
    if (typeof value !== "string" || !value) return null;
    if (def.type === "voice-picker") {
      return catalogs.heygenVoices?.get(value) ?? catalogs.userVoices?.get(value) ?? null;
    }
    if (def.type === "did-voice-picker") {
      return catalogs.didVoices?.get(value) ?? catalogs.userVoices?.get(value) ?? null;
    }
    if (def.type === "elevenlabs-voice-picker") {
      return catalogs.elevenlabsVoices?.get(value) ?? catalogs.userVoices?.get(value) ?? null;
    }
    if (def.type === "cartesia-voice-picker") {
      return catalogs.cartesiaVoices?.get(value) ?? catalogs.userVoices?.get(value) ?? null;
    }
    if (def.type === "openai-voice-picker") {
      return OPENAI_VOICE_NAMES[value] ?? value;
    }
    if (def.type === "avatar-picker") {
      return catalogs.heygenAvatars?.get(value) ?? catalogs.userAvatarsHeygen?.get(value) ?? null;
    }
    if (def.type === "soul-picker") {
      return catalogs.userAvatarsHiggsfield?.get(value) ?? null;
    }
    if (def.type === "soul-style-picker") {
      return catalogs.soulStyles?.get(value) ?? null;
    }
    return null;
  };

  const formatValue = (def: ModelSettingDef | undefined, value: unknown): string => {
    if (Array.isArray(value)) return value.map((v) => formatValue(def, v)).join(", ");
    if (
      def?.options &&
      (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    ) {
      const opt = def.options.find((o) => o.value === value);
      if (opt) {
        const settingT = settingLocale[def.key];
        return settingT?.options?.[String(opt.value)] ?? opt.label;
      }
    }
    if (typeof value === "boolean") return value ? "✓" : "—";
    if (typeof value === "object" && value !== null) return JSON.stringify(value);
    return String(value);
  };

  type Entry = { key: string; label: string; value: string };
  const entries: Entry[] = [];
  const seenKeys = new Set<string>();

  // Pass 1: walk the model's setting defs in their declared order so the
  // displayed list mirrors the order on the settings page.
  for (const def of model?.settings ?? []) {
    seenKeys.add(def.key);

    let raw: unknown = rawSettings[def.key];
    // Avatar-picker stores either avatar_id (official) or image_asset_id
    // (uploaded photo) — fall back to the latter so the row is not lost.
    if (def.type === "avatar-picker") {
      seenKeys.add("image_asset_id");
      if ((raw === "" || raw === null || raw === undefined) && rawSettings.image_asset_id) {
        raw = rawSettings.image_asset_id;
      }
    }

    if (raw === null || raw === undefined || raw === "") continue;
    if (Array.isArray(raw) && raw.length === 0) continue;

    const isPicker =
      def.type === "voice-picker" ||
      def.type === "did-voice-picker" ||
      def.type === "elevenlabs-voice-picker" ||
      def.type === "cartesia-voice-picker" ||
      def.type === "openai-voice-picker" ||
      def.type === "avatar-picker" ||
      def.type === "motion-picker" ||
      def.type === "soul-picker" ||
      def.type === "soul-style-picker";

    const label = settingLocale[def.key]?.label ?? def.label;
    let valueStr: string | null;
    if (isPicker) {
      // Picker still loading? show a placeholder so the row reserves space.
      if (!catalogsLoaded) valueStr = "…";
      else valueStr = resolvePickerValue(def, raw);
    } else {
      valueStr = formatValue(def, raw);
    }
    if (valueStr === null || valueStr === "") continue;
    entries.push({ key: def.key, label, value: valueStr });
  }

  // Pass 2: any keys present in modelSettings but missing from the current
  // model definition (setting may have been removed since — например, при
  // смене провайдера у модели). Локальный словарь может быть пустым (ru),
  // поэтому фоллбек: locale → en → raw key. Без второго шага русские юзеры
  // видят сырое имя ключа на старых джобах.
  const settingLocaleEn = SETTING_TRANSLATIONS["en"] ?? {};
  for (const [key, value] of Object.entries(rawSettings)) {
    if (seenKeys.has(key)) continue;
    if (ALWAYS_HIDDEN_SETTING_KEYS.has(key)) continue;
    if (value === null || value === undefined || value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    const label = settingLocale[key]?.label ?? settingLocaleEn[key]?.label ?? key;
    entries.push({ key, label, value: formatValue(undefined, value) });
  }

  const settingsEntries = entries;

  const downloadOriginal = async () => {
    setDownloading(true);
    setError(null);
    try {
      const { url } = await api.gallery.originalUrl(item.id);
      openExternalLink(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(false);
    }
  };

  const handleApplySettings = async () => {
    setApplying(true);
    setError(null);
    try {
      // Build the object to persist: start from the current model's defaults,
      // layer the generation's recorded settings on top, then drop one-shot
      // upload fields (voice/photo URLs etc.) that shouldn't carry over. The
      // backend `replace: true` then overwrites the saved per-model config
      // wholesale, so stale keys the user had before don't survive the apply.
      const fullSettings: Record<string, unknown> = {};
      if (model) {
        for (const def of model.settings) {
          if (def.default !== null && def.default !== undefined)
            fullSettings[def.key] = def.default;
        }
      }
      for (const [k, v] of Object.entries(item.modelSettings ?? {})) {
        if (ALWAYS_HIDDEN_SETTING_KEYS.has(k)) continue;
        fullSettings[k] = v;
      }
      await api.modelSettings.set(item.modelId, fullSettings, { replace: true });
      setApplied(true);
      setTimeout(() => setApplied(false), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  };

  const handleCopyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(item.prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card gallery-modal" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="modal-close" onClick={onClose} aria-label="close">
          ×
        </button>
        <h3 className="modal-title">{item.modelName}</h3>

        <div className="gallery-modal__section">
          <div className="gallery-modal__label">{t("gallery.prompt")}</div>
          <div className="gallery-modal__prompt">{item.prompt}</div>
        </div>

        <div className="gallery-modal__section">
          <div className="gallery-modal__label">{t("gallery.settings")}</div>
          {settingsEntries.length === 0 ? (
            <div className="gallery-modal__settings">{t("gallery.noSettings")}</div>
          ) : (
            <div className="gallery-modal__settings">
              {settingsEntries.map((entry) => (
                <div key={entry.key} className="gallery-modal__setting-row">
                  <span className="gallery-modal__setting-key">{entry.label}</span>
                  <span className="gallery-modal__setting-val">{entry.value}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {error && <div className="gallery-modal__error">❌ {error}</div>}

        <div className="gallery-modal__actions">
          <button
            type="button"
            className="gallery-card__btn"
            onClick={downloadOriginal}
            disabled={downloading}
          >
            {downloading ? "…" : t("gallery.downloadOriginal")}
          </button>
          <button
            type="button"
            className={`gallery-card__btn${applied ? " gallery-card__btn--sent" : ""}`}
            onClick={handleApplySettings}
            disabled={applying || applied}
          >
            {applying ? "…" : applied ? t("gallery.applied") : t("gallery.applySettings")}
          </button>
          <button
            type="button"
            className={`gallery-card__btn gallery-card__btn--secondary${
              copied ? " gallery-card__btn--sent" : ""
            }`}
            onClick={handleCopyPrompt}
          >
            {copied ? t("gallery.copied") : t("gallery.copyPrompt")}
          </button>
        </div>

        <div className="gallery-modal__retention-note">{t("gallery.retentionNote")}</div>
      </div>
    </div>
  );
}

/* ── Account tab ────────────────────────────────────────────────────────── */

interface AccountData {
  balance: number;
  totalEarned: number;
  userStatus: string;
  referralCode: string | null;
  email: string | null;
  mentor: {
    name: string;
    email: string | null;
    telegramUsername: string | null;
    telegramPhone: string | null;
  } | null;
}

function AccountTab(props: { profile: UserProfile }) {
  const { t } = useI18n();
  const [data, setData] = useState<AccountData | null>(null);
  const [confirmBeforeGenerate, setConfirmBeforeGenerate] = useState<boolean>(
    props.profile.confirmBeforeGenerate,
  );
  const [autoActivateModel, setAutoActivateModel] = useState<boolean>(
    props.profile.autoActivateModel,
  );
  const [showGenerationModeInfo, setShowGenerationModeInfo] = useState(false);
  const [showAutoActivateInfo, setShowAutoActivateInfo] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showDeleteInstruction, setShowDeleteInstruction] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleDeleteAccount = async () => {
    setDeleting(true);
    try {
      await api.account.initiateDelete();
      setShowDeleteConfirm(false);
      setShowDeleteInstruction(true);
    } catch {
      // оставляем confirm-модалку открытой; кнопки не блокируем — юзер может попробовать снова
    } finally {
      setDeleting(false);
    }
  };

  useEffect(() => {
    api.profile
      .partnerBalance()
      .then((d) => setData(d as unknown as AccountData))
      .catch(() => {});
  }, []);

  const handleConfirmBeforeGenerateChange = async (next: boolean) => {
    setConfirmBeforeGenerate(next);
    try {
      await api.profile.updatePreferences({ confirmBeforeGenerate: next });
    } catch {
      setConfirmBeforeGenerate(!next);
    }
  };

  const handleAutoActivateModelChange = async (next: boolean) => {
    setAutoActivateModel(next);
    try {
      await api.profile.updatePreferences({ autoActivateModel: next });
    } catch {
      setAutoActivateModel(!next);
    }
  };

  return (
    <div className="account-tab">
      {/* Generation mode toggle */}
      <div className="account-section">
        <div className="account-label account-label--with-info">
          <span>{t("account.generationMode")}</span>
          <button
            type="button"
            className="account-info-btn"
            onClick={() => setShowGenerationModeInfo(true)}
            aria-label={t("account.generationModeInfoAria")}
          >
            i
          </button>
        </div>
        <div className="account-value account-toggle-stack">
          <label className="settings-panel__toggle-label">
            <input
              type="checkbox"
              checked={confirmBeforeGenerate}
              onChange={(e) => handleConfirmBeforeGenerateChange(e.target.checked)}
            />
            <span className="settings-panel__toggle-track" />
          </label>
          <span className="account-toggle-state">
            {confirmBeforeGenerate ? t("account.generationModeOn") : t("account.generationModeOff")}
          </span>
        </div>
      </div>

      {showGenerationModeInfo && (
        <div className="modal-overlay" onClick={() => setShowGenerationModeInfo(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="modal-close"
              onClick={() => setShowGenerationModeInfo(false)}
              aria-label="close"
            >
              ×
            </button>
            <div className="modal-title">{t("account.generationMode")}</div>
            <div className="modal-text account-info-text">{t("account.generationModeInfo")}</div>
          </div>
        </div>
      )}

      {/* Model auto-activation toggle */}
      <div className="account-section">
        <div className="account-label account-label--with-info">
          <span>{t("account.autoActivateModel")}</span>
          <button
            type="button"
            className="account-info-btn"
            onClick={() => setShowAutoActivateInfo(true)}
            aria-label={t("account.autoActivateModelInfoAria")}
          >
            i
          </button>
        </div>
        <div className="account-value account-toggle-stack">
          <label className="settings-panel__toggle-label">
            <input
              type="checkbox"
              checked={autoActivateModel}
              onChange={(e) => handleAutoActivateModelChange(e.target.checked)}
            />
            <span className="settings-panel__toggle-track" />
          </label>
          <span className="account-toggle-state">
            {autoActivateModel
              ? t("account.autoActivateModelOn")
              : t("account.autoActivateModelOff")}
          </span>
        </div>
      </div>

      {showAutoActivateInfo && (
        <div className="modal-overlay" onClick={() => setShowAutoActivateInfo(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="modal-close"
              onClick={() => setShowAutoActivateInfo(false)}
              aria-label="close"
            >
              ×
            </button>
            <div className="modal-title">{t("account.autoActivateModel")}</div>
            <div className="modal-text account-info-text">{t("account.autoActivateModelInfo")}</div>
          </div>
        </div>
      )}

      {/* Email */}
      <div className="account-section">
        <div className="account-label">Email</div>
        <div className="account-value">
          {data?.email ? (
            <span>{data.email}</span>
          ) : (
            <span className="account-hint">{t("account.notLinked")}</span>
          )}
        </div>
      </div>

      {/* Status */}
      <div className="account-section">
        <div className="account-label">{t("account.status")}</div>
        <div className="account-value">
          {data?.userStatus === "PARTNER"
            ? t("account.statusPartner")
            : data?.userStatus === "CLIENT"
              ? t("account.statusClient")
              : t("account.statusUser")}
        </div>
      </div>

      {/* Mentor */}
      {data?.mentor && (
        <div className="account-section">
          <div className="account-label">{t("account.mentor")}</div>
          <div className="account-value">
            <div className="account-mentor-name">{data.mentor.name}</div>
            {data.mentor.telegramUsername ? (
              <a
                href={`https://t.me/${data.mentor.telegramUsername}`}
                target="_blank"
                rel="noopener noreferrer"
                className="account-mentor-link"
              >
                @{data.mentor.telegramUsername}
              </a>
            ) : data.mentor.telegramPhone ? (
              <a
                href={`https://t.me/+${data.mentor.telegramPhone.replace(/^\+/, "")}`}
                target="_blank"
                rel="noopener noreferrer"
                className="account-mentor-link"
              >
                {data.mentor.telegramPhone}
              </a>
            ) : data.mentor.email ? (
              <div className="account-mentor-email">{data.mentor.email}</div>
            ) : null}
          </div>
        </div>
      )}

      {/* Referral code */}
      {data?.referralCode && (
        <div className="account-section">
          <div className="account-label">{t("account.referralCode")}</div>
          <div className="account-value account-value--mono">{data.referralCode}</div>
        </div>
      )}

      {/* Danger zone — мягкая dashed-кнопка с красной обводкой (стилистика
          .voice-picker__create-btn). Реальное подтверждение в модалке ниже,
          которая уже содержит явное предупреждение и btn--danger «Удалить». */}
      <div className="account-section">
        <button className="account-delete-btn" onClick={() => setShowDeleteConfirm(true)}>
          {t("account.deleteAccount")}
        </button>
      </div>

      {/* Confirm-модалка */}
      {showDeleteConfirm &&
        createPortal(
          <div className="modal-overlay" onClick={() => !deleting && setShowDeleteConfirm(false)}>
            <div className="modal-card" onClick={(e) => e.stopPropagation()}>
              <div className="modal-title">{t("account.deleteAccountTitle")}</div>
              <div className="modal-text" style={{ whiteSpace: "pre-line" }}>
                {t("account.deleteAccountText")}
              </div>
              <div className="modal-actions">
                <button
                  className="btn btn--secondary"
                  onClick={() => setShowDeleteConfirm(false)}
                  disabled={deleting}
                >
                  {t("gallery.cancel")}
                </button>
                <button
                  className="btn btn--danger"
                  onClick={() => void handleDeleteAccount()}
                  disabled={deleting}
                >
                  {deleting ? "…" : t("account.deleteAccountConfirm")}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {/* Instruction-модалка после initiate */}
      {showDeleteInstruction &&
        createPortal(
          <div className="modal-overlay" onClick={() => setShowDeleteInstruction(false)}>
            <div className="modal-card" onClick={(e) => e.stopPropagation()}>
              <div className="modal-title">{t("account.deleteCheckBotTitle")}</div>
              <div className="modal-text">{t("account.deleteCheckBotText")}</div>
              <div className="modal-actions">
                <button
                  className="btn btn--primary"
                  onClick={() => {
                    // Закрываем модалку как fallback — если closeMiniApp
                    // не сработает (старый клиент без WebApp.close), юзер
                    // хотя бы не останется с открытой instruction-модалкой.
                    setShowDeleteInstruction(false);
                    closeMiniApp();
                  }}
                >
                  {t("account.deleteCheckBotClose")}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
