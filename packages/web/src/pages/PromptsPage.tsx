import clsx from "clsx";
import { useState, useRef, useEffect } from "react";
import { useListPromptExamples } from "@/hooks/useListPromptExamples";
import type { PromptExample } from "@/api/promptExamples";
import { ArrowRight, Sparkles, X } from "lucide-react";
import { Button } from "@/components/common/Button";

export default function PromptsPage() {
  const [selectedType, setSelectedType] = useState<string | undefined>(undefined);
  const { prompts, isLoading, isFetchingNextPage, hasNextPage, fetchNextPage } =
    useListPromptExamples(selectedType);

  const [currentPromptId, setCurrentPromptId] = useState<string | undefined>();
  const currentPrompt = currentPromptId ? prompts.find((p) => p.id === currentPromptId) : undefined;

  const dialogRef = useRef<HTMLDialogElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

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

  const handleTypeSelect = (type: string | undefined) => {
    setSelectedType(type);
  };

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

  return (
    <div className="p-4">
      <div className="text-center mt-8 mb-12">
        <h1 className="h1 mb-4">Prompts for you to use</h1>
        <p className="text-text-secondary text-lg">Click on image to see the prompt and settings</p>
      </div>

      <div className="auth-tab w-1/2 mx-auto !mb-8">
        <button
          className={clsx(selectedType === undefined && "on")}
          onClick={() => handleTypeSelect(undefined)}
        >
          All
        </button>
        <button
          className={clsx(selectedType === "design" && "on")}
          onClick={() => handleTypeSelect("design")}
        >
          Images
        </button>
        <button
          className={clsx(selectedType === "video" && "on")}
          onClick={() => handleTypeSelect("video")}
        >
          Videos
        </button>
      </div>

      <ul className="grid grid-flow-dense grid-cols-5 auto-rows-[400px] gap-6">
        {isLoading &&
          Array.from({ length: 20 }).map((_, i) => (
            <div key={i} className="p-4 mb-4 skeleton"></div>
          ))}
        {prompts.map((data) => {
          const { tall, wide } = cardVariant(data.id);
          return (
            <PromptCard
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
      {isFetchingNextPage && <div className="text-center py-2">Loading...</div>}

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
          className="w-full h-full flex flex-row gap-4 overflow-hidden relative"
        >
          <button
            className="btn btn-ghost btn-icon absolute top-8 left-8"
            onClick={handleDialogClose}
          >
            <X />
          </button>
          <div
            id="dialog-image-wrapper"
            className="flex flex-col w-2/3 items-center justify-center"
          >
            {currentPrompt && <MediaCard prompt={currentPrompt} />}
          </div>
          {currentPrompt && <DialogCard prompt={currentPrompt} />}
        </div>
      </dialog>
    </div>
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
  const tall = wide || h % 10 === 0;
  return { tall, wide };
}

function PromptCard({
  data,
  openDialog,
  tall = false,
  wide = false,
}: {
  data: PromptExample;
  openDialog: () => void;
  tall?: boolean;
  wide?: boolean;
}) {
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
				relative z-10 mt-auto"
      >
        <Sparkles /> Try the same prompt
      </div>
    </button>
  );
}

function DialogCard({ prompt }: { prompt: PromptExample }) {
  return (
    <div className="w-1/3 card flex flex-col gap-4 text-white p-8 min-h-0 overflow-hidden">
      <h2 className="h2 text-center shrink-0">{prompt.model?.name}</h2>
      <div className="flex flex-col gap-4 flex-1 min-h-0">
        <h3 className="h3 text-center shrink-0">Prompt that was used for this generation:</h3>
        <div className="text-text-secondary text-lg bg-bg-elevated p-4 rounded-[var(--radius)] overflow-y-auto">
          {prompt.prompt}
        </div>
        <Button className="mt-auto" size="lg" rightIcon={<ArrowRight />}>
          Try the same prompt and settings
        </Button>
      </div>
    </div>
  );
}

function MediaCard({ prompt }: { prompt: PromptExample }) {
  const [showThumbnail, setShowThumbnail] = useState(true);
  return (
    <div className="size-2/3 shadow-lg rounded-[var(--radius)] overflow-hidden">
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
