import z from "zod";

const settingConditionSchema = z.object({
  key: z.string(),
  eq: z.unknown().optional(),
  neq: z.unknown().optional(),
  present: z.literal(true).optional(),
  absent: z.literal(true).optional(),
});

type UnavailableRule =
  | z.infer<typeof settingConditionSchema>
  | { and: UnavailableRule[] }
  | { or: UnavailableRule[] };

const unavailableRuleSchema: z.ZodType<UnavailableRule> = z.lazy(() =>
  z.union([
    settingConditionSchema,
    z.object({ and: z.array(unavailableRuleSchema) }),
    z.object({ or: z.array(unavailableRuleSchema) }),
  ]),
);

export const modelSettingOptionSchema = z.object({
  value: z.union([z.string(), z.number(), z.boolean()]),
  label: z.string(),
  unavailableIf: unavailableRuleSchema.optional(),
});

export const modelSettingTypeSchema = z.enum([
  "select",
  "dropdown",
  "slider",
  "toggle",
  "text",
  "number",
  "voice-picker",
  "did-voice-picker",
  "elevenlabs-voice-picker",
  "openai-voice-picker",
  "cartesia-voice-picker",
  "color",
  "avatar-picker",
  "motion-picker",
  "soul-picker",
  "soul-style-picker",
]);

export const modelSettingDefSchema = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string().optional(),
  type: modelSettingTypeSchema,
  options: z.array(modelSettingOptionSchema).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).nullable(),
  unavailableIf: unavailableRuleSchema.optional(),
  advanced: z.boolean().optional(),
  dependsOn: z
    .object({ key: z.string(), value: z.union([z.string(), z.number(), z.boolean()]) })
    .optional(),
});

export type ModelSettingType = z.infer<typeof modelSettingTypeSchema>;
export type ModelSettingOption = z.infer<typeof modelSettingOptionSchema>;
export type ModelSettingDef = z.infer<typeof modelSettingDefSchema>;
