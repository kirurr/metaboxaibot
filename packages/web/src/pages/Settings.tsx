import { Download, Trash2 } from "lucide-react";
import clsx from "clsx";
import { useTranslation } from "react-i18next";

/**
 * Settings — единственный страничный экран с UI-предпочтениями (язык
 * интерфейса) и блоком Data & Privacy (экспорт/удаление). Профиль освобождён
 * от этих секций: там осталась только идентификация + баланс.
 *
 * Язык хранится в localStorage'е (ключ `i18n-lang`, см. `src/i18n.ts`). Смена —
 * через `i18n.changeLanguage(...)`, она же триггерит ре-рендер всего дерева
 * через react-i18next.
 */
export default function Settings() {
  const { t, i18n } = useTranslation();

  // i18n.language может быть "ru", "en", или "en-US" — нормализуем по первым 2.
  const current = (i18n.resolvedLanguage ?? i18n.language ?? "ru").slice(0, 2);

  const setLang = (lang: "ru" | "en") => {
    if (lang === current) return;
    void i18n.changeLanguage(lang);
  };

  return (
    <div className="page">
      <div className="page-head rise">
        <div>
          <h1 className="h1">{t("settings.title")}</h1>
          <p className="sub">{t("settings.subtitle")}</p>
        </div>
      </div>

      <div className="two-col rise d1">
        <div className="card" style={{ padding: 22 }}>
          <h3 className="section-title">{t("settings.sectionPreferences")}</h3>
          <div className="field-row" style={{ gridTemplateColumns: "1fr auto" }}>
            <div>
              <div style={{ fontSize: 14 }}>{t("settings.languageLabel")}</div>
              <div className="muted" style={{ fontSize: 12.5 }}>
                {t("settings.languageHint")}
              </div>
            </div>
            <div className="row" style={{ gap: 6 }}>
              <button
                type="button"
                className={clsx("chip", current === "ru" && "success")}
                onClick={() => setLang("ru")}
                aria-pressed={current === "ru"}
              >
                {t("settings.languageRu")}
              </button>
              <button
                type="button"
                className={clsx("chip", current === "en" && "success")}
                onClick={() => setLang("en")}
                aria-pressed={current === "en"}
              >
                {t("settings.languageEn")}
              </button>
            </div>
          </div>
        </div>

        <div className="card" style={{ padding: 22 }}>
          <h3 className="section-title">{t("settings.sectionDataPrivacy")}</h3>
          <p className="muted" style={{ fontSize: 13.5, margin: "0 0 14px" }}>
            {t("settings.dataPrivacyHint")}
          </p>
          <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
            <button className="btn btn-secondary btn-sm">
              <Download size={14} /> {t("settings.exportData")}
            </button>
            <button className="btn btn-ghost btn-sm" style={{ color: "var(--danger)" }}>
              <Trash2 size={14} /> {t("settings.deleteAccount")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
