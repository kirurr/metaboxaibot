import { Download, Trash2 } from "lucide-react";
import clsx from "clsx";
import { useTranslation } from "react-i18next";
import { updatePreferences } from "@/api/auth";

/**
 * Settings — единственный страничный экран с UI-предпочтениями (язык
 * интерфейса) и блоком Data & Privacy (экспорт/удаление). Профиль освобождён
 * от этих секций: там осталась только идентификация + баланс.
 *
 * Язык: 1) `i18n.changeLanguage(...)` обновляет UI и пишет в localStorage
 *       2) PATCH `/auth/web-me` синкает в БД, потому что воркеры читают
 *          `user.language` для формирования локализованных ошибок генераций.
 *          Без шага 2 пользователь видел бы свой UI на en, но ошибки приходили
 *          бы на старом языке из DB.
 */
export default function Settings() {
  const { t, i18n } = useTranslation();

  // i18n.language может быть "ru", "en", или "en-US" — нормализуем по первым 2.
  const current = (i18n.resolvedLanguage ?? i18n.language ?? "ru").slice(0, 2);

  const setLang = (lang: "ru" | "en") => {
    if (lang === current) return;
    void i18n.changeLanguage(lang);
    // Fire-and-forget: на ошибку (например web-only юзер без User-row → 204
    // или сеть упала) не валим UI — localStorage уже хранит новый выбор.
    updatePreferences({ language: lang }).catch(() => void 0);
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
