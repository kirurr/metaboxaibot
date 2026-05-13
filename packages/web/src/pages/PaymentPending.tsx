import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Clock, CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/common/Button";
import { getOrderStatus } from "@/api/billing";

export default function PaymentPending() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const orderId = params.get("order") ?? params.get("_order") ?? "";
  const [status, setStatus] = useState<"pending" | "paid" | "failed">("pending");

  useEffect(() => {
    if (!orderId) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await getOrderStatus(orderId);
        if (cancelled) return;
        if (res.status === "PAID") {
          setStatus("paid");
          setTimeout(() => navigate(`/payment/success?order=${orderId}`, { replace: true }), 900);
        } else if (res.status === "FAILED" || res.status === "CANCELED") {
          setStatus("failed");
          setTimeout(() => navigate(`/payment/failed?order=${orderId}`, { replace: true }), 900);
        }
      } catch {
        /* ignore */
      }
    };

    poll();
    const id = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [orderId, navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-bg">
      <div className="card w-full max-w-md p-8 text-center anim-page-in">
        {status === "pending" && (
          <>
            <Clock size={64} className="text-accent mx-auto mb-4" />
            <h1 className="text-2xl font-bold mb-2">Ждём подтверждение</h1>
            <p className="text-text-secondary mb-6">
              Оплата обрабатывается. Страница обновится автоматически.
            </p>
            <div className="flex justify-center">
              <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            </div>
          </>
        )}
        {status === "paid" && (
          <>
            <CheckCircle2 size={64} className="text-success mx-auto mb-4" />
            <h1 className="text-2xl font-bold mb-2">Оплата получена</h1>
          </>
        )}
        {status === "failed" && (
          <>
            <XCircle size={64} className="text-danger mx-auto mb-4" />
            <h1 className="text-2xl font-bold mb-2">Оплата не прошла</h1>
            <Button onClick={() => navigate("/plans")}>Попробовать снова</Button>
          </>
        )}
      </div>
    </div>
  );
}
