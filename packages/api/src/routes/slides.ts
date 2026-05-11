import type { FastifyInstance } from "fastify";
import "@fastify/multipart";
import { db } from "../db.js";
import { config } from "@metabox/shared";
import { telegramAuthHook } from "../middlewares/telegram-auth.js";
import { randomUUID } from "node:crypto";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

type AuthRequest = { userId: bigint };

const __dirname = dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = join(__dirname, "..", "..", "uploads", "banners");

async function ensureUploadsDir() {
  await mkdir(UPLOADS_DIR, { recursive: true });
}

function serialize(slide: {
  id: string;
  imageUrl: string;
  linkUrl: string | null;
  displaySeconds: number;
  sortOrder: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: slide.id,
    imageUrl: slide.imageUrl,
    linkUrl: slide.linkUrl,
    displaySeconds: slide.displaySeconds,
    sortOrder: slide.sortOrder,
    active: slide.active,
    createdAt: slide.createdAt.toISOString(),
    updatedAt: slide.updatedAt.toISOString(),
  };
}

export async function slidesRoutes(fastify: FastifyInstance): Promise<void> {
  /** GET /slides — public, returns active slides */
  fastify.get("/slides", async () => {
    const slides = await db.bannerSlide.findMany({
      where: { active: true },
      orderBy: { sortOrder: "asc" },
    });
    return { slides: slides.map(serialize) };
  });

  /** Admin slides management */
  await fastify.register(async (admin) => {
    admin.addHook("preHandler", async (request, reply) => {
      const secret = config.api.adminSecret;
      const provided = request.headers["x-admin-secret"];
      if (secret && provided === secret) return;

      try {
        await telegramAuthHook(request, reply);
      } catch {
        await reply.status(403).send({ error: "Forbidden" });
        return;
      }

      const { userId } = request as unknown as AuthRequest;
      const user = await db.user.findUnique({
        where: { id: userId },
        select: { role: true },
      });

      if (!user || (user.role !== "ADMIN" && user.role !== "MODERATOR")) {
        await reply.status(403).send({ error: "Forbidden" });
      }
    });

    /** GET /admin/slides — all slides including inactive */
    admin.get("/admin/slides", async () => {
      const slides = await db.bannerSlide.findMany({
        orderBy: { sortOrder: "asc" },
      });
      return { slides: slides.map(serialize) };
    });

    /** POST /admin/slides — create slide with image upload */
    admin.post("/admin/slides", async (request, reply) => {
      await ensureUploadsDir();

      const data = await request.file();
      if (!data) {
        await reply.status(400).send({ error: "Image file required" });
        return;
      }

      const buffer = await data.toBuffer();
      const ext = extname(data.filename || ".png") || ".png";
      const filename = `${Date.now()}-${randomUUID().slice(0, 8)}${ext}`;
      const filepath = join(UPLOADS_DIR, filename);
      await writeFile(filepath, buffer);

      const fields = data.fields as Record<string, { value?: string } | undefined>;
      const linkUrl = (fields.linkUrl as { value?: string } | undefined)?.value || null;
      const displaySeconds = parseInt(
        (fields.displaySeconds as { value?: string } | undefined)?.value || "4",
        10,
      );
      const active = (fields.active as { value?: string } | undefined)?.value !== "false";

      const count = await db.bannerSlide.count();
      const slide = await db.bannerSlide.create({
        data: {
          imageUrl: `/uploads/banners/${filename}`,
          linkUrl: linkUrl || null,
          displaySeconds: isNaN(displaySeconds) ? 4 : displaySeconds,
          sortOrder: count,
          active,
        },
      });

      return serialize(slide);
    });

    /** PATCH /admin/slides/:id — update slide */
    admin.patch<{ Params: { id: string } }>("/admin/slides/:id", async (request, reply) => {
      const { id } = request.params;
      const existing = await db.bannerSlide.findUnique({ where: { id } });
      if (!existing) {
        await reply.status(404).send({ error: "Slide not found" });
        return;
      }

      const contentType = request.headers["content-type"] || "";
      const updateData: Record<string, unknown> = {};

      if (contentType.includes("multipart")) {
        await ensureUploadsDir();
        const data = await request.file();

        if (data) {
          // New image uploaded — save and delete old
          const buffer = await data.toBuffer();
          const ext = extname(data.filename || ".png") || ".png";
          const filename = `${Date.now()}-${randomUUID().slice(0, 8)}${ext}`;
          const filepath = join(UPLOADS_DIR, filename);
          await writeFile(filepath, buffer);
          updateData.imageUrl = `/uploads/banners/${filename}`;

          // Delete old file
          try {
            const oldPath = join(__dirname, "..", "..", existing.imageUrl.replace(/^\//, ""));
            await unlink(oldPath);
          } catch {
            // Old file may not exist
          }

          const fields = data.fields as Record<string, { value?: string } | undefined>;
          if (fields.linkUrl)
            updateData.linkUrl = (fields.linkUrl as { value?: string }).value || null;
          if (fields.displaySeconds) {
            const ds = parseInt((fields.displaySeconds as { value?: string }).value || "4", 10);
            if (!isNaN(ds)) updateData.displaySeconds = ds;
          }
          if (fields.active)
            updateData.active = (fields.active as { value?: string }).value !== "false";
        }
      } else {
        // JSON body update
        const body = request.body as Record<string, unknown>;
        if ("linkUrl" in body) updateData.linkUrl = body.linkUrl;
        if ("displaySeconds" in body) updateData.displaySeconds = body.displaySeconds;
        if ("active" in body) updateData.active = body.active;
      }

      const slide = await db.bannerSlide.update({
        where: { id },
        data: updateData,
      });
      return serialize(slide);
    });

    /** DELETE /admin/slides/:id */
    admin.delete<{ Params: { id: string } }>("/admin/slides/:id", async (request, reply) => {
      const { id } = request.params;
      const existing = await db.bannerSlide.findUnique({ where: { id } });
      if (!existing) {
        await reply.status(404).send({ error: "Slide not found" });
        return;
      }

      // Delete file
      try {
        const filePath = join(__dirname, "..", "..", existing.imageUrl.replace(/^\//, ""));
        await unlink(filePath);
      } catch {
        // File may not exist
      }

      await db.bannerSlide.delete({ where: { id } });
      return { success: true };
    });

    /** POST /admin/slides/reorder */
    admin.post("/admin/slides/reorder", async (request, reply) => {
      const { slideIds } = request.body as { slideIds: string[] };
      if (!Array.isArray(slideIds) || slideIds.length === 0) {
        await reply.status(400).send({ error: "slideIds array required" });
        return;
      }

      await db.$transaction(
        slideIds.map((id, index) =>
          db.bannerSlide.update({
            where: { id },
            data: { sortOrder: index },
          }),
        ),
      );

      return { success: true };
    });
  });
}
