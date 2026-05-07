export type Language =
  | "en"
  | "ru"
  | "lv"
  | "ua"
  | "tr"
  | "ge"
  | "uz"
  | "kz"
  | "de"
  | "es"
  | "it"
  | "fr"
  | "ar"
  | "he";

export type BotState =
  | "IDLE"
  | "MAIN_MENU"
  | "GPT_SECTION"
  | "GPT_ACTIVE"
  | "DESIGN_SECTION"
  | "DESIGN_ACTIVE"
  | "AUDIO_SECTION"
  | "AUDIO_ACTIVE"
  | "VIDEO_SECTION"
  | "VIDEO_ACTIVE"
  | "HEYGEN_AVATAR_PHOTO"
  | "HIGGSFIELD_SOUL_PHOTO";

export type Section = "gpt" | "design" | "audio" | "video";

export interface UserDto {
  id: bigint;
  username?: string;
  firstName?: string;
  lastName?: string;
  language: Language;
  tokenBalance: number;
  isNew: boolean;
  isBlocked: boolean;
  createdAt: Date;
  referredById?: bigint | null;
  metaboxUserId?: string | null;
}

export interface UserStateDto {
  userId: bigint;
  state: BotState;
  section?: Section;
  modelId?: string;
  dialogId?: string;
}
