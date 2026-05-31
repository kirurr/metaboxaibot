import clsx from "clsx";
import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useListPromptExamples } from "@/hooks/useListPromptExamples";
import type { PromptExample } from "@/api/promptExamples";
import { ArrowRight, Sparkles, X } from "lucide-react";
import { Button } from "@/components/common/Button";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useUIStore } from "@/stores/uiStore";
import { navigateToGenerate, normalizeSection } from "@/utils/navigateToGenerate";

export type PromptExamplesGalleryProps = {
  /**
   * Зафиксировать секцию (`design` | `video`). Скрывает табы и подгружает только
   * примеры этой секции. Если undefined — табы видны, юзер выбирает.
   */
  section?: "design" | "video";
  /** Скрыть табы фильтра секций (имеет смысл вместе с `section`). */
  hideTypeTabs?: boolean;
  /**
   * Переопределить поведение «Попробовать». Если задан — вызывается вместо
   * navigateToGenerate (например, страница генерации может сначала сохранить
   * текущий черновик и сделать push нового URL сама).
   */
  onApply?: (ex: PromptExample) => void;
};

export function PromptExamplesGallery({
  section,
  hideTypeTabs = false,
  onApply,
}: PromptExamplesGalleryProps) {
  const { t } = useTranslation();
  const [internalType, setInternalType] = useState<string | undefined>(undefined);
  const selectedType = section ?? internalType;
  const { prompts, isLoading, isFetchingNextPage, hasNextPage, fetchNextPage } =
    useListPromptExamples(selectedType);

  const [currentPromptId, setCurrentPromptId] = useState<string | undefined>();
  const currentPrompt = currentPromptId ? prompts.find((p) => p.id === currentPromptId) : undefined;

  const dialogRef = useRef<HTMLDialogElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const pushToast = useUIStore((s) => s.pushToast);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && hasNextPage && !isFetchingNextPage) {
          fetchNextPage();
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const handleDialogOpen = (promptId: string) => {
    if (!dialogRef.current) return;
    dialogRef.current.showModal();
    setCurrentPromptId(promptId);
    document.body.style.overflow = "hidden";
  };

  const handleDialogClose = () => {
    if (!dialogRef.current) return;
    dialogRef.current.close();
    document.body.style.overflow = "";
  };

  const handleTry = (ex: PromptExample) => {
    const sectionRoute = ex.model ? normalizeSection(ex.section) : null;
    if (!sectionRoute || !ex.model) {
      pushToast({ type: "info", message: t("generate.exampleModelUnavailable") });
      return;
    }
    handleDialogClose();
    if (onApply) {
      onApply(ex);
      return;
    }
    const settings =
      ex.modelSettings && typeof ex.modelSettings === "object"
        ? (ex.modelSettings as Record<string, unknown>)
        : undefined;
    navigateToGenerate(navigate, {
      section: sectionRoute,
      modelId: ex.model.id,
      prompt: ex.prompt,
      settings,
    });
  };

  return (
    <>
      {!hideTypeTabs && (
        <div className="auth-tab lg:w-1/2 mx-auto !mb-8">
          <button
            className={clsx(internalType === undefined && "on")}
            onClick={() => setInternalType(undefined)}
          >
            {t("prompts.filters.all")}
          </button>
          <button
            className={clsx(internalType === "design" && "on")}
            onClick={() => setInternalType("design")}
          >
            {t("prompts.filters.images")}
          </button>
          <button
            className={clsx(internalType === "video" && "on")}
            onClick={() => setInternalType("video")}
          >
            {t("prompts.filters.videos")}
          </button>
        </div>
      )}

      <ul className="grid grid-flow-dense grid-cols-2 md:grid-cols-3 lg:grid-cols-5 auto-rows-[200px] lg:auto-rows-[400px] gap-6">
        {isLoading &&
          Array.from({ length: 20 }).map((_, i) => (
            <div key={i} className="p-4 mb-4 skeleton"></div>
          ))}
        {prompts.map((data) => {
          const { tall, wide } = cardVariant(data.id);
          return (
            <PromptCard
              isMobile={isMobile}
              openDialog={() => handleDialogOpen(data.id)}
              data={data}
              key={data.id}
              tall={tall}
              wide={wide}
            />
          );
        })}
      </ul>
      <div ref={sentinelRef} className="h-8" />
      {isFetchingNextPage && <div className="text-center py-2">{t("prompts.loading")}</div>}

      <dialog
        ref={dialogRef}
        onClose={() => {
          document.body.style.overflow = "";
        }}
        onClick={(e) => {
          if (
            e.target === dialogRef.current ||
            e.target === dialogRef.current?.querySelector("#dialog-content-wrapper") ||
            e.target === dialogRef.current?.querySelector("#dialog-image-wrapper")
          ) {
            handleDialogClose();
          }
        }}
        className="
					rise
					p-8
					backdrop:transition-all
					fixed inset-0
					w-screen h-screen
					max-w-none max-h-none
					m-0
					overflow-hidden
					outline-none
					bg-transparent
					backdrop:backdrop-blur
					rounded-[var(--radius)]"
      >
        <div
          id="dialog-content-wrapper"
          className="w-full h-full flex flex-col md:flex-row gap-4 overflow-hidden relative"
        >
          <button
            className="btn btn-ghost btn-icon absolute top-0 md:top-8 right-0 md:left-8 z-50"
            onClick={handleDialogClose}
          >
            <X />
          </button>
          <div
            id="dialog-image-wrapper"
            className="flex flex-col flex-1 min-h-0 md:flex-none w-full md:w-1/2 lg:w-2/3 items-center justify-center"
          >
            {currentPrompt && <MediaCard prompt={currentPrompt} />}
          </div>
          {currentPrompt && (
            <DialogCard
              isMobile={isMobile}
              prompt={currentPrompt}
              onTry={() => handleTry(currentPrompt)}
            />
          )}
        </div>
      </dialog>
    </>
  );
}

function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (Math.imul(31, h) + id.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function cardVariant(id: string): { tall: boolean; wide: boolean } {
  const h = hashId(id);
  const wide = h % 15 === 0;
  const tall = wide || h % 7 === 0;
  return { tall, wide };
}

function PromptCard({
  isMobile,
  data,
  openDialog,
  tall = false,
  wide = false,
}: {
  isMobile: boolean;
  data: PromptExample;
  openDialog: () => void;
  tall?: boolean;
  wide?: boolean;
}) {
  const { t } = useTranslation();
  const [showThumbnail, setShowThumbnail] = useState(true);

  const videoRef = useRef<HTMLVideoElement>(null);

  const handleMouseEnter = () => {
    if (!videoRef.current) return;
    videoRef.current.play();
  };

  const handleMouseLeave = () => {
    if (!videoRef.current) return;
    videoRef.current.pause();
  };

  return (
    <button
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className={clsx(
        `group
					rise
					flex flex-col
					rounded-[var(--radius)]
					relative overflow-hidden
					size-full`,

        tall && "row-span-2",
        wide && "col-span-2",
      )}
      onClick={openDialog}
    >
      {data.section === "design" && (
        <>
          {showThumbnail && (
            <img
              className=" transition-transform absolute object-cover inset-0 size-full"
              src={data.thumbnailUrl ?? "https://picsum.photos/400"}
            />
          )}
          <img
            onLoad={() => setShowThumbnail(false)}
            className=" transition-transform absolute object-cover inset-0 size-full"
            src={data.mediaUrl ?? "https://picsum.photos/400"}
          />
        </>
      )}

      {data.section === "video" && (
        <>
          {showThumbnail && (
            <img
              className=" transition-transform absolute object-cover inset-0 size-full"
              src={data.thumbnailUrl ?? "https://picsum.photos/400"}
            />
          )}
          <video
            ref={videoRef}
            loop
            playsInline
            muted
            disablePictureInPicture
            autoPlay={isMobile}
            preload="none"
            className=" transition-transform absolute object-cover inset-0 size-full"
            onLoadedData={() => setShowThumbnail(false)}
            src={
              data.mediaUrl ??
              "https://d8j0ntlcm91z4.cloudfront.net/user_3CIjqzTsrKEUr8OzFBaYO4ux3nG/hf_20260413_121933_7dfa9582-a536-4a83-9041-ee5aa102ff8c.mp4"
            }
          />
        </>
      )}
      <div
        className="
					btn btn-primary
					opacity-0
					!transition-all
					duration-300
					ease
					transform translate-y-[20px]
					group-hover:opacity-100
					group-hover:translate-y-0
					group-focus-visible:opacity-100
					group-focus-visible:translate-y-0
					w-1/2
					mx-auto
					mb-2
					relative z-10 mt-auto
					safe-top
					"
      >
        <Sparkles /> {t("prompts.tryPrompt")}
      </div>
    </button>
  );
}

function DialogCard({
  prompt,
  isMobile,
  onTry,
}: {
  prompt: PromptExample;
  isMobile: boolean;
  onTry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="shrink-0 md:shrink w-full md:w-1/2 lg:w-1/3 card flex flex-col gap-4 text-white p-4 md:p-8 min-h-0 overflow-hidden">
      <h2 className="h2 text-center shrink-0">{prompt.model?.name}</h2>
      <div className="flex flex-col gap-4 flex-1 min-h-0">
        <h3 className="hidden md:block h3 text-center shrink-0">{t("prompts.promptUsed")}</h3>
        <div className="text-text-secondary text-lg bg-bg-elevated p-4 rounded-[var(--radius)] overflow-y-auto">
          {prompt.prompt}
        </div>
      </div>
      <div className="mt-auto">
        <Button
          className="mt-4 w-full"
          size={isMobile ? "md" : "lg"}
          rightIcon={<ArrowRight />}
          onClick={onTry}
        >
          {t("prompts.tryPromptAndSettings")}
        </Button>
      </div>
    </div>
  );
}

function MediaCard({ prompt }: { prompt: PromptExample }) {
  const [showThumbnail, setShowThumbnail] = useState(true);
  return (
    <div className="w-full h-full md:size-4/5 lg:size-2/3 shadow-lg rounded-[var(--radius)] overflow-hidden">
      {prompt.section === "design" && (
        <img
          className=" transition-transform object-cover inset-0 size-full"
          src={prompt.mediaUrl ?? "https://picsum.photos/400"}
        />
      )}

      {prompt.section === "video" && (
        <>
          {showThumbnail && (
            <img
              className=" transition-transform object-cover inset-0 size-full"
              src={prompt.thumbnailUrl ?? "https://picsum.photos/400"}
            />
          )}
          <video
            loop
            playsInline
            muted
            autoPlay
            disablePictureInPicture
            onLoadedData={() => setShowThumbnail(false)}
            className=" transition-transform object-cover inset-0 size-full"
            src={
              prompt.mediaUrl ??
              "https://d8j0ntlcm91z4.cloudfront.net/user_3CIjqzTsrKEUr8OzFBaYO4ux3nG/hf_20260413_121933_7dfa9582-a536-4a83-9041-ee5aa102ff8c.mp4"
            }
          />
        </>
      )}
    </div>
  );
}
