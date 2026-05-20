import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation, Trans } from "react-i18next";
import { Input } from "@/components/common/Input";
import { Button } from "@/components/common/Button";
import { forgotPassword } from "@/api/auth";
import { ApiError } from "@/api/client";

export default function ForgotPassword() {
  const { t } = useTranslation();
  const [sent, setSent] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  // Schema создаём через useMemo чтобы сообщения брались актуальной локалью.
  const schema = useMemo(
    () =>
      z.object({
        email: z
          .string()
          .min(1, t("forgotPassword.errorEmailRequired"))
          .email(t("forgotPassword.errorEmailInvalid")),
      }),
    [t],
  );
  type FormValues = z.infer<typeof schema>;

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    getValues,
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  const onSubmit = async (values: FormValues) => {
    setServerError(null);
    try {
      await forgotPassword(values.email.trim().toLowerCase());
      setSent(true);
    } catch (err) {
      if (err instanceof ApiError) setServerError(err.message);
      else setServerError(t("forgotPassword.errorSendFailed"));
    }
  };

  if (sent) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-bg">
        <div className="card w-full max-w-[400px] p-8 text-center anim-page-in">
          <div className="brand-text text-3xl mb-2">AI Box</div>
          <h1 className="text-xl font-bold mt-4 mb-2">{t("forgotPassword.checkInbox")}</h1>
          <p className="text-text-secondary text-sm mb-6">
            <Trans
              i18nKey="forgotPassword.ifAccountExists"
              values={{ email: getValues("email") }}
              components={{ bold: <span className="text-text font-semibold" /> }}
            />
          </p>
          <Link to="/login" className="text-accent hover:underline text-sm">
            {t("forgotPassword.backToLogin")}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-bg">
      <div className="card w-full max-w-[400px] p-8 anim-page-in">
        <div className="brand-text text-3xl mb-2">AI Box</div>
        <p className="text-text-secondary text-sm mb-7">{t("forgotPassword.title")}</p>

        <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
          <Input
            id="email"
            label={t("auth.email")}
            type="email"
            autoComplete="email"
            autoFocus
            placeholder={t("auth.emailPlaceholder")}
            hint={t("forgotPassword.emailHint")}
            error={errors.email?.message}
            {...register("email")}
          />

          {serverError && (
            <div
              className="rounded-sm px-3 py-2 text-sm"
              style={{
                background: "var(--danger-bg)",
                color: "var(--danger)",
                borderLeft: "3px solid var(--danger)",
              }}
            >
              {serverError}
            </div>
          )}

          <Button type="submit" loading={isSubmitting} fullWidth>
            {t("forgotPassword.submit")}
          </Button>
        </form>

        <div className="mt-6 pt-6 border-t border-border text-center text-sm text-text-secondary">
          <Link to="/login" className="text-accent hover:underline">
            {t("forgotPassword.backToLogin")}
          </Link>
        </div>
      </div>
    </div>
  );
}
