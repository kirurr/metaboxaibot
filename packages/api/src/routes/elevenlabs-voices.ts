import type { FastifyPluginAsync } from "fastify";
import { KIE_ELEVENLABS_VOICES, kieElevenLabsVoicePreviewUrl } from "@metabox/shared";
import { telegramAuthHook } from "../middlewares/telegram-auth.js";
import { constructOpenAPIonRouteHook } from "../utils/openapi.js";

/**
 * Static catalog of ElevenLabs voices for the `tts-el` voice picker.
 *
 * ElevenLabs audio runs through the kie.ai aggregator, which exposes no live
 * voices API — its TTS models accept only a fixed enum of voice IDs. We serve
 * that enum from `KIE_ELEVENLABS_VOICES` (@metabox/shared). kie gives no
 * gender/language metadata, so the response carries only id / name /
 * description / preview_url.
 */
export const elevenlabsVoicesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", telegramAuthHook);
  fastify.addHook("onRoute", (params) => constructOpenAPIonRouteHook(params, ["voices"]));

  /** GET /elevenlabs-voices — static list of ElevenLabs voices available via kie.ai */
  fastify.get(
    "/elevenlabs-voices",
    {
      schema: {
        description: "Get list of ElevenLabs voices available through kie.ai",
        response: {
          200: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: true,
              properties: {
                voice_id: { type: "string", description: "Voice ID" },
                name: { type: "string", description: "Voice name" },
                description: { type: "string", description: "Voice flavour (timbre/style)" },
                preview_url: { type: "string", nullable: true, description: "Preview audio URL" },
              },
            },
          },
        },
      },
    },
    async () =>
      KIE_ELEVENLABS_VOICES.map((v) => ({
        voice_id: v.voice_id,
        name: v.name,
        description: v.description,
        preview_url: kieElevenLabsVoicePreviewUrl(v.voice_id),
      })),
  );
};
