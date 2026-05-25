import { Bot, InlineKeyboard } from "grammy";
import { sequentialize } from "@grammyjs/runner";
import type { BotContext } from "./types/context.js";
import { authMiddleware } from "./middlewares/auth.middleware.js";
import { i18nMiddleware } from "./middlewares/i18n.middleware.js";
import { messageCoalescingMiddleware } from "./middlewares/message-coalescing.middleware.js";
import {
  handleStart,
  handleLanguageMenu,
  handleLanguageChangeSelect,
  handleOnboardingOk,
} from "./commands/start.js";
import {
  handleMenu,
  handleGpt,
  handleDesign,
  handleAudio,
  handleVideo,
  handleScenarios,
  buildScenariosKeyboard,
} from "./commands/menu.js";
import { handleFaceSwapEnter, handleFaceSwapPhoto } from "./scenes/face-swap.js";
import { handleClothingTryonEnter, handleClothingTryonPhoto } from "./scenes/clothing-tryon.js";
import {
  handleBackgroundRemovalEnter,
  handleBackgroundRemovalPhoto,
} from "./scenes/background-removal.js";
import {
  handleObjectRemovalEnter,
  handleObjectRemovalPhoto,
  handleObjectRemovalPrompt,
} from "./scenes/object-removal.js";
import { handlePhotoAnimateEnter, handlePhotoAnimatePhoto } from "./scenes/photo-animate.js";
import {
  handlePhotoCreateEnter,
  handlePhotoCreatePhoto,
  handlePhotoCreatePrompt,
  handlePhotoCreateArSelect,
} from "./scenes/photo-create.js";
import {
  handlePhotoUpscaleEnter,
  handlePhotoUpscalePhoto,
  handleVideoUpscaleEnter,
  handleVideoUpscaleVideo,
  handleUpscaleFactorSelect,
  isVideoDocument,
  isImageDocument,
} from "./scenes/upscale.js";
import { handleNoTool } from "./handlers/no-tool.handler.js";
import {
  handleNewGptDialog,
  handleGptMessage,
  handleGptPhoto,
  handleGptDocument,
  handleGptVoice,
} from "./scenes/gpt.js";
import {
  buildDesignModelKeyboard,
  handleDesignModelSelect,
  handleDesignFamilySelect,
  handleDesignMessage,
  handleDesignVoice,
  handleDesignPhoto,
  handleDesignMediaInput,
  handleDesignMediaInputCancel,
  handleDesignMediaInputDone,
  handleDesignMediaInputRemove,
  handleDesignGenerateNoPrompt,
} from "./scenes/design.js";
import {
  handleVideoModelSelect,
  handleVideoFamilySelect,
  handleVideoExtendEntry,
  handleVideoMessage,
  handleVideoPhoto,
  handleVideoVideo,
  handleVideoVoice,
  handleVideoAvatarVoiceCallback,
  handleVideoTranscribeCallback,
  handleNewVideoDialog,
  handleVideoAvatars,
  handleAvatarPhotoCapture,
  handleHeygenAvatarCancel,
  handleSoulPhotoCapture,
  handleSoulCreateSubmit,
  handleSoulCreateCancel,
  handleVideoMediaInput,
  handleVideoMediaInputCancel,
  handleVideoMediaInputDone,
  handleVideoMediaInputRemove,
  handleVideoGenerateNoPrompt,
} from "./scenes/video.js";
import { handleModeSet, handleChangeMode } from "./scenes/mode-select.js";
import {
  handleRefineEntry,
  handleRefineUseActive,
  handleRefineChooseModel,
  handleRefineSection,
  handleRefineFamily,
  handleRefineModel,
  handleRefineSlot,
  handleRefineReplace,
  handleRefineAdd,
} from "./scenes/refine.js";
import {
  handleAudioSubSection,
  handleAudioMessage,
  handleAudioVoice,
  handleVoiceCloneUpload,
} from "./scenes/audio.js";
import {
  handleDeleteCodeInput,
  handleDeleteConfirm,
  handleDeleteCancel,
} from "./scenes/account-delete.js";
import { handleSendOriginal } from "./handlers/send-original.handler.js";
import { getActiveSlot } from "./utils/media-input-state.js";
import { handleVoicePromptCallback } from "./handlers/voice-prompt.handler.js";
import { handleLowIqStart, handleLowIqCancel } from "./utils/confirm-generation.js";
import {
  handleMergeChoice,
  handleMergeCancel,
  handleMergeConfirm,
} from "./handlers/merge-conflict.handler.js";
import { handlePreCheckoutQuery, handleSuccessfulPayment } from "./scenes/payment.js";
import { userStateService } from "@metabox/api/services";
import { getT, config } from "@metabox/shared";
import { rateLimitMiddleware } from "./middlewares/rate-limit.middleware.js";
import { logger } from "./logger.js";
import { acquireLock } from "./utils/dedup.js";

export function createBot(token: string): Bot<BotContext> {
  // Route to Telegram's Test DC when the token comes from @BotFather in test
  // env — otherwise every Bot API call returns 401 Unauthorized. Enabled via
  // TELEGRAM_TEST_ENV=1 (see config.bot.testEnvironment).
  const bot = new Bot<BotContext>(
    token,
    config.bot.testEnvironment ? { client: { environment: "test" } } : undefined,
  );

  // ── Coalesce auto-split long messages — должен идти ДО sequentialize.
  //    После sequentialize апдейты ждут друг друга по чату; второй кусок
  //    split'а застрянет в очереди и склейка не произойдёт. До sequentialize
  //    апдейты параллельны, coalesce ловит оба чанка одновременно.
  bot.use(messageCoalescingMiddleware);

  // ── Sequentialize updates per chat (must be the very first middleware so
  //    every downstream handler — auth, i18n, scenes, addMediaInput etc. — is
  //    serialized per chat). Without this, two photos from a media group race
  //    each other in addMediaInput's read-modify-write and one gets overwritten.
  bot.use(sequentialize((ctx) => ctx.chat?.id.toString()));

  // ── Dedup: skip updates Telegram re-delivers after a bot restart ─────────
  // Stores update_id in Redis for 5 min. If the same update_id arrives again
  // (Telegram re-delivery) we drop it silently before any processing occurs.
  // Fails open: if Redis is unavailable we let the update through rather than
  // blocking all traffic.
  bot.use(async (ctx, next) => {
    const key = `dedup:upd:${ctx.update.update_id}`;
    try {
      if (!(await acquireLock(key, 300))) {
        logger.warn(
          { updateId: ctx.update.update_id },
          "duplicate update_id, skipping re-delivery",
        );
        return;
      }
    } catch (err) {
      logger.error(
        { err, updateId: ctx.update.update_id },
        "dedup: Redis unavailable, passing through",
      );
    }
    return next();
  });

  // ── Raw update logger — every incoming update at debug level ────────────
  bot.use(async (ctx, next) => {
    const updateType = Object.keys(ctx.update)
      .filter((k) => k !== "update_id")
      .join(",");

    if (logger.isLevelEnabled("debug")) {
      const msg = ctx.message ?? ctx.editedMessage;
      const preview: Record<string, unknown> = {};
      if (msg?.text !== undefined) {
        preview.text =
          msg.text.length > 80
            ? `${msg.text.slice(0, 80)}…(${msg.text.length - 80} more)`
            : msg.text;
      }
      if (msg?.caption !== undefined) {
        preview.caption =
          msg.caption.length > 80
            ? `${msg.caption.slice(0, 80)}…(${msg.caption.length - 80} more)`
            : msg.caption;
      }
      if (msg?.photo) preview.photo = msg.photo.length;
      if (msg?.video) preview.video = msg.video.file_id;
      if (msg?.voice) preview.voice = msg.voice.file_id;
      if (msg?.audio) preview.audio = msg.audio.file_id;
      if (msg?.document)
        preview.document = { mime: msg.document.mime_type, name: msg.document.file_name };
      if (msg?.media_group_id) preview.mediaGroupId = msg.media_group_id;
      if (msg?.successful_payment)
        preview.successfulPayment = {
          currency: msg.successful_payment.currency,
          amount: msg.successful_payment.total_amount,
        };
      if (ctx.callbackQuery?.data) preview.callbackData = ctx.callbackQuery.data;
      if (ctx.preCheckoutQuery)
        preview.preCheckoutQuery = {
          currency: ctx.preCheckoutQuery.currency,
          amount: ctx.preCheckoutQuery.total_amount,
        };

      logger.debug(
        {
          updateId: ctx.update.update_id,
          updateType,
          userId: ctx.from?.id,
          chatId: ctx.chat?.id,
          ...(Object.keys(preview).length ? { preview } : {}),
        },
        "bot update",
      );
    }

    // Keep payment-related updates at info level for visibility.
    if (updateType.includes("pre_checkout") || updateType.includes("payment")) {
      logger.info({ updateType, updateId: ctx.update.update_id }, "RAW UPDATE (payment-related)");
    }
    try {
      return next();
    } finally {
      logger.debug(
        { updateid: ctx.update.update_id, updateType, userId: ctx.from?.id, chatId: ctx.chat?.id },
        "finished processing update finished",
      );
    }
  });

  // ── Global middlewares ───────────────────────────────────────────────────
  bot.use(authMiddleware);
  bot.use(i18nMiddleware);
  bot.use(rateLimitMiddleware);

  // ── Private chats only — ignore all group/channel updates ────────────────
  // Updates without ctx.chat (e.g. pre_checkout_query) must always pass through.
  bot.use(async (ctx, next) => {
    if (!ctx.chat || ctx.chat.type === "private") return next();
  });

  // ── Registration gate ────────────────────────────────────────────────────
  // authMiddleware теперь не создаёт юзера автоматически — `ctx.user` будет
  // undefined, если юзер ещё не запускал бота или удалил аккаунт. Любое
  // сообщение от такого пользователя (кроме самого `/start`) получает
  // bilingual reminder: «нажмите /start или используйте реферальную ссылку».
  bot.use(async (ctx, next) => {
    if (ctx.user) return next();
    // /start — единственный путь регистрации (handleStart сам делает upsert).
    if (ctx.message?.text?.startsWith("/start")) return next();
    // Telegram Stars / successful_payment — не блокируем (теоретический edge case).
    if (ctx.preCheckoutQuery || ctx.message?.successful_payment) return next();

    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery().catch(() => void 0);
    }
    if (ctx.chat) {
      const ru = getT("ru");
      const en = getT("en");
      await ctx
        .reply(`${ru.errors.notRegistered}\n\n${en.errors.notRegistered}`)
        .catch(() => void 0);
    }
  });

  // ── Commands ─────────────────────────────────────────────────────────────
  bot.command("start", handleStart);
  bot.command("menu", handleMenu);
  bot.command("profile", async (ctx) => {
    const webappUrl = config.bot.webappUrl;
    if (!webappUrl || !ctx.t) return;
    const kb = new InlineKeyboard().webApp(ctx.t.menu.profile, `${webappUrl}?page=profile`);
    await ctx.reply(ctx.t.menu.profile, { reply_markup: kb });
  });
  bot.command("gpt", handleGpt);
  bot.command("design", handleDesign);
  bot.command("audio", handleAudio);
  bot.command("video", handleVideo);

  // ── In-menu language change (keeps current state, no welcome/balance) ────
  bot.callbackQuery(/^langset_/, handleLanguageChangeSelect);

  // ── Onboarding "Got it" callback ──────────────────────────────────────────
  bot.callbackQuery("onboarding_ok", handleOnboardingOk);

  // ── Design model selection callback ──────────────────────────────────────
  bot.callbackQuery(/^design_model_/, handleDesignModelSelect);
  bot.callbackQuery(/^design_family_/, handleDesignFamilySelect);

  // ── Design reference (img2img) callback ───────────────────────────────────
  // ── Refine flow (cross-section) ────────────────────────────────────────────
  bot.callbackQuery(/^design_ref_/, handleRefineEntry);
  bot.callbackQuery(/^ref_use:/, handleRefineUseActive);
  bot.callbackQuery(/^ref_choose:/, handleRefineChooseModel);
  bot.callbackQuery(/^ref_sec:/, handleRefineSection);
  bot.callbackQuery(/^ref_fam:/, handleRefineFamily);
  bot.callbackQuery(/^ref_mdl:/, handleRefineModel);
  bot.callbackQuery(/^ref_slt:/, handleRefineSlot);
  bot.callbackQuery(/^ref_rep:/, handleRefineReplace);
  bot.callbackQuery(/^ref_add:/, handleRefineAdd);

  // ── Video model selection callback ───────────────────────────────────────
  bot.callbackQuery(/^video_model_/, handleVideoModelSelect);
  bot.callbackQuery(/^video_family_/, handleVideoFamilySelect);
  bot.callbackQuery(/^video_extend_/, handleVideoExtendEntry);

  // ── Mode picker callback (video + design) ────────────────────────────────
  bot.callbackQuery(/^mode:/, handleModeSet);
  bot.callbackQuery(/^change_mode:/, handleChangeMode);

  // ── Media input slot callbacks ────────────────────────────────────────────
  bot.callbackQuery(/^mi:video:/, handleVideoMediaInput);
  bot.callbackQuery(/^mi:design:/, handleDesignMediaInput);
  bot.callbackQuery(/^mi_cancel:video$/, handleVideoMediaInputCancel);
  bot.callbackQuery(/^mi_cancel:design$/, handleDesignMediaInputCancel);
  bot.callbackQuery(/^mi_done:/, async (ctx) => {
    const section = ctx.user ? getActiveSlot(ctx.user.id)?.section : undefined;
    if (section === "design") {
      await handleDesignMediaInputDone(ctx);
    } else {
      await handleVideoMediaInputDone(ctx);
    }
  });
  bot.callbackQuery(/^mi_generate:video$/, handleVideoGenerateNoPrompt);
  bot.callbackQuery(/^mi_generate:design$/, handleDesignGenerateNoPrompt);
  bot.callbackQuery(/^mi_remove:video:/, handleVideoMediaInputRemove);
  bot.callbackQuery(/^mi_remove:design:/, handleDesignMediaInputRemove);

  // ── Send original file callback ───────────────────────────────────────────
  bot.callbackQuery(/^orig_/, handleSendOriginal);

  // ── Ready-made scenarios (Готовые сценарии) ──────────────────────────────
  bot.callbackQuery(/^scenario:/, async (ctx) => {
    const which = ctx.callbackQuery.data.split(":")[1];
    await ctx.answerCallbackQuery();
    if (which === "face_swap") return handleFaceSwapEnter(ctx);
    if (which === "clothing_tryon") return handleClothingTryonEnter(ctx);
    if (which === "bg_removal") return handleBackgroundRemovalEnter(ctx);
    if (which === "object_removal") return handleObjectRemovalEnter(ctx);
    if (which === "photo_animate") return handlePhotoAnimateEnter(ctx);
    if (which === "photo_upscale") return handlePhotoUpscaleEnter(ctx);
    if (which === "video_upscale") return handleVideoUpscaleEnter(ctx);
    if (which === "photo_create") return handlePhotoCreateEnter(ctx);
  });
  bot.callbackQuery(/^upscale:/, handleUpscaleFactorSelect);
  bot.callbackQuery(/^photo_create:ar:/, handlePhotoCreateArSelect);

  // ── HeyGen avatar creation cancel ────────────────────────────────────────
  bot.callbackQuery("heygen_avatar_cancel", handleHeygenAvatarCancel);

  // ── Higgsfield Soul character creation ──────────────────────────────────
  bot.callbackQuery("soul_create_submit", handleSoulCreateSubmit);
  bot.callbackQuery("soul_create_cancel", handleSoulCreateCancel);

  // ── Merge conflict resolution callbacks ────────────────────────────────────
  bot.callbackQuery(/^merge:(site|bot):/, handleMergeChoice);
  bot.callbackQuery("merge:cancel", handleMergeCancel);
  bot.callbackQuery(/^merge_confirm:(site|bot):/, handleMergeConfirm);

  // ── Низкий IQ мод: подтверждение перед запуском генерации ─────────────────
  bot.callbackQuery("lqg:start", handleLowIqStart);
  bot.callbackQuery("lqg:cancel", handleLowIqCancel);

  // ── Section picker callback (from noTool fallback) ───────────────────────
  bot.callbackQuery(/^section:/, async (ctx) => {
    const section = ctx.callbackQuery.data.split(":")[1];
    await ctx.answerCallbackQuery();
    await ctx.deleteMessage().catch(() => void 0);
    if (section === "gpt") return handleGpt(ctx);
    if (section === "design") return handleDesign(ctx);
    if (section === "audio") return handleAudio(ctx);
    if (section === "video") return handleVideo(ctx);
  });

  // ── Account deletion callbacks ────────────────────────────────────────────
  bot.callbackQuery("account_delete:confirm", handleDeleteConfirm);
  bot.callbackQuery("account_delete:cancel", handleDeleteCancel);

  // ── Voice transcription prompt callback ──────────────────────────────────
  bot.callbackQuery(/^vp:/, handleVoicePromptCallback);
  // ── Video avatar voice choice callbacks ─────────────────────────────────
  bot.callbackQuery(/^va:/, handleVideoAvatarVoiceCallback);
  bot.callbackQuery(/^vt:/, handleVideoTranscribeCallback);

  // ── Audio model selection callback ───────────────────────────────────────
  bot.callbackQuery(/^audio_model:/, async (ctx) => {
    const modelId = ctx.callbackQuery.data.split(":")[1];
    await ctx.answerCallbackQuery();
    await ctx.deleteMessage().catch(() => void 0);
    await handleAudioSubSection(ctx, modelId);
  });

  // ── Reply keyboard — menu navigation ─────────────────────────────────────
  // Translation keys are resolved at runtime after i18n middleware runs.
  bot.on("message:text", async (ctx, next) => {
    const t = ctx.t;
    const text = ctx.message.text;

    const menuMap: Record<string, () => Promise<void>> = {
      [t.menu.gpt]: () => handleGpt(ctx),
      [t.menu.design]: () => handleDesign(ctx),
      [t.menu.audio]: () => handleAudio(ctx),
      [t.menu.video]: () => handleVideo(ctx),
      [t.menu.scenarios]: () => handleScenarios(ctx),
      [t.scenarios.chooseScenario]: async () => {
        await ctx.reply(t.scenarios.sectionTooltip, {
          reply_markup: buildScenariosKeyboard(t),
        });
      },
      [t.scenarios.backToMain]: () => handleMenu(ctx),
      [t.common.backToMain]: () => handleMenu(ctx),
      [t.gpt.backToMain]: () => handleMenu(ctx),
      [t.design.backToMain]: () => handleMenu(ctx),
      [t.audio.backToMain]: () => handleMenu(ctx),
      [t.video.backToMain]: () => handleMenu(ctx),
      // GPT section buttons
      [t.gpt.newDialog]: () => handleNewGptDialog(ctx),
      // [t.gpt.prompts]: () => handleGptPrompts(ctx),
      // Design section buttons
      [t.design.chooseModel]: async () => {
        await ctx.reply(t.design.sectionTitle, { reply_markup: buildDesignModelKeyboard() });
      },
      // Video section buttons
      [t.video.newDialog]: () => handleNewVideoDialog(ctx),
      [t.video.avatars]: () => handleVideoAvatars(ctx),
      [t.video.lipSync]: () => handleVideoAvatars(ctx),
      // Language button — inline language picker (no state change)
      [t.menu.language]: () => handleLanguageMenu(ctx),
      // Help button — send inline link to support chat
      [t.menu.help]: async () => {
        await ctx.reply(ctx.t.menu.help, {
          reply_markup: new InlineKeyboard().url(
            ctx.t.start.support,
            "https://t.me/metaboxsupport",
          ),
        });
      },
      // Audio section buttons
      [t.audio.tts]: async () => {
        await ctx.reply(t.audio.chooseTtsProvider, {
          reply_markup: new InlineKeyboard()
            .text(t.audio.ttsOpenai, "audio_model:tts-openai")
            .row()
            .text(t.audio.ttsEl, "audio_model:tts-el")
            .row()
            .text(t.audio.ttsCartesia, "audio_model:tts-cartesia"),
        });
      },
      [t.audio.voiceClone]: () => handleAudioSubSection(ctx, "voice-clone"),
      [t.audio.music]: async () => {
        await ctx.reply(t.audio.chooseMusicProvider, {
          reply_markup: new InlineKeyboard()
            .text(t.audio.musicSuno, "audio_model:suno")
            .row()
            .text(t.audio.musicEl, "audio_model:music-el"),
        });
      },
      [t.audio.sounds]: () => handleAudioSubSection(ctx, "sounds-el"),
    };

    const handler = menuMap[text];
    if (handler) return handler();

    return next();
  });

  // ── Telegram Stars payments ───────────────────────────────────────────────
  bot.on("pre_checkout_query", handlePreCheckoutQuery);
  bot.on("message:successful_payment", handleSuccessfulPayment);

  // ── State-based message routing ───────────────────────────────────────────
  bot.on("message", async (ctx, next) => {
    if (!ctx.user) return next();

    const state = await userStateService.get(ctx.user.id);
    if (state?.state === "AWAITING_DELETE_CONFIRMATION") {
      return handleDeleteCodeInput(ctx);
    }
    if (state?.state === "GPT_ACTIVE" || state?.state === "GPT_SECTION") {
      if (ctx.message?.photo) return handleGptPhoto(ctx);
      if (ctx.message?.document?.mime_type?.startsWith("image/")) return handleGptPhoto(ctx);
      if (ctx.message?.document) return handleGptDocument(ctx);
      if (ctx.message?.voice || ctx.message?.audio) return handleGptVoice(ctx);
      return handleGptMessage(ctx);
    }
    if (state?.state === "DESIGN_ACTIVE") {
      // Photo or image file sent in design state → set as img2img reference
      if (ctx.message?.photo) return handleDesignPhoto(ctx);
      if (ctx.message?.document?.mime_type?.startsWith("image/")) return handleDesignPhoto(ctx);
      if (ctx.message?.voice || ctx.message?.audio) return handleDesignVoice(ctx);
      return handleDesignMessage(ctx);
    }
    if (state?.state === "VIDEO_ACTIVE") {
      if (ctx.message?.photo) return handleVideoPhoto(ctx);
      if (ctx.message?.document?.mime_type?.startsWith("image/")) return handleVideoPhoto(ctx);
      if (ctx.message?.video) return handleVideoVideo(ctx);
      if (ctx.message?.document?.mime_type?.startsWith("video/")) return handleVideoVideo(ctx);
      if (ctx.message?.voice || ctx.message?.audio) return handleVideoVoice(ctx);
      return handleVideoMessage(ctx);
    }
    if (state?.state === "HEYGEN_AVATAR_PHOTO") {
      if (ctx.message?.photo) return handleAvatarPhotoCapture(ctx);
      if (ctx.message?.document?.mime_type?.startsWith("image/"))
        return handleAvatarPhotoCapture(ctx);
      return; // ignore non-image messages while waiting for avatar photo
    }
    if (state?.state === "HIGGSFIELD_SOUL_PHOTO") {
      if (ctx.message?.photo) return handleSoulPhotoCapture(ctx);
      if (ctx.message?.document?.mime_type?.startsWith("image/"))
        return handleSoulPhotoCapture(ctx);
      return; // ignore non-image messages while waiting for soul photos
    }
    if (state?.state === "FACE_SWAP_AWAIT_REFERENCE" || state?.state === "FACE_SWAP_AWAIT_FACE") {
      if (ctx.message?.photo) return handleFaceSwapPhoto(ctx);
      if (ctx.message?.document && isImageDocument(ctx.message.document))
        return handleFaceSwapPhoto(ctx);
      await ctx.reply(ctx.t.scenarios.faceSwapNotPhoto);
      return;
    }
    if (
      state?.state === "CLOTHING_TRYON_AWAIT_PERSON" ||
      state?.state === "CLOTHING_TRYON_AWAIT_CLOTHING"
    ) {
      if (ctx.message?.photo) return handleClothingTryonPhoto(ctx);
      if (ctx.message?.document && isImageDocument(ctx.message.document))
        return handleClothingTryonPhoto(ctx);
      await ctx.reply(ctx.t.scenarios.clothingTryonNotPhoto);
      return;
    }
    if (state?.state === "BG_REMOVAL_AWAIT_PHOTO") {
      if (ctx.message?.photo) return handleBackgroundRemovalPhoto(ctx);
      if (ctx.message?.document && isImageDocument(ctx.message.document))
        return handleBackgroundRemovalPhoto(ctx);
      await ctx.reply(ctx.t.scenarios.backgroundRemovalNotPhoto);
      return;
    }
    if (state?.state === "OBJECT_REMOVAL_AWAIT_PHOTO") {
      if (ctx.message?.photo) return handleObjectRemovalPhoto(ctx);
      if (ctx.message?.document && isImageDocument(ctx.message.document))
        return handleObjectRemovalPhoto(ctx);
      await ctx.reply(ctx.t.scenarios.objectRemovalNotPhoto);
      return;
    }
    if (state?.state === "PHOTO_ANIMATE_AWAIT_PHOTO") {
      if (ctx.message?.photo) return handlePhotoAnimatePhoto(ctx);
      if (ctx.message?.document && isImageDocument(ctx.message.document))
        return handlePhotoAnimatePhoto(ctx);
      await ctx.reply(ctx.t.scenarios.photoAnimateNotPhoto);
      return;
    }
    if (state?.state === "OBJECT_REMOVAL_AWAIT_PROMPT") {
      // На шаге описания принимаем text — это основной ввод; фото — как
      // «передумал, заменю фото» (handleObjectRemovalPhoto перезаписывает
      // buffer и возвращает state в AWAIT_PROMPT). Всё остальное (видео,
      // голосовое и т.п.) — мягкая подсказка «опишите фразой».
      if (ctx.message?.text) return handleObjectRemovalPrompt(ctx);
      if (ctx.message?.photo) return handleObjectRemovalPhoto(ctx);
      if (ctx.message?.document && isImageDocument(ctx.message.document))
        return handleObjectRemovalPhoto(ctx);
      await ctx.reply(ctx.t.scenarios.objectRemovalPromptEmpty);
      return;
    }
    if (state?.state === "PHOTO_UPSCALE_AWAIT_PHOTO") {
      if (ctx.message?.photo) return handlePhotoUpscalePhoto(ctx);
      if (ctx.message?.document && isImageDocument(ctx.message.document))
        return handlePhotoUpscalePhoto(ctx);
      await ctx.reply(ctx.t.scenarios.upscaleNotPhoto);
      return;
    }
    if (state?.state === "PHOTO_CREATE_AWAIT_PHOTO") {
      if (ctx.message?.photo) return handlePhotoCreatePhoto(ctx);
      if (ctx.message?.document && isImageDocument(ctx.message.document))
        return handlePhotoCreatePhoto(ctx);
      await ctx.reply(ctx.t.scenarios.photoCreateNotPhoto);
      return;
    }
    if (state?.state === "PHOTO_CREATE_AWAIT_PROMPT") {
      // На шаге описания принимаем text как основной ввод; фото — как
      // «передумал, заменю фото» (handlePhotoCreatePhoto перезаписывает буфер
      // и возвращает state в AWAIT_PROMPT). Прочее — мягкая подсказка.
      if (ctx.message?.text) return handlePhotoCreatePrompt(ctx);
      if (ctx.message?.photo) return handlePhotoCreatePhoto(ctx);
      if (ctx.message?.document && isImageDocument(ctx.message.document))
        return handlePhotoCreatePhoto(ctx);
      await ctx.reply(ctx.t.scenarios.photoCreatePromptEmpty);
      return;
    }
    if (state?.state === "PHOTO_CREATE_AWAIT_AR") {
      // На шаге выбора AR ждём callback с инлайн-клавиатуры. Любое медиа =
      // «передумал, заменю фото» → переход в AWAIT_PHOTO. Текст = новый промпт.
      // Прочее (voice/sticker/video) — мягкая подсказка: «выбери AR ниже или
      // пришли новое фото/описание»; без этого юзер ловит молчание.
      if (ctx.message?.photo) return handlePhotoCreatePhoto(ctx);
      if (ctx.message?.document && isImageDocument(ctx.message.document))
        return handlePhotoCreatePhoto(ctx);
      if (ctx.message?.text) return handlePhotoCreatePrompt(ctx);
      await ctx.reply(ctx.t.scenarios.photoCreateAwaitArHint);
      return;
    }
    if (state?.state === "VIDEO_UPSCALE_AWAIT_VIDEO") {
      if (ctx.message?.video) return handleVideoUpscaleVideo(ctx);
      if (ctx.message?.document && isVideoDocument(ctx.message.document))
        return handleVideoUpscaleVideo(ctx);
      await ctx.reply(ctx.t.scenarios.upscaleNotVideo);
      return;
    }
    if (state?.state === "AUDIO_ACTIVE") {
      if (state.audioModelId === "voice-clone") {
        if (
          ctx.message?.voice ||
          ctx.message?.audio ||
          ctx.message?.document?.mime_type?.startsWith("audio/")
        )
          return handleVoiceCloneUpload(ctx);
        await ctx.reply(ctx.t.audio.voiceCloneNeedsAudio);
        return;
      }
      if (ctx.message?.voice || ctx.message?.audio) return handleAudioVoice(ctx);
      return handleAudioMessage(ctx);
    }

    return next();
  });

  // ── Fallback: no tool selected ────────────────────────────────────────────
  bot.on("message", handleNoTool);

  // ── Error handler ─────────────────────────────────────────────────────────
  bot.catch((err) => {
    const message = err.error instanceof Error ? err.error.message : String(err.error);
    if (
      message.includes("bot was blocked by the user") ||
      message.includes("user is deactivated")
    ) {
      return;
    }
    // pino's default `err` serializer рекурсивно сериализует все поля BotError.
    // `err.ctx` содержит весь BotContext, включая `t` — огромный словарь локалей
    // (~300+ строк), который засоряет лог. Временно прячем `t` на время лога
    // и восстанавливаем сразу после — pino stringify'ит синхронно, так что
    // race с reply ниже невозможен.
    const savedT = err.ctx.t;
    (err.ctx as { t?: unknown }).t = undefined;
    try {
      logger.error({ err, update: err.ctx.update }, "Unhandled bot error");
    } finally {
      (err.ctx as { t?: unknown }).t = savedT;
    }
    const t = err.ctx.t ?? getT("en");
    err.ctx.reply(t.errors.unexpected).catch(() => void 0);
  });

  return bot;
}
