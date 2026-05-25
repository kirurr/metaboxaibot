-- Element — именованный (@-тег) набор референсных изображений пользователя.
CREATE TABLE "elements" (
    "id" TEXT NOT NULL,
    "userId" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "elements_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "elements_userId_name_key" ON "elements"("userId", "name");
CREATE INDEX "elements_userId_id_idx" ON "elements"("userId", "id" DESC);
ALTER TABLE "elements" ADD CONSTRAINT "elements_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Привязка медиа к элементу. NULL = обычный chat-upload (виден в общем списке
-- переиспользования); not NULL = картинка элемента (из общего списка исключена).
ALTER TABLE "uploaded_media" ADD COLUMN "elementId" TEXT;
CREATE INDEX "uploaded_media_elementId_idx" ON "uploaded_media"("elementId");
ALTER TABLE "uploaded_media" ADD CONSTRAINT "uploaded_media_elementId_fkey"
    FOREIGN KEY ("elementId") REFERENCES "elements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
