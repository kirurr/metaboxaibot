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
  | "HIGGSFIELD_SOUL_PHOTO"
  | "SCENARIOS_SECTION"
  | "FACE_SWAP_AWAIT_FACE"
  | "FACE_SWAP_AWAIT_REFERENCE"
  | "CLOTHING_TRYON_AWAIT_PERSON"
  | "CLOTHING_TRYON_AWAIT_CLOTHING"
  | "BG_REMOVAL_AWAIT_PHOTO"
  | "OBJECT_REMOVAL_AWAIT_PHOTO"
  | "OBJECT_REMOVAL_AWAIT_PROMPT"
  | "PHOTO_ANIMATE_AWAIT_PHOTO"
  | "PHOTO_UPSCALE_AWAIT_PHOTO"
  | "PHOTO_CREATE_AWAIT_PHOTO"
  | "PHOTO_CREATE_AWAIT_PROMPT"
  | "PHOTO_CREATE_AWAIT_AR"
  | "VIDEO_UPSCALE_AWAIT_VIDEO"
  | "AWAITING_DELETE_CONFIRMATION";

export type Section = "gpt" | "design" | "audio" | "video";

export interface UserDto {
  /** Внутренний автоинкрементный `User.id` (FK semantics). */
  id: bigint;
  /** Telegram user ID — null для web-only юзеров без TG-привязки. */
  telegramId: bigint | null;
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
