import { useTranslation } from "react-i18next";
import { PromptExamplesGallery } from "@/components/prompts/PromptExamplesGallery";

export default function PromptsPage() {
  const { t } = useTranslation();

  return (
    <div className="p-4">
      <div className="text-center mt-8 mb-12">
        <h1 className="h1 mb-4">{t("prompts.title")}</h1>
        <p className="text-text-secondary text-lg">{t("prompts.subtitle")}</p>
      </div>
      <PromptExamplesGallery />
    </div>
  );
}
