-- Длительность последнего загруженного аудио в HeyGen voice_audio слот.
-- Используется как `audioDurationSecHint` в cost-preview, чтобы избежать
-- падения в per_second режим при flaky ffprobe из cost-preview.service.
-- ffprobe'ится на байтах при загрузке (не доверяем metadata-полю Telegram
-- audio messages — там user-controlled значения).
ALTER TABLE "user_states" ADD COLUMN "videoVoiceDurationSec" INTEGER;
