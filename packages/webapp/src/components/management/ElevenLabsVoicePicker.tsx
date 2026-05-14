import { useEffect, useState } from "react";
import { api } from "../../api/client.js";
import { useI18n } from "../../i18n.js";
import type { ElevenLabsVoice } from "../../types.js";
import { VoiceList, type VoiceListItem } from "./VoiceList.js";

interface ElevenLabsVoicePickerProps {
  voiceId: string;
  onChange: (key: string, value: unknown) => void;
}

/**
 * Picker для tts-el модели — показывает официальный каталог голосов ElevenLabs,
 * доступных через kie.ai. kie не отдаёт живой voices-API, только фиксированный
 * enum id'шников, поэтому список статичный и без фильтров по языку/полу
 * (этих метаданных у kie нет). Описание голоса показывается второй строкой.
 *
 * Клонированные голоса юзеров живут на Cartesia → доступны в модели
 * tts-cartesia через CartesiaVoicePicker.
 */
export function ElevenLabsVoicePicker({ voiceId, onChange }: ElevenLabsVoicePickerProps) {
  const { t } = useI18n();
  const [voices, setVoices] = useState<ElevenLabsVoice[]>([]);
  const [voicesLoading, setVoicesLoading] = useState(false);

  useEffect(() => {
    if (voices.length === 0) {
      setVoicesLoading(true);
      api.elevenlabsVoices
        .list()
        .then(setVoices)
        .catch(() => setVoices([]))
        .finally(() => setVoicesLoading(false));
    }
  }, [voices.length]);

  const selectOfficial = (item: VoiceListItem) => {
    onChange("voice_id", item.id);
  };

  const officialItems: VoiceListItem[] = voices.map((v) => ({
    id: v.voice_id,
    name: v.name,
    meta: v.description || undefined,
    hasPreview: !!v.preview_url,
    resolvePreviewUrl: v.preview_url ? () => v.preview_url! : undefined,
  }));

  return (
    <div className="voice-picker">
      {voicesLoading ? (
        <div className="voice-picker__loading">{t("picker.loadingVoices")}</div>
      ) : (
        <>
          <div className="voice-picker__hint">💡 {t("uploads.elevenlabsLangHint")}</div>
          <VoiceList
            items={officialItems}
            selectedId={voiceId}
            onSelect={selectOfficial}
            emptyText={t("picker.noVoices")}
          />
        </>
      )}
    </div>
  );
}
