-- CreateTable
CREATE TABLE "uploaded_media" (
    "id" TEXT NOT NULL,
    "userId" BIGINT NOT NULL,
    "type" TEXT NOT NULL,
    "s3Key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uploaded_media_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "uploaded_media_userId_id_idx" ON "uploaded_media"("userId", "id" DESC);

-- CreateIndex
CREATE INDEX "uploaded_media_userId_type_id_idx" ON "uploaded_media"("userId", "type", "id" DESC);

-- AddForeignKey
ALTER TABLE "uploaded_media" ADD CONSTRAINT "uploaded_media_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
