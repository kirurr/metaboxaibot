-- Исходные s3-ключи фото для Soul-персонажа (Higgsfield Soul). При создании
-- аватара через web-приложение фронт сначала аплоадит каждое фото через
-- /web/chat-uploads (получает s3Key), затем шлёт массив в /web/user-avatars.
-- Запись создаётся в status="creating", worker позже подхватит s3Keys и
-- отправит их в Higgsfield Soul API.
--
-- HeyGen: остаётся пустым массивом (аплоад синхронный, исходник consumed at create).
ALTER TABLE "user_avatars" ADD COLUMN "sourceS3Keys" TEXT[] DEFAULT ARRAY[]::TEXT[];
