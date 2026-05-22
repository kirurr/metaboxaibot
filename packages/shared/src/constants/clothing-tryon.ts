/**
 * Pseudo-model id under which the clothing try-on flow stores the two
 * collected photos (`person` and `clothing` slots) in `UserState.mediaInputs`.
 *
 * Lives in shared/constants so both `packages/bot/src/scenes/clothing-tryon.ts`
 * (writes the buffer) and `packages/bot/src/commands/menu.ts` (clears it on
 * main-menu navigation) can reference the same key without creating a
 * circular import between the two bot modules.
 */
export const CLOTHING_TRYON_BUFFER_MODEL_ID = "clothing_tryon";
