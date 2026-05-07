import { useEffect, useState } from "react";
import { api } from "../../api/client.js";
import { useI18n } from "../../i18n.js";
import type { HeyGenVoice, UserVoice } from "../../types.js";
import { closeMiniApp } from "../../utils/telegram.js";
import { VoiceList, type VoiceListItem } from "./VoiceList.js";

interface HeyGenVoicePickerProps {
  voiceId: string;
  onChange: (key: string, value: unknown) => void;
}

export function HeyGenVoicePicker({ voiceId, onChange }: HeyGenVoicePickerProps) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"official" | "mine">("official");
  const [voices, setVoices] = useState<HeyGenVoice[]>([]);
  const [voicesLoading, setVoicesLoading] = useState(false);
  const [myVoices, setMyVoices] = useState<UserVoice[]>([]);
  const [myVoicesLoading, setMyVoicesLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createHint, setCreateHint] = useState(false);
  const [langFilter, setLangFilter] = useState("all");
  const [genderFilter, setGenderFilter] = useState("all");

  const handleCreateVoice = async () => {
    setCreating(true);
    try {
      await api.userVoices.startCreation("heygen");
      setCreateHint(true);
      setTimeout(() => setCreateHint(false), 5000);
      closeMiniApp();
    } finally {
      setCreating(false);
    }
  };

  useEffect(() => {
    if (tab === "official" && voices.length === 0) {
      setVoicesLoading(true);
      api.heygenVoices
        .list()
        .then(setVoices)
        .catch(() => setVoices([]))
        .finally(() => setVoicesLoading(false));
    }
    if (tab === "mine") {
      setMyVoicesLoading(true);
      // Без фильтра по провайдеру: показываем все клонированные голоса юзера
      // (новые — Cartesia, legacy — ElevenLabs). Бот резолвит провайдер из
      // самой UserVoice-записи на стороне `preGenerateELTts`.
      api.userVoices
        .list()
        .then(setMyVoices)
        .catch(() => setMyVoices([]))
        .finally(() => setMyVoicesLoading(false));
    }
  }, [tab, voices.length]);

  const selectOfficial = (item: VoiceListItem) => {
    onChange("voice_id", item.id);
    onChange("voice_provider", "heygen");
  };

  const selectCloned = (item: VoiceListItem) => {
    const voice = myVoices.find((v) => v.id === item.id);
    if (!voice) return;
    // Persist стабильный local UserVoice.id — worker резолвит фактический
    // external voice_id (Cartesia или ElevenLabs) через `resolveVoiceForTTS`,
    // который также делает eviction + re-clone + key-binding.
    // voice_provider берётся из самой UserVoice-записи: cartesia для новых,
    // elevenlabs для legacy. Бот по этому полю выбирает TTS-адаптер.
    onChange("voice_id", voice.id);
    onChange("voice_provider", voice.provider);
  };

  const languages = [
    "all",
    ...Array.from(new Set(voices.map((v) => v.language).filter(Boolean))).sort(),
  ];
  const filteredVoices = voices.filter(
    (v) =>
      (langFilter === "all" || v.language === langFilter) &&
      (genderFilter === "all" || v.gender === genderFilter),
  );

  const officialItems: VoiceListItem[] = filteredVoices.map((v) => ({
    id: v.voice_id,
    name: v.name,
    meta: [
      v.language,
      v.gender
        ? v.gender === "male"
          ? t("picker.genderM")
          : v.gender === "female"
            ? t("picker.genderF")
            : v.gender
        : null,
    ]
      .filter(Boolean)
      .join(" · "),
    hasPreview: !!v.preview_audio,
    resolvePreviewUrl: v.preview_audio ? () => v.preview_audio! : undefined,
  }));

  const mineItems: VoiceListItem[] = myVoices.map((v) => ({
    id: v.id,
    name: v.name,
    meta: new Date(v.createdAt).toLocaleDateString(),
    hasPreview: v.hasAudio,
    resolvePreviewUrl: v.hasAudio
      ? async () => (await api.userVoices.previewUrl(v.id)).url
      : undefined,
  }));

  // voice_id is the local UserVoice.id for cloned voices. Fall back to
  // externalId for records saved before this migration (backward compat).
  const mineSelectedId = voiceId
    ? (myVoices.find((v) => v.id === voiceId)?.id ??
      myVoices.find((v) => v.externalId === voiceId)?.id ??
      null)
    : null;

  return (
    <div className="voice-picker">
      {createHint && <div className="activated-popup">{t("uploads.createVoiceHint")}</div>}
      <div className="voice-picker__tabs">
        <button
          className={`voice-picker__tab${tab === "official" ? " voice-picker__tab--active" : ""}`}
          onClick={() => setTab("official")}
        >
          {t("uploads.officialVoices")}
        </button>
        <button
          className={`voice-picker__tab${tab === "mine" ? " voice-picker__tab--active" : ""}`}
          onClick={() => setTab("mine")}
        >
          {t("uploads.myVoices")}
        </button>
      </div>

      {tab === "official" &&
        (voicesLoading ? (
          <div className="voice-picker__loading">{t("picker.loadingVoices")}</div>
        ) : (
          <>
            <div className="voice-picker__filters">
              <select
                className="voice-picker__filter-select"
                value={langFilter}
                onChange={(e) => setLangFilter(e.target.value)}
              >
                {languages.map((l) => (
                  <option key={l} value={l}>
                    {l === "all" ? t("picker.langAll") : l}
                  </option>
                ))}
              </select>
              <div className="voice-picker__gender-btns">
                {(["all", "male", "female"] as const).map((g) => (
                  <button
                    key={g}
                    className={`voice-picker__gender-btn${genderFilter === g ? " voice-picker__gender-btn--active" : ""}`}
                    onClick={() => setGenderFilter(g)}
                  >
                    {g === "all"
                      ? t("picker.genderAll")
                      : g === "male"
                        ? t("picker.genderM")
                        : t("picker.genderF")}
                  </button>
                ))}
              </div>
            </div>
            <VoiceList
              items={officialItems}
              selectedId={voiceId}
              onSelect={selectOfficial}
              emptyText={t("picker.noVoices")}
            />
          </>
        ))}

      {tab === "mine" && (
        <>
          <button
            className="voice-picker__create-btn"
            onClick={handleCreateVoice}
            disabled={creating}
          >
            {creating ? "…" : t("uploads.createVoice")}
          </button>
          {myVoicesLoading ? (
            <div className="voice-picker__loading">{t("picker.loading")}</div>
          ) : (
            <VoiceList
              items={mineItems}
              selectedId={mineSelectedId}
              onSelect={selectCloned}
              emptyText={t("uploads.emptyVoices")}
            />
          )}
        </>
      )}
    </div>
  );
}
