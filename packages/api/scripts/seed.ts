/**
 * Dev seed script — creates mock data for local development and testing.
 *
 * Run:  pnpm -F @metabox/api seed
 *   or: pnpm -F @metabox/api exec tsx scripts/seed.ts
 *
 * Requires: DATABASE_URL in .env (or env)
 * KEY_VAULT_MASTER is optional — falls back to "dev-seed-master-key" so the
 * script works without full prod config. Fake provider keys won't decrypt with
 * the prod vault master anyway.
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";

// ── Minimal crypto (mirrors @metabox/shared, no heavy config dep) ─────────────
const VAULT_MASTER = process.env.KEY_VAULT_MASTER ?? "dev-seed-master-key";
const VAULT_KEY = scryptSync(VAULT_MASTER, "metabox-vault", 32);

function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", VAULT_KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

function maskKey(plain: string): string {
  if (plain.length <= 8) return "…" + plain.slice(-2);
  return "…" + plain.slice(-4);
}

// ── DB ────────────────────────────────────────────────────────────────────────
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// ── Telegram IDs ─────────────────────────────────────────────────────────────
const ADMIN_ID = 100000001n;
const MODERATOR_ID = 100000002n;
const USER_ID = 100000003n;

// ── Cleanup (leaf → root) ────────────────────────────────────────────────────
// Wraps deleteMany so missing tables (P2021) are silently skipped — useful
// when running against a DB that hasn't had all migrations applied yet.
async function del(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e: unknown) {
    if ((e as { code?: string })?.code === "P2021") return;
    throw e;
  }
}

async function cleanup(): Promise<void> {
  await del(() => prisma.galleryFolderItem.deleteMany());
  await del(() => prisma.generationJobOutput.deleteMany());
  await del(() => prisma.generationJob.deleteMany());
  await del(() => prisma.galleryFolder.deleteMany());
  await del(() => prisma.message.deleteMany());
  await del(() => prisma.dialog.deleteMany());
  await del(() => prisma.tokenTransaction.deleteMany());
  await del(() => prisma.pendingGeneration.deleteMany());
  await del(() => prisma.localSubscription.deleteMany());
  await del(() => prisma.userState.deleteMany());
  await del(() => prisma.userUpload.deleteMany());
  await del(() => prisma.userAvatar.deleteMany());
  await del(() => prisma.userVoice.deleteMany());
  await del(() => prisma.user.deleteMany());
  await del(() => prisma.deletedUser.deleteMany());
  await del(() => prisma.grantedMetaboxOrder.deleteMany());
  await del(() => prisma.welcomeBonusReceipt.deleteMany());
  await del(() => prisma.pricingOverride.deleteMany());
  await del(() => prisma.providerKey.deleteMany());
  await del(() => prisma.proxy.deleteMany());
  await del(() => prisma.bannerSlide.deleteMany());
  await del(() => prisma.exchangeRate.deleteMany());
}

// ── Seed ──────────────────────────────────────────────────────────────────────
async function seed(): Promise<void> {
  console.log("🗑  Cleaning up existing seed data…");
  await cleanup();
  console.log("✓  Clean.\n");

  // 1. ExchangeRate ─────────────────────────────────────────────────────────
  await prisma.exchangeRate.create({
    data: { pair: "USDT_RUB", rate: 92.5 },
  });

  // 2. BannerSlide ──────────────────────────────────────────────────────────
  await prisma.bannerSlide.createMany({
    data: [
      {
        imageUrl: "https://cdn.example.com/banners/summer-promo.jpg",
        linkUrl: "https://meta-box.ru/promo/summer",
        displaySeconds: 5,
        sortOrder: 0,
        active: true,
      },
      {
        imageUrl: "https://cdn.example.com/banners/new-models.jpg",
        linkUrl: null,
        displaySeconds: 4,
        sortOrder: 1,
        active: true,
      },
      {
        imageUrl: "https://cdn.example.com/banners/plans.jpg",
        linkUrl: "https://meta-box.ru/plans",
        displaySeconds: 6,
        sortOrder: 2,
        active: false,
      },
    ],
  });

  // 3. Proxies ──────────────────────────────────────────────────────────────
  const proxyDe = await prisma.proxy.create({
    data: {
      label: "DE-1",
      protocol: "http",
      host: "proxy-de-1.example.com",
      port: 8080,
      isActive: true,
      notes: "Seed proxy — HTTP Germany",
    },
  });
  const proxyUs = await prisma.proxy.create({
    data: {
      label: "US-East",
      protocol: "socks5",
      host: "proxy-us-1.example.com",
      port: 1080,
      isActive: true,
      notes: "Seed proxy — SOCKS5 US East",
    },
  });

  // 4. ProviderKeys ─────────────────────────────────────────────────────────
  // Fake keys — won't work for real AI calls, only for DB / UI testing
  const FAKE: Record<string, string> = {
    openai: "sk-seed-openai-0000000000000000000000000000000000000000000000000",
    anthropic: "sk-ant-seed-anthropic-000000000000000000000000000000000000000",
    fal: "fal-seed-00000000000000000000000000000000000000000000000000000000",
    heygen: "heygen-seed-000000000000000000000000000000000000000000000000000",
    elevenlabs: "el-seed-00000000000000000000000000000000000000000000000000",
  };

  const keyOpenai = await prisma.providerKey.create({
    data: {
      provider: "openai",
      label: "OpenAI Main (seed)",
      keyCipher: encryptSecret(FAKE.openai),
      keyMask: maskKey(FAKE.openai),
      proxyId: proxyDe.id,
      priority: 10,
      isActive: true,
      notes: "Seed key — not valid for real requests",
    },
  });

  await prisma.providerKey.create({
    data: {
      provider: "anthropic",
      label: "Anthropic Main (seed)",
      keyCipher: encryptSecret(FAKE.anthropic),
      keyMask: maskKey(FAKE.anthropic),
      proxyId: proxyDe.id,
      priority: 5,
      isActive: true,
    },
  });

  const keyFal = await prisma.providerKey.create({
    data: {
      provider: "fal",
      label: "Fal.ai Main (seed)",
      keyCipher: encryptSecret(FAKE.fal),
      keyMask: maskKey(FAKE.fal),
      proxyId: proxyUs.id,
      priority: 3,
      isActive: true,
    },
  });

  const keyHeygen = await prisma.providerKey.create({
    data: {
      provider: "heygen",
      label: "HeyGen Main (seed)",
      keyCipher: encryptSecret(FAKE.heygen),
      keyMask: maskKey(FAKE.heygen),
      proxyId: null,
      priority: 3,
      isActive: true,
    },
  });

  const keyElevenlabs = await prisma.providerKey.create({
    data: {
      provider: "elevenlabs",
      label: "ElevenLabs Main (seed)",
      keyCipher: encryptSecret(FAKE.elevenlabs),
      keyMask: maskKey(FAKE.elevenlabs),
      proxyId: null,
      priority: 3,
      isActive: true,
    },
  });

  // 5. PricingOverride ───────────────────────────────────────────────────────
  await prisma.pricingOverride.createMany({
    data: [
      {
        scope: "global",
        key: "targetMargin",
        multiplier: 1.5,
        note: "Seed: global margin override",
        updatedBy: "seed",
      },
      {
        scope: "model",
        key: "flux-pro",
        multiplier: 1.2,
        note: "Seed: flux-pro price bump",
        updatedBy: "seed",
      },
      {
        scope: "model",
        key: "gpt-4o",
        multiplier: 0.8,
        note: "Seed: gpt-4o discount",
        updatedBy: "seed",
      },
    ],
  });

  // 6. Users (referral chain: admin ← moderator ← user) ────────────────────
  const admin = await prisma.user.create({
    data: {
      id: ADMIN_ID,
      username: "admin_bot",
      firstName: "Admin",
      lastName: "User",
      language: "en",
      role: "ADMIN",
      tokenBalance: 9999,
      subscriptionTokenBalance: 0,
      isNew: false,
      referredById: null,
      metaboxUserId: "mbx-admin-uuid-001",
      metaboxReferralCode: "ADMIN001",
      finishedOnboarding: true,
      generationCount: 42,
      confirmBeforeGenerate: false,
    },
  });

  const moderator = await prisma.user.create({
    data: {
      id: MODERATOR_ID,
      username: "mod_user",
      firstName: "Moderator",
      lastName: null,
      language: "ru",
      role: "MODERATOR",
      tokenBalance: 500,
      subscriptionTokenBalance: 1200,
      isNew: false,
      referredById: admin.id,
      finishedOnboarding: true,
      generationCount: 10,
    },
  });

  const regularUser = await prisma.user.create({
    data: {
      id: USER_ID,
      username: "regular_user",
      firstName: "Иван",
      lastName: "Иванов",
      language: "ru",
      role: "USER",
      tokenBalance: 150.25,
      subscriptionTokenBalance: 0,
      isNew: false,
      referredById: moderator.id,
      finishedOnboarding: false,
      generationCount: 3,
    },
  });

  // 7. WelcomeBonusReceipt ───────────────────────────────────────────────────
  await prisma.welcomeBonusReceipt.createMany({
    data: [
      { telegramId: ADMIN_ID, amount: 100 },
      { telegramId: USER_ID, amount: 50 },
    ],
  });

  // 8. GrantedMetaboxOrder ───────────────────────────────────────────────────
  await prisma.grantedMetaboxOrder.create({
    data: {
      orderId: "mbx-order-seed-001",
      telegramId: ADMIN_ID,
      tokens: 500,
      description: "Seed: initial token pack",
    },
  });

  // 9. DeletedUser (archive snapshot) ───────────────────────────────────────
  await prisma.deletedUser.create({
    data: {
      telegramId: 100000000n,
      username: "deleted_user_seed",
      firstName: "Deleted",
      lastName: "Account",
      language: "en",
      tokenBalance: 23.5,
      subscriptionTokenBalance: 0,
      hadLocalSubscription: false,
      pendingMetaboxTransfer: false,
      originalCreatedAt: new Date("2026-01-01T00:00:00Z"),
    },
  });

  // 10. Dialogs ─────────────────────────────────────────────────────────────
  const adminGptDialog = await prisma.dialog.create({
    data: {
      userId: admin.id,
      section: "gpt",
      modelId: "gpt-4o",
      title: "General chat",
      contextStrategy: "provider_chain",
      providerLastResponseId: "resp_seed_abc123",
      providerLastResponseKeyId: keyOpenai.id,
    },
  });

  const modGptDialog = await prisma.dialog.create({
    data: {
      userId: moderator.id,
      section: "gpt",
      modelId: "claude-sonnet",
      title: "Рабочие задачи",
      contextStrategy: "db_history",
    },
  });

  const userGptDialog = await prisma.dialog.create({
    data: {
      userId: regularUser.id,
      section: "gpt",
      modelId: "gpt-4o",
      title: "Мой первый диалог",
      contextStrategy: "db_history",
    },
  });

  const userImageDialog = await prisma.dialog.create({
    data: {
      userId: regularUser.id,
      section: "image",
      modelId: "flux-pro",
      title: null,
      contextStrategy: "db_history",
    },
  });

  // 11. Messages ─────────────────────────────────────────────────────────────
  await prisma.message.createMany({
    data: [
      // admin — gpt
      {
        dialogId: adminGptDialog.id,
        role: "user",
        content: "Hello! What can you do?",
        tokensUsed: 0,
      },
      {
        dialogId: adminGptDialog.id,
        role: "assistant",
        content:
          "I can help with text generation, image creation, video production, and audio synthesis. What would you like to explore?",
        tokensUsed: 32,
      },
      // regular user — gpt
      {
        dialogId: userGptDialog.id,
        role: "user",
        content: "Привет! Напиши стихотворение про осень.",
        tokensUsed: 0,
      },
      {
        dialogId: userGptDialog.id,
        role: "assistant",
        content:
          "Осень золотом оделась,\nЛистья кружатся в тиши,\nЛес задумчивый оделся\nВ платье алой багряши.\n\nКапли дождика стучат,\nВетер тихо шелестит,\nПтицы в южный край летят,\nА земля сырая спит.",
        tokensUsed: 87,
      },
      {
        dialogId: userGptDialog.id,
        role: "user",
        content: "Здорово! А теперь про зиму.",
        tokensUsed: 0,
      },
    ],
  });

  // 12. UserState ───────────────────────────────────────────────────────────
  await prisma.userState.createMany({
    data: [
      {
        userId: admin.id,
        state: "IDLE",
        section: null,
        gptModelId: "gpt-4o",
        gptDialogId: adminGptDialog.id,
      },
      {
        userId: moderator.id,
        state: "IDLE",
        section: "gpt",
        gptModelId: "claude-sonnet",
        gptDialogId: modGptDialog.id,
        designModelId: "flux-pro",
        imageSettings: { "flux-pro": { aspectRatio: "1:1" } },
      },
      {
        userId: regularUser.id,
        state: "IDLE",
        section: null,
        gptDialogId: userGptDialog.id,
        designDialogId: userImageDialog.id,
        designModelId: "flux-pro",
        audioModelId: "elevenlabs-tts",
        videoModelId: "kling",
        imageSettings: { "flux-pro": { aspectRatio: "16:9" } },
        videoSettings: { kling: { aspectRatio: "16:9", duration: 5 } },
      },
    ],
  });

  // 13. LocalSubscription (moderator) ────────────────────────────────────────
  const now = new Date();
  const subEndDate = new Date(now);
  subEndDate.setFullYear(subEndDate.getFullYear() + 1);

  await prisma.localSubscription.create({
    data: {
      userId: moderator.id,
      planName: "PRO",
      period: "M3",
      tokensGranted: 5000,
      startDate: now,
      endDate: subEndDate,
      isActive: true,
      metaboxSubscriptionId: "mbx-sub-seed-001",
    },
  });

  // 14. PendingGeneration (regular user) ─────────────────────────────────────
  const pendingExpiry = new Date(now.getTime() + 10 * 60 * 1000);

  await prisma.pendingGeneration.create({
    data: {
      userId: regularUser.id,
      section: "image",
      modelId: "flux-pro",
      prompt: "A futuristic city at sunset, cyberpunk style",
      payload: {
        section: "image",
        modelId: "flux-pro",
        prompt: "A futuristic city at sunset, cyberpunk style",
        aspectRatio: "16:9",
      },
      estimatedCost: 12.5,
      chatId: USER_ID,
      messageId: 1001n,
      expiresAt: pendingExpiry,
    },
  });

  // 15. UserUpload (regular user) ────────────────────────────────────────────
  await prisma.userUpload.createMany({
    data: [
      {
        userId: regularUser.id,
        type: "voice",
        name: "My Voice Sample",
        url: "https://cdn.example.com/uploads/voice-sample-001.ogg",
        s3Key: "uploads/voices/user-3/voice-sample-001.ogg",
      },
      {
        userId: regularUser.id,
        type: "audio",
        name: "Background Music",
        url: "https://cdn.example.com/uploads/bg-music-001.mp3",
        s3Key: "uploads/audio/user-3/bg-music-001.mp3",
      },
    ],
  });

  // 16. UserAvatar (moderator — HeyGen) ──────────────────────────────────────
  await prisma.userAvatar.create({
    data: {
      userId: moderator.id,
      provider: "heygen",
      name: "Business Avatar",
      externalId: "heygen-talking-photo-seed-001",
      previewUrl: "https://cdn.example.com/avatars/mod-heygen-preview.jpg",
      status: "ready",
      providerKeyId: keyHeygen.id,
    },
  });

  // 17. UserVoice (moderator — ElevenLabs) ───────────────────────────────────
  await prisma.userVoice.create({
    data: {
      userId: moderator.id,
      provider: "elevenlabs",
      name: "My Cloned Voice",
      externalId: "el-voice-seed-001",
      previewUrl: "https://cdn.example.com/voices/mod-el-preview.mp3",
      audioS3Key: "uploads/voices/mod/source-audio.ogg",
      status: "ready",
      lastUsedAt: now,
      providerKeyId: keyElevenlabs.id,
    },
  });

  // 18. TokenTransaction ────────────────────────────────────────────────────
  await prisma.tokenTransaction.createMany({
    data: [
      // admin
      {
        userId: admin.id,
        amount: 100,
        type: "credit",
        reason: "welcome_bonus",
        description: "Welcome bonus",
      },
      {
        userId: admin.id,
        amount: -5.5,
        type: "debit",
        reason: "ai_usage",
        description: "GPT-4o: General chat",
        modelId: "gpt-4o",
        dialogId: adminGptDialog.id,
        actualProvider: "openai",
        actualCostUsd: 0.000275,
      },
      // moderator
      {
        userId: moderator.id,
        amount: 100,
        type: "credit",
        reason: "welcome_bonus",
        description: "Welcome bonus",
      },
      {
        userId: moderator.id,
        amount: 500,
        type: "credit",
        reason: "purchase",
        description: "Подписка PRO (M3)",
      },
      // regular user
      {
        userId: regularUser.id,
        amount: 50,
        type: "credit",
        reason: "welcome_bonus",
        description: "Welcome bonus",
      },
      {
        userId: regularUser.id,
        amount: 25,
        type: "credit",
        reason: "referral_bonus",
        description: "Referral bonus",
      },
      {
        userId: regularUser.id,
        amount: -12.5,
        type: "debit",
        reason: "ai_usage",
        description: "Flux Pro: image generation",
        modelId: "flux-pro",
        dialogId: userImageDialog.id,
        actualProvider: "fal",
        actualCostUsd: 0.0025,
      },
    ],
  });

  // 19. GalleryFolder ───────────────────────────────────────────────────────
  const favFolder = await prisma.galleryFolder.create({
    data: {
      userId: regularUser.id,
      name: "Избранное",
      isDefault: true,
      isPinned: true,
      pinnedAt: now,
    },
  });

  await prisma.galleryFolder.create({
    data: {
      userId: regularUser.id,
      name: "Мои изображения",
      isDefault: false,
    },
  });

  // 20. GenerationJob ───────────────────────────────────────────────────────
  const completedAt = new Date(now.getTime() - 30 * 1000); // 30s ago

  const doneJob = await prisma.generationJob.create({
    data: {
      userId: regularUser.id,
      dialogId: userImageDialog.id,
      section: "image",
      modelId: "flux-pro",
      status: "done",
      prompt: "A futuristic city at sunset, cyberpunk style, 4k ultra detail",
      inputData: { aspectRatio: "16:9", numImages: 1 },
      providerJobId: "fal-req-seed-001",
      providerKeyId: keyFal.id,
      sourceMessageId: `${ADMIN_ID}:1001`,
      pollStartedAt: new Date(now.getTime() - 60 * 1000),
      tokensSpent: 12.5,
      completedAt,
    },
  });

  await prisma.generationJob.create({
    data: {
      userId: regularUser.id,
      dialogId: userImageDialog.id,
      section: "video",
      modelId: "kling",
      status: "failed",
      prompt: "A cat walking on the moon",
      inputData: { aspectRatio: "16:9", duration: 5 },
      error: "Provider timeout: request exceeded 120s",
      tokensSpent: null,
      completedAt,
    },
  });

  // 21. GenerationJobOutput (done job only) ─────────────────────────────────
  await prisma.generationJobOutput.create({
    data: {
      jobId: doneJob.id,
      index: 0,
      outputUrl: "https://cdn.example.com/outputs/flux-pro-seed-001.jpg",
      s3Key: "outputs/image/user-3/flux-pro-seed-001.jpg",
      thumbnailS3Key: "outputs/image/user-3/flux-pro-seed-001-thumb.jpg",
    },
  });

  // 22. GalleryFolderItem (done job → Избранное) ────────────────────────────
  await prisma.galleryFolderItem.create({
    data: {
      folderId: favFolder.id,
      jobId: doneJob.id,
    },
  });

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("✅ Seed complete:\n");
  console.log("  Users             3   (admin, moderator, user)");
  console.log("  Proxies           2   (HTTP DE-1, SOCKS5 US-East)");
  console.log("  ProviderKeys      5   (openai, anthropic, fal, heygen, elevenlabs)");
  console.log("  PricingOverrides  3   (1 global, 2 model)");
  console.log("  BannerSlides      3   (2 active, 1 inactive)");
  console.log("  ExchangeRate      1   (USDT_RUB = 92.5)");
  console.log("  Dialogs           4   (admin:gpt, mod:gpt, user:gpt, user:image)");
  console.log("  Messages          5");
  console.log("  TokenTransaction  7");
  console.log("  GenerationJobs    2   (1 done, 1 failed)");
  console.log("  GalleryFolders    2   (Избранное + Мои изображения)");
  console.log("  GalleryFolderItem 1");
  console.log("  LocalSubscription 1   (moderator PRO M3)");
  console.log("  PendingGeneration 1   (user)");
  console.log("  UserAvatar        1   (moderator heygen)");
  console.log("  UserVoice         1   (moderator elevenlabs)");
  console.log("  UserUpload        2   (user voice + audio)");
  console.log("  WelcomeBonuses    2   (admin, user)");
  console.log("  GrantedOrders     1   (admin)");
  console.log("  DeletedUser       1   (archive snapshot)");
}

seed()
  .catch(async (err) => {
    console.error("\n❌ Seed failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
