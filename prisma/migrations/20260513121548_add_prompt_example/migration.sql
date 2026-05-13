-- CreateTable
CREATE TABLE "prompt_examples" (
    "id" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "modelSettings" JSONB,
    "prompt" TEXT NOT NULL,
    "mediaS3Key" TEXT,
    "thumbnailS3Key" TEXT,
    "section" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompt_examples_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "prompt_examples_section_id_idx" ON "prompt_examples"("section", "id" DESC);
