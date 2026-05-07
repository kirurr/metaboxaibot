import { useEffect, useState } from "react";
import { api } from "../../api/client.js";
import { useI18n } from "../../i18n.js";
import type { DIDVoice, UserVoice } from "../../types.js";
import { VoiceList, type VoiceListItem } from "./VoiceList.js";

interface DIDVoicePickerProps {
  voiceId: string;
  onChange: (key: string, value: unknown) => void;
}

export function DIDVoicePicker({ voiceId, onChange }: DIDVoicePickerProps) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"official" | "mine">("official");
  const [voices, setVoices] = useState<DIDVoice[]>([]);
  const [voicesLoading, setVoicesLoading] = useState(false);
  const [myVoices, setMyVoices] = useState<UserVoice[]>([]);
  const [myVoicesLoading, setMyVoicesLoading] = useState(false);
  const [langFilter, setLangFilter] = useState("all");
  const [genderFilter, setGenderFilter] = useState("all");
  const [providerFilter, setProviderFilter] = useState("all");

  useEffect(() => {
    if (tab === "official" && voices.length === 0) {
      setVoicesLoading(true);
      api.didVoices
        .list()
        .then(setVoices)
        .catch(() => setVoices([]))
        .finally(() => setVoicesLoading(false));
    }
    if (tab === "mine") {
      setMyVoicesLoading(true);
      // Без provider-фильтра: показываем все клонированные голоса юзера
      // (Cartesia + ElevenLabs legacy).
      api.userVoices
        .list()
        .then(setMyVoices)
        .catch(() => setMyVoices([]))
        .finally(() => setMyVoicesLoading(false));
    }
  }, [tab, voices.length]);

  const selectOfficial = (item: VoiceListItem) => {
    const voice = voices.find((v) => v.id === item.id);
    if (!voice) return;
    onChange("voice_id", voice.id);
    onChange("voice_provider", voice.provider);
  };

  const selectCloned = (item: VoiceListItem) => {
    const voice = myVoices.find((v) => v.id === item.id);
    if (!voice) return;
    // Persist стабильный UserVoice.id — worker резолвит фактический external
    // voice_id через `resolveVoiceForTTS`. voice_provider берётся из самой
    // UserVoice-записи (cartesia для новых, elevenlabs для legacy).
    onChange("voice_id", voice.id);
    onChange("voice_provider", voice.provider);
  };

  const languages = [
    "all",
    ...Array.from(
      new Set(voices.flatMap((v) => v.languages.map((l) => l.language)).filter(Boolean)),
    ).sort(),
  ];
  const providers = [
    "all",
    ...Array.from(new Set(voices.map((v) => v.provider).filter(Boolean))).sort(),
  ];

  const filtered = voices.filter(
    (v) =>
      (langFilter === "all" || v.languages.some((l) => l.language === langFilter)) &&
      (genderFilter === "all" || v.gender === genderFilter) &&
      (providerFilter === "all" || v.provider === providerFilter),
  );

  const officialItems: VoiceListItem[] = filtered.map((voice) => {
    const langLabel = voice.languages.map((l) => l.language).join(", ");
    const previewUrl = voice.languages.find((l) => l.previewUrl)?.previewUrl;
    return {
      id: voice.id,
      name: voice.name,
      meta:
        `${voice.provider} · ${langLabel}` +
        (voice.gender
          ? ` · ${voice.gender === "male" ? t("picker.genderM") : voice.gender === "female" ? t("picker.genderF") : voice.gender}`
          : ""),
      hasPreview: !!previewUrl,
      resolvePreviewUrl: previewUrl ? () => previewUrl : undefined,
    };
  });

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
              <select
                className="voice-picker__filter-select"
                value={providerFilter}
                onChange={(e) => setProviderFilter(e.target.value)}
              >
                {providers.map((p) => (
                  <option key={p} value={p}>
                    {p === "all" ? t("picker.providerAll") : p}
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

      {tab === "mine" &&
        (myVoicesLoading ? (
          <div className="voice-picker__loading">{t("picker.loading")}</div>
        ) : (
          <VoiceList
            items={mineItems}
            selectedId={mineSelectedId}
            onSelect={selectCloned}
            emptyText={t("uploads.emptyVoices")}
          />
        ))}
    </div>
  );
}
