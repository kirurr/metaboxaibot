-- CreateTable
CREATE TABLE "web_notifications" (
    "id" TEXT NOT NULL,
    "userId" BIGINT NOT NULL,
    "jobId" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "isSeen" BOOLEAN NOT NULL DEFAULT false,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "web_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "web_notifications_userId_createdAt_idx" ON "web_notifications"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "web_notifications_userId_isSeen_idx" ON "web_notifications"("userId", "isSeen");

-- CreateIndex
CREATE INDEX "web_notifications_jobId_idx" ON "web_notifications"("jobId");

-- AddForeignKey
ALTER TABLE "web_notifications" ADD CONSTRAINT "web_notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "web_notifications" ADD CONSTRAINT "web_notifications_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "generation_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
