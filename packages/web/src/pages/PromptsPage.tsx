import clsx from "clsx";
import { useState, useRef, useEffect } from "react";
import { useListPromptExamples } from "@/hooks/useListPromptExamples";
import type { PromptExample } from "@/api/promptExamples";

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
				p-8
				backdrop:transition-all
				fixed inset-0
				w-screen h-screen
				max-w-none max-h-none
				m-0
				overflow-hidden
				box-border
				bg-transparent
				backdrop:backdrop-blur
				rounded-[var(--radius)]"
      >
        <div
          id="dialog-content-wrapper"
          className="w-full h-full flex flex-row gap-4 overflow-hidden"
        >
          <div
            id="dialog-image-wrapper"
            className="flex flex-col w-2/3 items-center justify-center"
          >
            <img
              src={"https://picsum.photos/400"}
              className="object-cover size-2/3 shadow-lg rounded-[var(--radius)]"
            />
          </div>
          <div className="card">
            <button onClick={handleDialogClose}>close</button>
            {currentPrompt && <div className="text-white">{currentPrompt.prompt}</div>}
          </div>
        </div>
      </dialog>

      <div className="auth-tab w-1/2 mx-auto">
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
      <ul className="grid grid-flow-dense grid-cols-4 auto-rows-[400px] gap-6">
        {prompts.map((data) => (
          <PromptCard openDialog={() => handleDialogOpen(data.id)} data={data} key={data.id} />
        ))}
      </ul>
      <div ref={sentinelRef} className="h-8" />
      {isFetchingNextPage && <div className="text-center py-2">Loading...</div>}
    </div>
  );
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
  return (
    <button
      className={clsx(
        `
			group
			flex flex-col
			rounded-[var(--radius)]
			relative overflow-hidden
size-full`,
        tall && "row-span-2",
        wide && "col-span-2",
      )}
      onClick={openDialog}
    >
      <img className="absolute object-cover inset-0 size-full" src={"https://picsum.photos/400"} />
      <div className="text-transparent group-focus-visible:text-white group-hover:text-white transition-colors relative z-10 mt-auto">
        повторить
      </div>
    </button>
  );
}
