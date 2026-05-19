/**
 * Pseudo-model id under which the face-swap flow stores the two collected
 * photos (`reference` and `face` slots) in `UserState.mediaInputs`.
 *
 * Lives in shared/constants so both `packages/bot/src/scenes/face-swap.ts`
 * (writes the buffer) and `packages/bot/src/commands/menu.ts` (clears it on
 * main-menu navigation) can reference the same key without creating a
 * circular import between the two bot modules.
 */
export const FACE_SWAP_BUFFER_MODEL_ID = "face_swap";
