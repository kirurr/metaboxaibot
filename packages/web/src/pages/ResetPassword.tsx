import { useState, useMemo } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/common/Input";
import { Button } from "@/components/common/Button";
import { resetPassword } from "@/api/auth";
import { ApiError } from "@/api/client";
import { useUIStore } from "@/stores/uiStore";

export default function ResetPassword() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const pushToast = useUIStore((s) => s.pushToast);
  const token = params.get("token") ?? "";
  const [serverError, setServerError] = useState<string | null>(null);

  const schema = useMemo(
    () =>
      z
        .object({
          newPassword: z
            .string()
            .min(8, t("resetPassword.errorMinLength"))
            .max(128, t("resetPassword.errorTooLong")),
          confirmPassword: z.string(),
        })
        .refine((d) => d.newPassword === d.confirmPassword, {
          path: ["confirmPassword"],
          message: t("resetPassword.errorMismatch"),
        }),
    [t],
  );
  type FormValues = z.infer<typeof schema>;

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  const onSubmit = async (values: FormValues) => {
    setServerError(null);
    try {
      await resetPassword(token, values.newPassword);
      pushToast({
        type: "success",
        message: t("resetPassword.successToast"),
        durationMs: 6000,
      });
      navigate("/login", { replace: true });
    } catch (err) {
      if (err instanceof ApiError) setServerError(err.message);
      else setServerError(t("resetPassword.errorUpdateFailed"));
    }
  };

  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-bg">
        <div className="card w-full max-w-[400px] p-8 text-center anim-page-in">
          <div className="text-danger font-semibold mb-2">{t("resetPassword.invalidLink")}</div>
          <p className="text-text-secondary text-sm mb-6">{t("resetPassword.missingToken")}</p>
          <Link to="/forgot-password" className="btn-primary inline-flex">
            {t("resetPassword.requestNew")}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-bg">
      <div className="card w-full max-w-[400px] p-8 anim-page-in">
        <div className="brand-text text-3xl mb-2">AI Box</div>
        <p className="text-text-secondary text-sm mb-7">{t("resetPassword.title")}</p>

        <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
          <Input
            id="newPassword"
            label={t("resetPassword.newPassword")}
            togglePassword
            autoComplete="new-password"
            autoFocus
            hint={t("resetPassword.newPasswordHint")}
            error={errors.newPassword?.message}
            {...register("newPassword")}
          />
          <Input
            id="confirmPassword"
            label={t("resetPassword.confirmPassword")}
            togglePassword
            autoComplete="new-password"
            error={errors.confirmPassword?.message}
            {...register("confirmPassword")}
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
            {t("resetPassword.submit")}
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
