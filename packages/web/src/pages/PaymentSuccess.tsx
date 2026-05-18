import { Link, useSearchParams } from "react-router-dom";
import { CheckCircle2 } from "lucide-react";
import { useTranslation } from "react-i18next";

export default function PaymentSuccess() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const orderId = params.get("order");

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-bg">
      <div className="card w-full max-w-md p-8 text-center anim-page-in">
        <CheckCircle2 size={64} className="text-success mx-auto mb-4" />
        <h1 className="text-2xl font-bold mb-2">{t("payment.successTitle")}</h1>
        <p className="text-text-secondary mb-6">{t("payment.successDescription")}</p>
        {orderId && (
          <div className="text-xs text-text-hint mb-4">
            {t("payment.successOrderId", { id: orderId })}
          </div>
        )}
        <Link to="/chat" className="btn-primary">
          {t("payment.backToChat")}
        </Link>
      </div>
    </div>
  );
}
