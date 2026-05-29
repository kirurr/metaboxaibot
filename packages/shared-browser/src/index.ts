export {
  MODEL_TRANSLATIONS,
  SETTING_TRANSLATIONS,
  resolveModelDisplay,
} from "./i18n/model-translations.js";
export type { ModelTranslation, SettingTranslation } from "./i18n/model-translations.js";
export { suggestEmailTypo } from "./email-suggest.js";
export { stripLeadingEmoji } from "./strip-emoji.js";
// WS-API намеренно вынесен в sub-export `@metabox/shared-browser/ws`:
// `./ws/schemas.js` тянет `zod`, а main entry грузится транзитивно бэкендом
// через `@metabox/shared` (там value-re-export'ы MODEL_TRANSLATIONS и пр.).
// Без вынесения каждый бэкенд-сервис в рантайме обязан был бы иметь zod в
// `shared-browser/node_modules`, иначе ERR_MODULE_NOT_FOUND на старте.
