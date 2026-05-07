import type { BotState, Section } from "../types/user.js";

export const BOT_STATES = {
  IDLE: "IDLE",
  MAIN_MENU: "MAIN_MENU",
  GPT_SECTION: "GPT_SECTION",
  GPT_ACTIVE: "GPT_ACTIVE",
  DESIGN_SECTION: "DESIGN_SECTION",
  DESIGN_ACTIVE: "DESIGN_ACTIVE",
  AUDIO_SECTION: "AUDIO_SECTION",
  AUDIO_ACTIVE: "AUDIO_ACTIVE",
  VIDEO_SECTION: "VIDEO_SECTION",
  VIDEO_ACTIVE: "VIDEO_ACTIVE",
} as const satisfies Record<string, BotState>;

export const SECTION_BY_STATE: Partial<Record<BotState, Section>> = {
  GPT_SECTION: "gpt",
  GPT_ACTIVE: "gpt",
  DESIGN_SECTION: "design",
  DESIGN_ACTIVE: "design",
  AUDIO_SECTION: "audio",
  AUDIO_ACTIVE: "audio",
  VIDEO_SECTION: "video",
  VIDEO_ACTIVE: "video",
};

export const WELCOME_BONUS_TOKENS = 7.5;
