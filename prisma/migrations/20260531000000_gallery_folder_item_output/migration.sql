-- GalleryFolderItem переезжает с job-level на output-level.
-- 1 строка (folderId, jobId) → N строк (folderId, outputId) — по одному на каждый
-- output этой джобы. Так пользовательские «избранное» / папки, поставленные на
-- всю пачку, разворачиваются на отдельные элементы и не теряются.

-- 1) Создаём новую таблицу со схемой output-level. PK-constraint называем
-- временно `*_new_pkey` — иначе collision с существующим constraint'ом
-- `gallery_folder_items_pkey` на старой таблице (имена constraint'ов
-- глобальны в schema). После DROP+RENAME переименовываем PK обратно.
CREATE TABLE "gallery_folder_items_new" (
    "folderId" TEXT NOT NULL,
    "outputId" TEXT NOT NULL,
    "addedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "gallery_folder_items_new_pkey" PRIMARY KEY ("folderId", "outputId")
);

-- 2) Бэкфилл: разворачиваем (folderId, jobId) в (folderId, outputId) для всех
-- outputs этой джобы. ON CONFLICT — на случай, если бэкап-восстановление
-- запустит миграцию повторно: дубликат тихо игнорируется.
INSERT INTO "gallery_folder_items_new" ("folderId", "outputId", "addedAt")
SELECT gfi."folderId", gjo."id", gfi."addedAt"
FROM "gallery_folder_items" gfi
JOIN "generation_job_outputs" gjo ON gjo."jobId" = gfi."jobId"
ON CONFLICT DO NOTHING;

-- 3) Атомарно подменяем таблицу. DROP сносит старый PK-constraint
-- `gallery_folder_items_pkey`, после чего имя свободно — RENAME даёт ему
-- новый объект.
DROP TABLE "gallery_folder_items";
ALTER TABLE "gallery_folder_items_new" RENAME TO "gallery_folder_items";
ALTER INDEX "gallery_folder_items_new_pkey" RENAME TO "gallery_folder_items_pkey";

-- 4) FK + индекс.
ALTER TABLE "gallery_folder_items" ADD CONSTRAINT "gallery_folder_items_folderId_fkey"
    FOREIGN KEY ("folderId") REFERENCES "gallery_folders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gallery_folder_items" ADD CONSTRAINT "gallery_folder_items_outputId_fkey"
    FOREIGN KEY ("outputId") REFERENCES "generation_job_outputs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "gallery_folder_items_outputId_idx" ON "gallery_folder_items"("outputId");
