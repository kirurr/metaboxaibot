import { useEffect, useRef, useState } from "react";
import { Pause, Play, Search, X } from "lucide-react";
import clsx from "clsx";
import { useTranslation } from "react-i18next";
import { fetchCartesiaPreviewBlobUrl, type VoiceItem, type VoiceProvider } from "@/api/voices";

/**
 * Picker для выбора TTS-голоса. Десктоп: side-панель справа от .gen-panel
 * (рендерится как sibling в .gen-scene-row). Мобильный: full-screen modal
 * (CSS `position: fixed` через медиа-запрос). Один общий компонент, layout
 * управляется только CSS-классами.
 *
 * Preview-воспроизведение через единственный `<audio>` элемент на picker —
 * клик на одну playing-кнопку другого voice'а pause-ит предыдущий.
 */

export function VoicePicker({
  provider,
  voices,
  isLoading,
  currentVoiceId,
  onSelect,
  onClose,
}: {
  provider: VoiceProvider;
  voices: VoiceItem[];
  isLoading: boolean;
  currentVoiceId: string;
  onSelect: (voice: VoiceItem) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [resolvedUrls, setResolvedUrls] = useState<Record<string, string>>({});
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Live-ref всех blob'ов, что мы накопили — нужен в cleanup'е без зависимости
  // эффекта от `resolvedUrls` state'а (иначе cleanup срабатывал бы на каждом
  // добавлении URL и тушил активное воспроизведение).
  const resolvedUrlsRef = useRef<Record<string, string>>({});
  useEffect(() => {
    resolvedUrlsRef.current = resolvedUrls;
  }, [resolvedUrls]);

  // Останавливаем превью + чистим blob: URL'ы при unmount.
  useEffect(() => {
    const audio = audioRef.current;
    return () => {
      audio?.pause();
      for (const u of Object.values(resolvedUrlsRef.current)) {
        if (u.startsWith("blob:")) URL.revokeObjectURL(u);
      }
    };
  }, []);

  async function togglePlay(voice: VoiceItem) {
    if (!voice.hasPreview) return;
    // Пауза текущего, если попали на ту же кнопку.
    if (playingId === voice.id) {
      audioRef.current?.pause();
      setPlayingId(null);
      return;
    }
    // Резолвим URL: cartesia требует токенизированный fetch — отдаём blob:.
    let url = resolvedUrls[voice.id];
    if (!url) {
      try {
        url =
          provider === "cartesia"
            ? await fetchCartesiaPreviewBlobUrl(voice.id)
            : (voice.previewUrl ?? "");
      } catch {
        return; // тихо игнорируем, юзер увидит, что play не сработал
      }
      if (!url) return;
      setResolvedUrls((prev) => ({ ...prev, [voice.id]: url }));
    }
    // Останавливаем предыдущий перед сменой src.
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = url;
      audioRef.current.currentTime = 0;
      try {
        await audioRef.current.play();
        setPlayingId(voice.id);
      } catch {
        setPlayingId(null);
      }
    }
  }

  const q = search.trim().toLowerCase();
  const filtered = q
    ? voices.filter(
        (v) =>
          v.name.toLowerCase().includes(q) ||
          (v.description ?? "").toLowerCase().includes(q) ||
          (v.language ?? "").toLowerCase().includes(q),
      )
    : voices;

  return (
    <div className="voice-picker">
      <div className="voice-picker-head">
        <div>
          <div className="voice-picker-title">{t("voicePicker.title")}</div>
          <div className="voice-picker-sub">{providerName(provider)}</div>
        </div>
        <button className="voice-picker-close" onClick={onClose} aria-label={t("common.close")}>
          <X size={16} />
        </button>
      </div>

      <div className="voice-picker-search">
        <Search size={14} />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("voicePicker.searchPlaceholder")}
        />
      </div>

      <div className="voice-picker-list">
        {isLoading && <div className="voice-picker-empty">{t("voicePicker.loading")}</div>}
        {!isLoading && filtered.length === 0 && (
          <div className="voice-picker-empty">{q ? t("common.empty") : t("voicePicker.empty")}</div>
        )}
        {filtered.map((v) => {
          const isSelected = v.id === currentVoiceId;
          const isPlaying = playingId === v.id;
          return (
            <button
              key={v.id}
              className={clsx("voice-picker-item", isSelected && "is-selected")}
              onClick={() => onSelect(v)}
            >
              <div className="voice-picker-item-body">
                <div className="voice-picker-item-name">{v.name}</div>
                <div className="voice-picker-item-meta">
                  {[v.language, v.gender, v.description].filter(Boolean).join(" · ") || "—"}
                </div>
              </div>
              {v.hasPreview && (
                <button
                  className={clsx("voice-picker-play", isPlaying && "is-playing")}
                  onClick={(e) => {
                    e.stopPropagation();
                    togglePlay(v);
                  }}
                  aria-label={isPlaying ? t("voicePicker.pause") : t("voicePicker.play")}
                  type="button"
                >
                  {isPlaying ? <Pause size={14} /> : <Play size={14} />}
                </button>
              )}
            </button>
          );
        })}
      </div>

      <audio ref={audioRef} onEnded={() => setPlayingId(null)} preload="none" />
    </div>
  );
}

function providerName(p: VoiceProvider): string {
  if (p === "cartesia") return "Cartesia";
  if (p === "elevenlabs") return "ElevenLabs";
  return "OpenAI";
}
