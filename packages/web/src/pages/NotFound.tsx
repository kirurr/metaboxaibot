import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

export default function NotFound() {
  const { t } = useTranslation();
  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-bg">
      <div className="text-center anim-page-in">
        <div className="brand-text text-6xl font-bold mb-4">404</div>
        <p className="text-text-secondary mb-6">{t("notFound.title")}</p>
        <Link to="/" className="btn-primary">
          {t("notFound.toHome")}
        </Link>
      </div>
    </div>
  );
}
