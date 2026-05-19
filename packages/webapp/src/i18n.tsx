import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

export type Locale = "en" | "ru";

const translations = {
  en: {
    // Header
    "app.name": "Metabox",

    // Bottom Nav
    "nav.profile": "Profile",
    "nav.manage": "Manage",
    "nav.learning": "Learning",
    "nav.tariffs": "Tariffs",
    "nav.referral": "Partner",
    "nav.admin": "Admin",

    // Profile tabs
    "profile.tabOverview": "Overview",
    "profile.tabGallery": "Gallery",
    "profile.tabAccount": "Account",
    "profile.tabSettings": "Settings",

    // Profile
    "profile.balance": "Token Balance",
    "profile.balanceSubscription": "From subscription",
    "profile.balancePurchased": "From packages",
    "profile.referrals": "Referrals",
    "profile.txHistory": "Transaction History",
    "profile.noTx": "No transactions yet",
    "profile.reason.welcome_bonus": "🎁 Welcome bonus",
    "profile.reason.ai_usage": "🤖 AI usage",
    "profile.reason.purchase": "💳 Token purchase",
    "profile.reason.metabox_purchase": "💳 Metabox purchase",
    "profile.reason.referral_bonus": "🎁 Referral bonus",
    "profile.reason.admin": "🔧 Admin adjustment",
    "profile.reason.autotranslate": "📜 Autotranslation",
    "profile.reason.describe_image": "🔍 Reference image description",
    "profile.reason.soul_creation": "🧬 Character creation",

    // Profile countdown
    "profile.countdown.expired": "Subscription expired",
    "profile.countdown.day": "day",
    "profile.countdown.days": "days",
    "profile.countdown.hMin": "{h}h {m}min",
    "profile.countdown.minSec": "{m}min {s}sec",
    "profile.until": "until",

    // Account tab
    "account.generationMode": "GENERATION MODE",
    "account.generationModeOn": "With confirmation",
    "account.generationModeOff": "No confirmation",
    "account.generationModeInfoAria": "Generation mode info",
    "account.generationModeInfo":
      "Control how generation starts:\n\n🎯 With confirmation — see the final request and confirm the start manually. Protects from accidental runs and extra spend.\n\n⚡ No confirmation — generation starts automatically after you send a prompt. Handy when you're already an experienced user.",
    "account.notLinked": "Metabox account not linked",
    "account.status": "STATUS",
    "account.statusPartner": "Partner",
    "account.statusClient": "Client",
    "account.statusUser": "User",
    "account.mentor": "MENTOR",
    "account.referralCode": "REFERRAL CODE",
    "account.deleteAccount": "Delete account",
    "account.deleteAccountTitle": "Delete your account?",
    "account.deleteAccountText":
      "This action is irreversible. All your generations, dialogs, avatars, voices and history will be permanently erased.\n\nAre you sure you want to delete your account?",
    "account.deleteAccountConfirm": "Delete",
    "account.deleteCheckBotTitle": "Confirm in bot chat",
    "account.deleteCheckBotText":
      "We sent a confirmation code to your bot chat. Open the bot, send the code, and confirm deletion there.",
    "account.deleteCheckBotClose": "Got it",

    // Banner
    "banner.welcome.title": "Welcome to Metabox",
    "banner.welcome.text": "70+ AI tools in one place",
    "banner.tokens.title": "Get more tokens",
    "banner.tokens.text": "Purchase token packages to unlock all features",
    "banner.referral.title": "Invite friends",
    "banner.referral.text": "Earn bonus tokens for every referral",

    // Management
    "manage.tab.gpt": "GPT",
    "manage.tab.design": "Design",
    "manage.tab.video": "Video",
    "manage.tab.audio": "Audio",
    "manage.tab.uploads": "Voices",
    "audioSettings.title": "Audio Settings",
    "audioSettings.subtitle": "Select a model for audio generation",
    "audioSettings.model": "Model",
    "manage.title": "Dialogs",
    "manage.subtitle": "Manage your AI conversations",
    "manage.newDialog": "＋ New dialog",
    "manage.chooseModel": "Choose a model",
    "manage.noModels": "No models available",
    "manage.noDialogs": "No dialogs yet",
    "manage.noSettings": "No settings available for this model",
    "manage.history": "History",
    "manage.back": "← Back",
    "manage.noMessages": "No messages yet",
    "manage.activate": "Select",
    "manage.filter.images": "🖼 Vision",
    "manage.filter.files": "📄 Files",
    "manage.filter.web": "🌐 Web",
    "manage.filter.family.all": "All",
    "manage.filter.family.openai": "GPT",
    "manage.filter.family.anthropic": "Claude",
    "manage.filter.family.google": "Gemini",
    "manage.filter.family.deepseek": "DeepSeek",
    "manage.filter.family.xai": "Grok",
    "manage.filter.family.perplexity": "Perplexity",
    "manage.filter.family.alibaba": "Qwen",
    "manage.legend.images": "🖼 Vision — can process images",
    "manage.legend.files": "📄 Files — can process documents",
    "manage.legend.web": "🌐 Web — can search the internet",
    "manage.price.perReq": "/req",
    "manage.price.perMsg": "/msg",
    "manage.price.perMPixel": "/MP",
    "manage.price.perSec": "/sec",
    "manage.price.perKChar": "/1K chars",
    "manage.price.gptImageNote":
      "* approximate price. Actual cost depends on input and output data and is known after generation.",
    "manage.dialog.history": "Dialog history",

    // Tariffs
    "tariffs.title": "Tariffs",
    "tariffs.currentBalance": "Current balance",
    "tariffs.tokens": "tokens",
    "tariffs.description":
      "Tokens are used for all AI requests. 1 token ≈ 1 image or 50 GPT messages.",
    "tariffs.subscriptions": "Subscriptions",
    "tariffs.tokenPackages": "Token Packages",
    "tariffs.popular": "Popular",
    "tariffs.buy": "Buy",
    "tariffs.buying": "…",
    "tariffs.note": "Payments are processed securely.",
    "tariffs.note2": "Tokens are credited instantly after payment.",
    "tariffs.openInTg": "Open this page inside Telegram to pay with Stars.",
    "tariffs.success": "tokens credited to your balance!",
    "tariffs.failed": "Payment failed. Please try again.",
    "tariffs.invoiceError": "Could not create invoice. Please try again.",
    "tariffs.choosePayment": "Choose payment method",
    "tariffs.payByStars": "Pay with Stars",
    "tariffs.payByCard": "Pay by Card",
    "tariffs.linkRequired": "Link your Metabox account to pay by card",
    "tariffs.linkAccount": "Link account",
    "tariffs.perMonth": "/month",
    "tariffs.period.M1": "1 mo",
    "tariffs.period.M3": "3 mo",
    "tariffs.period.M6": "6 mo",
    "tariffs.period.M12": "12 mo",
    "tariffs.tokensTotal": "tokens total",
    "tariffs.close": "Close",
    "tariffs.badge.top": "🔥 Top",
    "tariffs.badge.profitable": "💎 Best Value",
    "tariffs.pkgLockedNote":
      "Token packages are only available with an active subscription. First, subscribe to any plan above.",
    "tariffs.pkgLockedBtn": "Subscription required",
    "tariffs.pkgLockedTitle": "Subscription required",
    "tariffs.subRequiredText":
      "Additional token packages are only available with an active subscription. Subscribe to a plan to access token packages.",
    "tariffs.goToSubscriptions": "Go to subscriptions",

    // Referral
    "referral.title": "Referral Program",
    "referral.partnerTitle": "Partner Program",
    "referral.subtitle":
      "Invite friends and earn tokens for every new user who joins via your link.",
    "referral.invited": "Invited",
    "referral.perReferral": "Tokens per referral",
    "referral.rewardPerSub": "per referral with subscription",
    "referral.rewardInfo":
      "Rewards are available to users with an active subscription or a course purchased on {landing_url}. Invite via any link — the referral will be linked to you.",
    "referral.partnerBalance": "Partner Balance",
    "referral.totalEarned": "Total earned",
    "referral.withdraw": "Withdrawal request",
    "referral.yourLink": "Your referral link",
    "referral.copy": "Copy",
    "referral.copied": "✓ Copied!",
    "referral.share": "Share",
    "referral.shareText": "Try Metabox — 70+ AI tools in one Telegram bot! 🚀",
    "referral.botLink": "🤖 Bot link",
    "referral.botLinkHint": "Friend joins the bot — you earn rewards",
    "referral.metaboxLink": "🎓 Site link",
    "referral.metaboxLinkHint": "Friend registers on the platform — you earn rewards",
    "referral.metaboxLinkCta": "Link Metabox account to get this link",
    "referral.howTitle": "How it works",
    "referral.step1": "Share your unique link with friends",
    "referral.step2": "Friend opens the bot via your link",
    "referral.step3": "You both receive bonus tokens",
    "referral.rewardFrom": "from",

    // Avatars page
    "profile.tabAvatars": "Avatars",
    "avatars.filterAll": "All",
    "avatars.filterHeyGen": "HeyGen",
    "avatars.filterSoul": "Soul",
    "avatars.empty": "No avatars yet",
    "avatars.confirmDeleteTitle": "Delete avatar?",
    "avatars.confirmDeleteText": "The avatar will be permanently removed.",

    // Gallery model filter
    "gallery.allModels": "All models",

    // Admin
    "admin.title": "Admin Panel",
    "admin.subtitle": "User management",
    "admin.searchPlaceholder": "Search by name or username…",
    "admin.noUsers": "No users found",
    "admin.role": "Role",
    "admin.balance": "Balance",
    "admin.joined": "Joined",
    "admin.blocked": "Blocked",
    "admin.actions": "Actions",
    "admin.grant": "Grant tokens",
    "admin.grantAmount": "Amount",
    "admin.grantSubmit": "Grant",
    "admin.block": "Block",
    "admin.unblock": "Unblock",
    "admin.makeAdmin": "Make admin",
    "admin.makeModerator": "Make moderator",
    "admin.makeUser": "Make user",
    "admin.totalUsers": "Total users",
    "admin.prevPage": "← Prev",
    "admin.nextPage": "Next →",
    "admin.accessDenied": "Access denied",
    "admin.accessDeniedText": "You don't have admin privileges.",
    "admin.tabUsers": "Users",
    "admin.tabSlides": "Slides",
    "admin.slides.title": "Banner Slides",
    "admin.slides.empty": "No slides yet",
    "admin.slides.add": "Add slide",
    "admin.slides.imageLabel": "Banner image",
    "admin.slides.aspectHint": "Recommended: 3:1 (e.g. 900×300)",
    "admin.slides.chooseFile": "Choose file",
    "admin.slides.linkUrl": "Link URL (optional)",
    "admin.slides.linkPlaceholder": "https://example.com",
    "admin.slides.duration": "Duration (seconds)",
    "admin.slides.save": "Save",
    "admin.slides.cancel": "Cancel",
    "admin.slides.delete": "Delete",
    "admin.slides.confirmDelete": "Delete this slide?",
    "admin.slides.moveUp": "Move up",
    "admin.slides.moveDown": "Move down",
    "admin.slides.active": "Active",
    "admin.slides.inactive": "Inactive",
    "admin.slides.uploading": "Uploading…",

    // Gallery
    "gallery.title": "My Files",
    "gallery.subtitle": "All generated images, audio, and videos",
    "gallery.section.image": "Images",
    "gallery.section.audio": "Audio",
    "gallery.section.video": "Videos",
    "gallery.empty": "No files in this section yet",
    "gallery.download": "Send to chat",
    "gallery.sent": "✓ Sent!",
    "gallery.delete": "Delete",
    "gallery.confirmDeleteTitle": "Delete this generation?",
    "gallery.confirmDeleteText":
      "All files from this request will be removed. This action is irreversible.",
    "gallery.confirmDelete": "Delete",
    "gallery.cancel": "Cancel",
    "gallery.details": "Details",
    "gallery.viewDetails": "View settings & prompt",
    "gallery.downloadOriginal": "Download original",
    "gallery.outputLabel.image": "Image {n}",
    "gallery.outputLabel.video": "Video {n}",
    "gallery.outputLabel.audio": "Audio {n}",
    "gallery.retentionNote":
      "* generations are stored for 60 days and are automatically removed after that.",

    // Download bridge page
    "download.opening": "Opening file in browser…",
    "download.openedInBrowser": "File opened in your browser. You can close this window.",
    "download.fallbackLink": "Open manually",
    "download.invalidToken": "Invalid or expired download link.",
    "gallery.applySettings": "Apply settings",
    "gallery.applied": "✓ Applied",
    "gallery.copyPrompt": "Copy prompt",
    "gallery.copied": "✓ Copied",
    "gallery.prompt": "Prompt",
    "gallery.settings": "Settings",
    "gallery.noSettings": "No additional settings",

    "gallery.morePhotos": "+{n}",
    "gallery.emptyModel": "You haven't generated anything with this AI yet",
    "gallery.tryModel": "Try it",

    "gallery.addToFav": "Add to favorites",
    "gallery.removeFromFav": "Remove from favorites",

    "gallery.folder.favorites": "Favorites",
    "gallery.folder.all": "All",
    "gallery.folder.new": "New folder",
    "gallery.folder.createTitle": "New folder",
    "gallery.folder.editTitle": "Edit folder",
    "gallery.folder.namePlaceholder": "Folder name",
    "gallery.folder.save": "Save",
    "gallery.folder.delete": "Delete",
    "gallery.folder.cancel": "Cancel",
    "gallery.folder.pin": "Pin",
    "gallery.folder.unpin": "Unpin",
    "gallery.folder.addToFolder": "Add to folder",
    "gallery.folder.done": "Done",
    "gallery.folder.empty": "This folder is empty",
    "gallery.folder.noFolders": "You haven't created any folders yet",
    "gallery.folder.createFirst": "Create folder",
    "gallery.folder.deleteConfirmTitle": "Delete folder?",
    "gallery.folder.deleteConfirmText": "Generations will not be deleted.",
    "gallery.folder.selectTitle": "Select folder to edit",

    // Settings
    "settings.title": "Account Settings",
    "settings.email": "Email",
    "settings.password": "Password",
    "settings.newPassword": "New password",
    "settings.confirmPassword": "Confirm password",
    "settings.confirmPasswordPlaceholder": "Repeat password",
    "settings.save": "Save changes",
    "settings.saved": "Settings saved successfully",
    "settings.noChanges": "No changes to save",
    "settings.passwordMismatch": "Passwords do not match",
    "settings.passwordTooShort": "Password must be at least 6 characters",
    "settings.oldPassword": "Current password",
    "settings.oldPasswordPlaceholder": "Current password",
    "settings.wrongPassword": "Current password is incorrect",
    "settings.changePassword": "Change password",
    "settings.verified": "Verified",
    "settings.verify": "Verify email",
    "settings.verificationSent": "Verification email sent! Check your inbox.",

    // Language
    "lang.title": "Language",

    // Common
    "common.loading": "Loading…",
    "common.error": "Error",
    "common.back": "← Back",

    // Link Metabox
    "linkMetabox.title": "Metabox Learning",
    "linkMetabox.subtitle": "Link your Metabox account to access the learning section.",
    // Reason-specific titles/subtitles for the same flow (account linking).
    // The action is the same (register or login on Metabox), but the trigger
    // differs — a subscription card-payment user shouldn't see "learning" copy.
    "linkMetabox.titleSubscription": "Subscription payment",
    "linkMetabox.subtitleSubscription":
      "To pay for the subscription by card, link your Metabox account.",
    "linkMetabox.titleWithdrawal": "Withdrawal request",
    "linkMetabox.subtitleWithdrawal":
      "To request a withdrawal of referral earnings, link your Metabox account.",
    "linkMetabox.newAccount": "Create account",
    "linkMetabox.existingAccount": "I already have an account",
    "linkMetabox.registerHint": "Enter an email and password to create your Metabox account.",
    "linkMetabox.loginHint": "Enter your existing Metabox email and password.",
    "linkMetabox.password": "Password",
    "linkMetabox.confirmPassword": "Confirm password",
    "linkMetabox.confirmPasswordPlaceholder": "Repeat password",
    "linkMetabox.passwordMismatch": "Passwords do not match",
    "linkMetabox.submit": "Continue",
    "linkMetabox.error": "Error. Please check your details and try again.",
    "linkMetabox.error.emailExists": "This email is already registered. Try logging in instead.",
    "linkMetabox.error.emailExists.switchToLogin": "Sign in with this email",
    "linkMetabox.error.telegramLinked":
      "This Telegram account is already linked to a Metabox account.",
    "linkMetabox.error.userNotFound": "No account found with this email.",
    "linkMetabox.error.invalidPassword": "Incorrect password.",
    "linkMetabox.error.emailNotVerified":
      "Email is not verified. Please verify it on the Metabox website.",
    "linkMetabox.error.passwordTooShort": "Password must be at least 6 characters.",

    // Link Metabox — verify-email flow
    "linkMetabox.verify.title": "Verify your email",
    "linkMetabox.verify.subtitle": "We sent a confirmation link to:",
    "linkMetabox.verify.followLink":
      "Open the link in the email, then sign in on the website with your email and password.",
    "linkMetabox.verify.checkSpam":
      "Didn't get the email? Check your Spam folder or request a new one below.",
    "linkMetabox.verify.resend": "Resend email",
    "linkMetabox.verify.resendAgain": "Resend again",
    "linkMetabox.verify.resendCooldown": "Available in {n}s",
    "linkMetabox.verify.changeEmail": "Change email",
    "linkMetabox.verify.sentSuccess":
      "Email sent. Check your inbox — and make sure the address above is correct.",
    "linkMetabox.verify.sent": "Confirmation email sent.",
    "linkMetabox.verify.alreadyVerified":
      "Email is already verified. You can sign in on the website.",
    "linkMetabox.verify.sendError": "Couldn't send the email. Сheck the email you entered.",
    "linkMetabox.verify.limitExhausted":
      "You've hit the resend limit. Please wait a bit, or change the email address below.",

    // Link Metabox — change-email flow
    "linkMetabox.changeEmail.title": "Change email",
    "linkMetabox.changeEmail.subtitle":
      "Enter a new address — we'll update it and send a new confirmation email.",
    "linkMetabox.changeEmail.label": "New email",
    "linkMetabox.changeEmail.save": "Save and send email",
    "linkMetabox.changeEmail.error.exists": "This email is already used by another account.",
    "linkMetabox.changeEmail.error.same": "That's the same email as before.",
    "linkMetabox.changeEmail.error.invalid": "Invalid email format.",
    "linkMetabox.changeEmail.error.alreadyVerified":
      "Email is already verified — changing it through this flow isn't available.",
    "linkMetabox.changeEmail.error.generic": "Couldn't change the email.",

    // Image settings
    "imageSettings.title": "Image Settings",
    "imageSettings.subtitle": "Choose aspect ratio per model",
    "imageSettings.model": "Model",
    "imageSettings.noSupport": "This model doesn't support custom aspect ratios",
    "imageSettings.saved": "✓ Saved",
    "imageSettings.active": "Active",
    "imageSettings.activate": "Activate",
    "imageSettings.activating": "Activating…",
    "imageSettings.activated": "Activated",
    "imageSettings.startWork": "Start working",
    "imageSettings.version": "Version",
    "modelModes.label": "Mode",
    "imageSettings.variant": "Variant",
    "imageSettings.aspectRatio": "Aspect ratio",
    "imageSettings.svgNoRatio": "Vector (SVG) — aspect ratio is set via prompt",
    "imageSettings.otherModels": "Other models",
    "imageSettings.reset": "Reset",
    "imageSettings.resetTitle": "Reset settings to defaults",
    "imageSettings.selectModel": "Select model",
    "imageSettings.activatedPopup": "Model activated. Return to the bot to start using it.",
    "manage.dialogActivatedPopup": "Dialog activated. Return to the chat to work with it.",
    "manage.startChat": "Start chatting",
    "manage.settings": "Settings",
    "manage.delete": "Delete",
    "manage.confirmDelete": "Delete this dialog?",
    "manage.advancedSettings": "Advanced settings",
    "manage.onboardingBanner":
      "\u26a0\ufe0f This app is for settings only. Choose an AI model and parameters, then go back to the Telegram chat \u2014 prompts and results only work there.",

    // Video settings
    "videoSettings.title": "Video Settings",
    "videoSettings.subtitle": "Choose aspect ratio and duration per model",
    "videoSettings.model": "Model",
    "videoSettings.aspectRatio": "Aspect ratio",
    "videoSettings.duration": "Duration",
    "videoSettings.seconds": "s",
    "videoSettings.noAspectSupport": "Fixed aspect ratio",
    "videoSettings.noDurationSupport": "Fixed duration",
    "videoSettings.saved": "✓ Saved",

    // Uploads
    "uploads.title": "My voices",
    "uploads.subtitle": 'Generated voices in the bot\'s "Voice Cloning" section',
    "uploads.empty": "No voices yet.",
    "uploads.emptyVoices":
      "No voices yet. Clone your voice in the Voice Clone section of the audio bot.",
    "uploads.emptyPhotos": "No photos yet. Send a photo to the bot while in HeyGen mode.",
    "uploads.photosTitle": "Photos",
    "uploads.voicesTitle": "Voice recordings",
    "uploads.clonedVoicesTitle": "Cloned voices",
    "uploads.cloneVoiceBtn": "🎙 Clone a voice",
    "uploads.confirmDeleteVoice": "Delete this cloned voice?",
    "uploads.play": "Play",
    "uploads.delete": "Delete",
    "uploads.confirmDelete": "Delete this upload?",
    "uploads.rename": "Rename",
    "uploads.officialVoices": "Official voices",
    "uploads.myVoices": "My voices",
    "uploads.elevenlabsLangHint":
      "The model automatically synthesizes speech in the language the text is written in.",
    "uploads.useVoice": "Use",
    "uploads.voiceActive": "Active",
    "uploads.officialAvatars": "Official avatars",
    "uploads.myPhotos": "My photos",
    "uploads.myAvatars": "My avatars",
    "uploads.createAvatar": "➕ Create avatar",
    "uploads.createHeyGen": "➕ Create HeyGen",
    "uploads.createSoulProvider": "➕ Create Soul",
    "uploads.createAvatarHint":
      "Return to the chat and send a photo with your face — the bot will create a personal avatar based on it.",
    "uploads.createVoice": "➕ Create voice",
    "uploads.createVoiceHint":
      "Return to the chat and send a voice message or audio file — the bot will clone your voice and switch HeyGen back on.",
    "uploads.avatarCreating": "Creating...",
    "uploads.avatarOrphaned": "Unavailable",
    "uploads.avatarOrphanedHint": "This avatar is no longer available. Create a new one.",
    "uploads.emptyAvatars": 'No avatars yet. Click "Create avatar" to start.',
    "uploads.mySouls": "My Characters",
    "uploads.createSoul": "➕ Create Character",
    "uploads.createSoulHint":
      "Return to the chat and send 20+ photos — the bot will create a character based on them.",
    "uploads.noSouls": "No characters yet.",
    "uploads.soulCreating": "Creating...",

    // Auth errors
    "auth.tokenExpired": "Link expired. Press the «Profile» button in the bot menu again.",
    "auth.openFromTelegram": "Please open this app from Telegram",
    "auth.notRegisteredTitle": "Open the bot first",
    "auth.notRegisteredText":
      "To use the mini-app, send the /start command to the bot or follow a friend's referral link.",
    "auth.openBot": "Open bot",

    // Picker shared UI
    "picker.search": "Search…",
    "picker.loading": "Loading…",
    "picker.loadingVoices": "Loading voices…",
    "picker.loadingAvatars": "Loading avatars…",
    "picker.loadMore": "Load more",
    "picker.noVoices": "No voices found",
    "picker.noAvatars": "No avatars found",
    "picker.genderAll": "All",
    "picker.genderM": "M",
    "picker.genderF": "F",
    "picker.langAll": "All languages",
    "picker.providerAll": "All providers",
    "picker.play": "Play",
    "picker.stop": "Stop",
    "picker.loadingPresets": "Loading presets…",
    "picker.noPresets": "No presets found",
    "picker.categoryAll": "All categories",
    "picker.maxMotions":
      "You can select up to {max} presets. If you pick a new one, the oldest will be replaced automatically.",
    "picker.strength": "Strength: {n}",
    "picker.selectedPresets": "Selected: {n} preset(s)",

    // OpenAI voice meta
    "voice.meta.neutral": "Neutral",
    "voice.meta.male": "Male",
    "voice.meta.female": "Female",
    "voice.meta.british": "British",
    "voice.meta.deepMale": "Deep male",
    "voice.meta.calm": "Calm",

    // Link Metabox — merge blocked modal & dynamic errors
    "linkMetabox.merge.blocked": "⛔ Cannot merge accounts",
    "linkMetabox.merge.blockedText": "You have different mentors and both accounts have purchases.",
    "linkMetabox.merge.mentorSite": "Site mentor:",
    "linkMetabox.merge.mentorBot": "Bot mentor:",
    "linkMetabox.merge.support": "If you have any questions, contact support:",
    "linkMetabox.merge.ok": "Got it",
    "linkMetabox.merge.unknown": "Unknown",
    "linkMetabox.error.mentorConflict":
      "Mentor conflict. Site: {site}, Bot: {bot}. To merge, use the AI Box button on the Metabox website.",
    "linkMetabox.error.telegramMismatch":
      "This account is already linked to another Telegram{info}. Log in from that Telegram or contact support @{support}",
    "linkMetabox.error.telegramLinkedOther":
      "Account {name}{info} already has another Telegram linked. Contact support @{support}",
  },
  ru: {
    // Header
    "app.name": "Metabox",

    // Bottom Nav
    "nav.profile": "Профиль",
    "nav.manage": "Управление",
    "nav.learning": "Обучение",
    "nav.tariffs": "Тарифы",
    "nav.referral": "Партнёрка",
    "nav.admin": "Админ",

    // Profile tabs
    "profile.tabOverview": "Обзор",
    "profile.tabGallery": "Галерея",
    "profile.tabAccount": "Аккаунт",
    "profile.tabSettings": "Настройки",

    // Profile
    "profile.balance": "Баланс токенов",
    "profile.balanceSubscription": "Из подписки",
    "profile.balancePurchased": "Из пакетов",
    "profile.referrals": "Рефералы",
    "profile.txHistory": "История транзакций",
    "profile.noTx": "Транзакций пока нет",
    "profile.reason.welcome_bonus": "🎁 Приветственный бонус",
    "profile.reason.ai_usage": "🤖 Использование AI",
    "profile.reason.purchase": "💳 Покупка токенов",
    "profile.reason.metabox_purchase": "💳 Покупка через Metabox",
    "profile.reason.referral_bonus": "🎁 Реферальный бонус",
    "profile.reason.autotranslate": "📜 Автоперевод",
    "profile.reason.describe_image": "🔍 Описание референсного изображения",
    "profile.reason.soul_creation": "🧬 Создание персонажа",
    "profile.reason.admin": "🔧 Корректировка",

    // Profile countdown
    "profile.countdown.expired": "Подписка истекла",
    "profile.countdown.day": "день",
    "profile.countdown.days": "дней",
    "profile.countdown.hMin": "{h} ч {m} мин",
    "profile.countdown.minSec": "{m} мин {s} сек",
    "profile.until": "до",

    // Account tab
    "account.generationMode": "РЕЖИМ ГЕНЕРАЦИИ",
    "account.generationModeOn": "С подтверждением",
    "account.generationModeOff": "Без подтверждения",
    "account.generationModeInfoAria": "Информация о режиме генерации",
    "account.generationModeInfo":
      "Управляйте тем, как запускается генерация:\n\n🎯 С подтверждением — увидите финальный запрос и подтвердите старт вручную. Защищает от случайных запусков и лишних трат.\n\n⚡ Без подтверждения — генерация начнётся автоматически после отправки промпта. Удобно, когда вы уже опытный пользователь.",
    "account.notLinked": "Аккаунт Metabox не привязан",
    "account.status": "СТАТУС",
    "account.statusPartner": "Партнёр",
    "account.statusClient": "Клиент",
    "account.statusUser": "Пользователь",
    "account.mentor": "НАСТАВНИК",
    "account.referralCode": "РЕФЕРАЛЬНЫЙ КОД",
    "account.deleteAccount": "Удалить аккаунт",
    "account.deleteAccountTitle": "Удалить аккаунт?",
    "account.deleteAccountText":
      "Это действие необратимо. Все ваши генерации, диалоги, аватары, голоса и история будут удалены безвозвратно.\n\nВы точно хотите удалить аккаунт?",
    "account.deleteAccountConfirm": "Удалить",
    "account.deleteCheckBotTitle": "Подтвердите в чате бота",
    "account.deleteCheckBotText":
      "Мы отправили код подтверждения в чат бота. Вернитесь в чат, отправьте код и подтвердите удаление там.",
    "account.deleteCheckBotClose": "Понятно",

    // Banner
    "banner.welcome.title": "Добро пожаловать",
    "banner.welcome.text": "70+ AI инструментов в одном месте",
    "banner.tokens.title": "Больше токенов",
    "banner.tokens.text": "Покупайте пакеты для доступа ко всем функциям",
    "banner.referral.title": "Пригласи друзей",
    "banner.referral.text": "Получай бонусные токены за каждого реферала",

    // Management
    "manage.tab.gpt": "GPT",
    "manage.tab.design": "Дизайн",
    "manage.tab.video": "Видео",
    "manage.tab.audio": "Аудио",
    "manage.tab.uploads": "Голоса",
    "audioSettings.title": "Настройки аудио",
    "audioSettings.subtitle": "Выберите модель для генерации аудио",
    "audioSettings.model": "Модель",
    "manage.title": "Диалоги",
    "manage.subtitle": "Управление AI-диалогами",
    "manage.newDialog": "＋ Новый диалог",
    "manage.chooseModel": "Выберите модель",
    "manage.noModels": "Нет доступных моделей",
    "manage.noDialogs": "Диалогов пока нет",
    "manage.noSettings": "Для этой модели настроек нет",
    "manage.history": "История",
    "manage.back": "← Назад",
    "manage.noMessages": "Сообщений пока нет",
    "manage.activate": "Выбрать",
    "manage.filter.images": "🖼 Зрение",
    "manage.filter.files": "📄 Файлы",
    "manage.filter.web": "🌐 Веб",
    "manage.filter.family.all": "Все",
    "manage.filter.family.openai": "GPT",
    "manage.filter.family.anthropic": "Claude",
    "manage.filter.family.google": "Gemini",
    "manage.filter.family.deepseek": "DeepSeek",
    "manage.filter.family.xai": "Grok",
    "manage.filter.family.perplexity": "Perplexity",
    "manage.filter.family.alibaba": "Qwen",
    "manage.legend.images": "🖼 Зрение — понимает изображения",
    "manage.legend.files": "📄 Файлы — работает с документами",
    "manage.legend.web": "🌐 Веб — ищет в интернете",
    "manage.price.perReq": "/запрос",
    "manage.price.perMsg": "/сообщение",
    "manage.price.perMPixel": "/мегапиксель",
    "manage.price.perSec": "/сек",
    "manage.price.perKChar": "/1К симв.",
    "manage.price.gptImageNote":
      "* примерная цена. Фактическая цена расчитывается на основании входных и выходных данных и будет известна после генерации.",
    "manage.dialog.history": "История диалога",

    // Tariffs
    "tariffs.title": "Тарифы",
    "tariffs.currentBalance": "Текущий баланс",
    "tariffs.tokens": "токенов",
    "tariffs.description":
      "Токены используются для всех AI-запросов. 1 токен ≈ 1 изображение или 50 GPT-сообщений.",
    "tariffs.subscriptions": "Подписки",
    "tariffs.tokenPackages": "Пакеты токенов",
    "tariffs.popular": "Популярный",
    "tariffs.buy": "Купить",
    "tariffs.buying": "…",
    "tariffs.note": "Оплата проводится безопасно.",
    "tariffs.note2": "Токены зачисляются мгновенно после оплаты.",
    "tariffs.openInTg": "Откройте страницу в Telegram для оплаты через Stars.",
    "tariffs.success": "токенов зачислено на ваш баланс!",
    "tariffs.failed": "Оплата не удалась. Попробуйте снова.",
    "tariffs.invoiceError": "Не удалось создать счёт. Попробуйте снова.",
    "tariffs.choosePayment": "Выберите способ оплаты",
    "tariffs.payByStars": "Оплатить Stars",
    "tariffs.payByCard": "Оплатить картой",
    "tariffs.linkRequired": "Привяжите аккаунт Metabox для оплаты картой",
    "tariffs.linkAccount": "Привязать аккаунт",
    "tariffs.perMonth": "/мес",
    "tariffs.period.M1": "1 мес",
    "tariffs.period.M3": "3 мес",
    "tariffs.period.M6": "6 мес",
    "tariffs.period.M12": "12 мес",
    "tariffs.tokensTotal": "токенов всего",
    "tariffs.close": "Закрыть",
    "tariffs.badge.top": "🔥 Топ",
    "tariffs.badge.profitable": "💎 Выгодно",
    "tariffs.pkgLockedNote":
      "Докупить пакеты токенов можно только при активной подписке. Сначала оформите любой тариф выше.",
    "tariffs.pkgLockedBtn": "Нужна подписка",
    "tariffs.pkgLockedTitle": "Подписка обязательна",
    "tariffs.subRequiredText":
      "Покупка дополнительных токенов доступна только при активной подписке. Оформите подписку, чтобы получить доступ к пакетам токенов.",
    "tariffs.goToSubscriptions": "Перейти к подпискам",

    // Referral / Partner
    "referral.title": "Реферальная программа",
    "referral.partnerTitle": "Партнёрка",
    "referral.subtitle": "Приглашайте друзей и получайте токены за каждого нового пользователя.",
    "referral.invited": "Приглашено",
    "referral.perReferral": "Токенов за реферала",
    "referral.rewardPerSub": "за реферала с подпиской",
    "referral.rewardInfo":
      "Вознаграждения начисляются пользователям с активной подпиской на бота или с приобретённым курсом/пакетом курсов на {landing_url}. Приглашайте по любой из ссылок — реферал будет закреплён за вами.",
    "referral.partnerBalance": "Партнёрский баланс",
    "referral.totalEarned": "Всего заработано",
    "referral.withdraw": "Заявка на вывод",
    "referral.yourLink": "Ваша реферальная ссылка",
    "referral.copy": "Копировать",
    "referral.copied": "✓ Скопировано!",
    "referral.share": "Поделиться",
    "referral.shareText": "Попробуй Metabox — 70+ AI инструментов в одном Telegram-боте! 🚀",
    "referral.botLink": "🤖 Ссылка на бота",
    "referral.botLinkHint": "Друг присоединяется к боту — вы получаете вознаграждение",
    "referral.metaboxLink": "🎓 Ссылка на сайт",
    "referral.metaboxLinkHint": "Друг регистрируется на платформе — вы получаете вознаграждение",
    "referral.metaboxLinkCta": "Привяжите аккаунт Metabox, чтобы получить эту ссылку",
    "referral.howTitle": "Как это работает",
    "referral.step1": "Поделитесь своей ссылкой с друзьями",
    "referral.step2": "Друг открывает бота по вашей ссылке",
    "referral.step3": "Вы оба получаете бонусные токены",
    "referral.rewardFrom": "от",

    // Avatars page
    "profile.tabAvatars": "Аватары",
    "avatars.filterAll": "Все",
    "avatars.filterHeyGen": "HeyGen",
    "avatars.filterSoul": "Soul",
    "avatars.empty": "Аватаров пока нет",
    "avatars.confirmDeleteTitle": "Удалить аватар?",
    "avatars.confirmDeleteText": "Аватар будет удалён без возможности восстановления.",

    // Gallery model filter
    "gallery.allModels": "Все модели",

    // Admin
    "admin.title": "Админ-панель",
    "admin.subtitle": "Управление пользователями",
    "admin.searchPlaceholder": "Поиск по имени или логину…",
    "admin.noUsers": "Пользователи не найдены",
    "admin.role": "Роль",
    "admin.balance": "Баланс",
    "admin.joined": "Дата регистрации",
    "admin.blocked": "Заблокирован",
    "admin.actions": "Действия",
    "admin.grant": "Начислить токены",
    "admin.grantAmount": "Количество",
    "admin.grantSubmit": "Начислить",
    "admin.block": "Заблокировать",
    "admin.unblock": "Разблокировать",
    "admin.makeAdmin": "Сделать админом",
    "admin.makeModerator": "Сделать модератором",
    "admin.makeUser": "Сделать юзером",
    "admin.totalUsers": "Всего пользователей",
    "admin.prevPage": "← Назад",
    "admin.nextPage": "Далее →",
    "admin.accessDenied": "Доступ запрещён",
    "admin.accessDeniedText": "У вас нет прав администратора.",
    "admin.tabUsers": "Пользователи",
    "admin.tabSlides": "Слайды",
    "admin.slides.title": "Баннерные слайды",
    "admin.slides.empty": "Слайдов пока нет",
    "admin.slides.add": "Добавить слайд",
    "admin.slides.imageLabel": "Изображение баннера",
    "admin.slides.aspectHint": "Рекомендуемое: 3:1 (напр. 900×300)",
    "admin.slides.chooseFile": "Выбрать файл",
    "admin.slides.linkUrl": "Ссылка (необязательно)",
    "admin.slides.linkPlaceholder": "https://example.com",
    "admin.slides.duration": "Длительность (секунды)",
    "admin.slides.save": "Сохранить",
    "admin.slides.cancel": "Отмена",
    "admin.slides.delete": "Удалить",
    "admin.slides.confirmDelete": "Удалить этот слайд?",
    "admin.slides.moveUp": "Вверх",
    "admin.slides.moveDown": "Вниз",
    "admin.slides.active": "Активен",
    "admin.slides.inactive": "Неактивен",
    "admin.slides.uploading": "Загрузка…",

    // Gallery
    "gallery.title": "Мои файлы",
    "gallery.subtitle": "Все сгенерированные изображения, аудио и видео",
    "gallery.section.image": "Изображения",
    "gallery.section.audio": "Аудио",
    "gallery.section.video": "Видео",
    "gallery.empty": "В этом разделе пока нет файлов",
    "gallery.download": "Отправить в чат",
    "gallery.sent": "✓ Отправлено!",
    "gallery.delete": "Удалить",
    "gallery.confirmDeleteTitle": "Удалить генерацию?",
    "gallery.confirmDeleteText": "Будут удалены все файлы по этому запросу. Действие необратимо.",
    "gallery.confirmDelete": "Удалить",
    "gallery.cancel": "Отмена",
    "gallery.details": "Подробнее",
    "gallery.viewDetails": "Настройки и промпт",
    "gallery.downloadOriginal": "Скачать оригинал",
    "gallery.outputLabel.image": "Изображение {n}",
    "gallery.outputLabel.video": "Видео {n}",
    "gallery.outputLabel.audio": "Аудио {n}",
    "gallery.retentionNote":
      "* генерация хранится 60 дней и будет автоматически удалена по истечении времени",

    // Download bridge page
    "download.opening": "Открываем файл в браузере…",
    "download.openedInBrowser": "Файл открыт в браузере. Это окно можно закрыть.",
    "download.fallbackLink": "Открыть вручную",
    "download.invalidToken": "Ссылка на скачивание недействительна или устарела.",
    "gallery.applySettings": "Применить настройки",
    "gallery.applied": "✓ Применено",
    "gallery.copyPrompt": "Скопировать промпт",
    "gallery.copied": "✓ Скопировано",
    "gallery.prompt": "Промпт",
    "gallery.settings": "Настройки",
    "gallery.noSettings": "Дополнительных настроек нет",

    "gallery.morePhotos": "+{n}",
    "gallery.emptyModel": "Вы ещё ничего не генерировали с этой нейросетью",
    "gallery.tryModel": "Попробовать",

    "gallery.addToFav": "В избранное",
    "gallery.removeFromFav": "Убрать из избранного",

    "gallery.folder.favorites": "Избранное",
    "gallery.folder.all": "Все",
    "gallery.folder.new": "Новая папка",
    "gallery.folder.createTitle": "Новая папка",
    "gallery.folder.editTitle": "Редактировать папку",
    "gallery.folder.namePlaceholder": "Название папки",
    "gallery.folder.save": "Сохранить",
    "gallery.folder.delete": "Удалить",
    "gallery.folder.cancel": "Отмена",
    "gallery.folder.pin": "Закрепить",
    "gallery.folder.unpin": "Открепить",
    "gallery.folder.addToFolder": "Добавить в папку",
    "gallery.folder.done": "Готово",
    "gallery.folder.empty": "В этой папке пусто",
    "gallery.folder.noFolders": "У вас пока нет ни одной папки",
    "gallery.folder.createFirst": "Создать папку",
    "gallery.folder.deleteConfirmTitle": "Удалить папку?",
    "gallery.folder.deleteConfirmText": "Генерации удалены не будут.",
    "gallery.folder.selectTitle": "Выберите папку",

    // Settings
    "settings.title": "Настройки аккаунта",
    "settings.email": "Email",
    "settings.password": "Пароль",
    "settings.newPassword": "Новый пароль",
    "settings.confirmPassword": "Подтвердите пароль",
    "settings.confirmPasswordPlaceholder": "Повторите пароль",
    "settings.save": "Сохранить изменения",
    "settings.saved": "Настройки сохранены",
    "settings.noChanges": "Нет изменений для сохранения",
    "settings.passwordMismatch": "Пароли не совпадают",
    "settings.passwordTooShort": "Пароль должен быть не менее 6 символов",
    "settings.oldPassword": "Текущий пароль",
    "settings.oldPasswordPlaceholder": "Текущий пароль",
    "settings.wrongPassword": "Текущий пароль неверен",
    "settings.changePassword": "Смена пароля",
    "settings.verified": "Подтверждён",
    "settings.verify": "Подтвердить email",
    "settings.verificationSent": "Письмо для подтверждения отправлено! Проверьте почту.",

    // Language
    "lang.title": "Язык",

    // Common
    "common.loading": "Загрузка…",
    "common.error": "Ошибка",
    "common.back": "← Назад",

    // Link Metabox
    "linkMetabox.title": "Обучение Metabox",
    "linkMetabox.subtitle": "Привяжите аккаунт Metabox, чтобы открыть раздел обучения.",
    // Reason-specific titles/subtitles — действие то же (привязка аккаунта),
    // но контекст отличается. Юзер платит картой не должен видеть "обучение".
    "linkMetabox.titleSubscription": "Оплата подписки",
    "linkMetabox.subtitleSubscription":
      "Чтобы оплатить подписку картой, привяжите аккаунт Metabox.",
    "linkMetabox.titleWithdrawal": "Заявка на вывод",
    "linkMetabox.subtitleWithdrawal":
      "Чтобы оформить заявку на вывод реферальных средств, привяжите аккаунт Metabox.",
    "linkMetabox.newAccount": "Создать аккаунт",
    "linkMetabox.existingAccount": "Уже есть аккаунт",
    "linkMetabox.registerHint": "Введите email и пароль для создания аккаунта Metabox.",
    "linkMetabox.loginHint": "Введите email и пароль от существующего аккаунта Metabox.",
    "linkMetabox.password": "Пароль",
    "linkMetabox.confirmPassword": "Подтвердите пароль",
    "linkMetabox.confirmPasswordPlaceholder": "Повторите пароль",
    "linkMetabox.passwordMismatch": "Пароли не совпадают",
    "linkMetabox.submit": "Продолжить",
    "linkMetabox.error": "Ошибка. Проверьте данные и попробуйте снова.",
    "linkMetabox.error.emailExists": "Этот email уже зарегистрирован. Попробуйте войти.",
    "linkMetabox.error.emailExists.switchToLogin": "Войти с этой почтой",
    "linkMetabox.error.telegramLinked": "Этот аккаунт Telegram уже привязан к Metabox.",
    "linkMetabox.error.userNotFound": "Аккаунт с таким email не найден.",
    "linkMetabox.error.invalidPassword": "Неверный пароль.",
    "linkMetabox.error.emailNotVerified": "Email не подтверждён. Подтвердите его на сайте Metabox.",
    "linkMetabox.error.passwordTooShort": "Пароль должен быть не менее 6 символов.",

    // Link Metabox — verify-email flow
    "linkMetabox.verify.title": "Подтвердите email",
    "linkMetabox.verify.subtitle": "Мы отправили письмо со ссылкой для подтверждения на адрес:",
    "linkMetabox.verify.followLink":
      "Перейдите по ссылке в письме, затем войдите на сайте по email и паролю.",
    "linkMetabox.verify.checkSpam":
      "Не получили письмо? Проверьте папку «Спам» или запросите повторную отправку ниже.",
    "linkMetabox.verify.resend": "Отправить повторно",
    "linkMetabox.verify.resendAgain": "Отправить ещё раз",
    "linkMetabox.verify.resendCooldown": "Повторно через {n} с",
    "linkMetabox.verify.changeEmail": "Изменить почту",
    "linkMetabox.verify.sentSuccess":
      "Письмо отправлено. Проверьте почту и убедитесь, что email выше указан верно.",
    "linkMetabox.verify.sent": "Письмо с подтверждением отправлено.",
    "linkMetabox.verify.alreadyVerified": "Email уже подтверждён. Можно входить на сайте.",
    "linkMetabox.verify.sendError": "Не удалось отправить письмо. Проверьте введенную почту.",
    "linkMetabox.verify.limitExhausted":
      "Превышен лимит повторных отправок. Подождите немного или измените email ниже.",

    // Link Metabox — change-email flow
    "linkMetabox.changeEmail.title": "Изменить email",
    "linkMetabox.changeEmail.subtitle":
      "Введите новый адрес — мы заменим его в системе и отправим письмо с подтверждением.",
    "linkMetabox.changeEmail.label": "Новый email",
    "linkMetabox.changeEmail.save": "Сохранить и отправить письмо",
    "linkMetabox.changeEmail.error.exists": "Этот email уже занят другим аккаунтом.",
    "linkMetabox.changeEmail.error.same": "Это тот же email, что был указан.",
    "linkMetabox.changeEmail.error.invalid": "Некорректный формат email.",
    "linkMetabox.changeEmail.error.alreadyVerified":
      "Email уже подтверждён — изменение через этот flow недоступно.",
    "linkMetabox.changeEmail.error.generic": "Не удалось сменить email.",

    // Image settings
    "imageSettings.title": "Настройки изображений",
    "imageSettings.subtitle": "Выбор и настройка модели и ее версий",
    "imageSettings.model": "Модель",
    "imageSettings.noSupport": "Эта модель не поддерживает настройки",
    "imageSettings.saved": "✓ Сохранено",
    "imageSettings.active": "Активна",
    "imageSettings.activate": "Активировать",
    "imageSettings.activating": "Активирую…",
    "imageSettings.activated": "Активирована",
    "imageSettings.startWork": "Начать работу",
    "imageSettings.version": "Версия",
    "modelModes.label": "Режим",
    "imageSettings.variant": "Вариант",
    "imageSettings.aspectRatio": "Соотношение сторон",
    "imageSettings.svgNoRatio": "Вектор (SVG) — соотношение задаётся в промпте",
    "imageSettings.otherModels": "Другие модели",
    "imageSettings.reset": "Сбросить",
    "imageSettings.resetTitle": "Сбрасывает настройки до значений по умолчанию.",
    "imageSettings.selectModel": "Выберите модель",
    "imageSettings.activatedPopup": "Модель активирована. Вернитесь в бот для работы с ней.",
    "manage.dialogActivatedPopup": "Диалог активирован. Вернитесь в чат для работы с ним.",
    "manage.startChat": "Начать общение",
    "manage.settings": "Настройки",
    "manage.delete": "Удалить",
    "manage.confirmDelete": "Удалить этот диалог?",
    "manage.advancedSettings": "Расширенные настройки",
    "manage.onboardingBanner":
      "\u26a0\ufe0f Это приложение только для настройки. Выберите нейросеть и параметры, а затем вернитесь в чат Telegram \u2014 промпты и результаты работают только там.",

    // Video settings
    "videoSettings.title": "Настройки видео",
    "videoSettings.subtitle": "Выбор и настройка модели и ее версий",
    "videoSettings.model": "Модель",
    "videoSettings.aspectRatio": "Соотношение сторон",
    "videoSettings.duration": "Длительность",
    "videoSettings.seconds": "с",
    "videoSettings.noAspectSupport": "Фиксированное соотношение",
    "videoSettings.noDurationSupport": "Фиксированная длительность",
    "videoSettings.saved": "✓ Сохранено",

    // Uploads
    "uploads.title": "Мои голоса",
    "uploads.subtitle": 'Сгенерированные голоса в разделе бота "Клонирование голоса"',
    "uploads.empty": "Голосов пока нет.",
    "uploads.emptyVoices":
      "Голосов пока нет. Клонируйте голос в разделе «Клонирование голоса» аудио-бота.",
    "uploads.emptyPhotos": "Фото пока нет. Отправьте фото боту в режиме HeyGen.",
    "uploads.photosTitle": "Фотографии",
    "uploads.voicesTitle": "Голосовые записи",
    "uploads.clonedVoicesTitle": "Клонированные голоса",
    "uploads.cloneVoiceBtn": "🎙 Клонировать голос",
    "uploads.confirmDeleteVoice": "Удалить этот клонированный голос?",
    "uploads.play": "Воспроизвести",
    "uploads.delete": "Удалить",
    "uploads.confirmDelete": "Удалить эту запись?",
    "uploads.rename": "Переименовать",
    "uploads.officialVoices": "Официальные",
    "uploads.myVoices": "Мои голоса",
    "uploads.elevenlabsLangHint":
      "Модель автоматически синтезирует речь на том языке, на котором написан текст для озвучки.",
    "uploads.useVoice": "Использовать",
    "uploads.voiceActive": "Активен",
    "uploads.officialAvatars": "Официальные",
    "uploads.myPhotos": "Мои фото",
    "uploads.myAvatars": "Мои аватары",
    "uploads.createAvatar": "➕ Создать аватар",
    "uploads.createHeyGen": "➕ Создать HeyGen",
    "uploads.createSoulProvider": "➕ Создать Soul",
    "uploads.createAvatarHint":
      "Вернитесь в чат и отправьте фото с лицом — бот создаст персональный аватар на его основе.",
    "uploads.createVoice": "➕ Создать голос",
    "uploads.createVoiceHint":
      "Вернитесь в чат и отправьте голосовое или аудиофайл — бот клонирует ваш голос и снова включит HeyGen.",
    "uploads.avatarCreating": "Создаётся...",
    "uploads.avatarOrphaned": "Недоступен",
    "uploads.avatarOrphanedHint": "Этот аватар больше недоступен. Создайте новый.",
    "uploads.emptyAvatars": "Аватаров пока нет. Нажмите «Создать аватар».",
    "uploads.mySouls": "Мои персонажи",
    "uploads.createSoul": "➕ Создать персонажа",
    "uploads.createSoulHint":
      "Вернитесь в чат и отправьте 20+ фото — бот создаст персонажа на их основе.",
    "uploads.noSouls": "Персонажей пока нет.",
    "uploads.soulCreating": "Создаётся...",

    // Auth errors
    "auth.tokenExpired":
      "Ссылка устарела. Заново откройте главное меню и нажмите кнопку «Профиль».",
    "auth.openFromTelegram": "Пожалуйста, откройте приложение через Telegram",
    "auth.notRegisteredTitle": "Сначала откройте бота",
    "auth.notRegisteredText":
      "Чтобы пользоваться мини-приложением, отправьте боту команду /start или перейдите по реферальной ссылке от друга.",
    "auth.openBot": "Открыть бота",

    // Picker shared UI
    "picker.search": "Поиск…",
    "picker.loading": "Загрузка…",
    "picker.loadingVoices": "Загрузка голосов…",
    "picker.loadingAvatars": "Загрузка аватаров…",
    "picker.loadMore": "Загрузить ещё",
    "picker.noVoices": "Голоса не найдены",
    "picker.noAvatars": "Аватары не найдены",
    "picker.genderAll": "Все",
    "picker.genderM": "М",
    "picker.genderF": "Ж",
    "picker.langAll": "Все языки",
    "picker.providerAll": "Все провайдеры",
    "picker.play": "Прослушать",
    "picker.stop": "Стоп",
    "picker.loadingPresets": "Загрузка пресетов…",
    "picker.noPresets": "Пресеты не найдены",
    "picker.categoryAll": "Все категории",
    "picker.maxMotions":
      "Можно выбрать не более {max} пресетов. При выборе нового лишний будет заменён автоматически.",
    "picker.strength": "Сила: {n}",
    "picker.selectedPresets": "Выбрано: {n} пресет(ов)",

    // OpenAI voice meta
    "voice.meta.neutral": "Нейтральный",
    "voice.meta.male": "Мужской",
    "voice.meta.female": "Женский",
    "voice.meta.british": "Британский",
    "voice.meta.deepMale": "Глубокий мужской",
    "voice.meta.calm": "Спокойный",

    // Link Metabox — merge blocked modal & dynamic errors
    "linkMetabox.merge.blocked": "⛔ Невозможно объединить аккаунты",
    "linkMetabox.merge.blockedText": "У вас разные наставники и на обоих аккаунтах есть покупки.",
    "linkMetabox.merge.mentorSite": "Наставник на сайте:",
    "linkMetabox.merge.mentorBot": "Наставник в боте:",
    "linkMetabox.merge.support": "Если у вас есть вопросы — обратитесь в поддержку:",
    "linkMetabox.merge.ok": "Понятно",
    "linkMetabox.merge.unknown": "Неизвестен",
    "linkMetabox.error.mentorConflict":
      "Конфликт наставников. На сайте: {site}, в боте: {bot}. Для объединения перейдите по кнопке AI Box на сайте Metabox.",
    "linkMetabox.error.telegramMismatch":
      "Этот аккаунт уже привязан к другому Telegram{info}. Войдите с того Telegram или обратитесь в поддержку @{support}",
    "linkMetabox.error.telegramLinkedOther":
      "На аккаунте {name}{info} уже привязан другой Telegram. Обратитесь в поддержку @{support}",
  },
} as const;

export type TranslationKey = keyof (typeof translations)["en"];

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: TranslationKey) => string;
}

const I18nContext = createContext<I18nContextValue>({
  locale: "en",
  setLocale: () => {},
  t: (key) => key,
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    const saved = localStorage.getItem("metabox_lang");
    if (saved === "ru" || saved === "en") return saved;
    const nav = navigator.language.slice(0, 2);
    return nav === "ru" ? "ru" : "en";
  });

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    localStorage.setItem("metabox_lang", l);
  }, []);

  const t = useCallback(
    (key: TranslationKey): string => {
      return translations[locale]?.[key] ?? translations.en[key] ?? key;
    },
    [locale],
  );

  return <I18nContext.Provider value={{ locale, setLocale, t }}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}
