import { Link } from "react-router-dom";
import { XCircle } from "lucide-react";

export default function PaymentFailed() {
  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-bg">
      <div className="card w-full max-w-md p-8 text-center anim-page-in">
        <XCircle size={64} className="text-danger mx-auto mb-4" />
        <h1 className="text-2xl font-bold mb-2">Оплата не прошла</h1>
        <p className="text-text-secondary mb-6">
          Попробуйте ещё раз или выберите другой способ оплаты.
        </p>
        <div className="flex gap-3 justify-center">
          <Link to="/plans" className="btn-primary">
            Попробовать снова
          </Link>
          <Link to="/chat" className="btn-secondary">
            В чат
          </Link>
        </div>
      </div>
    </div>
  );
}
