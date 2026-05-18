import { Link } from "react-router-dom";
import { XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

export default function PaymentFailed() {
  const { t } = useTranslation();
  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-bg">
      <div className="card w-full max-w-md p-8 text-center anim-page-in">
        <XCircle size={64} className="text-danger mx-auto mb-4" />
        <h1 className="text-2xl font-bold mb-2">{t("payment.failedTitle")}</h1>
        <p className="text-text-secondary mb-6">{t("payment.failedDescription")}</p>
        <div className="flex gap-3 justify-center">
          <Link to="/plans" className="btn-primary">
            {t("payment.tryAgain")}
          </Link>
          <Link to="/chat" className="btn-secondary">
            {t("payment.toChat")}
          </Link>
        </div>
      </div>
    </div>
  );
}
