/**
 * Lip sync — moved to `src/lib/lipsync/`.
 *
 * Kept as a re-export so existing imports (`isArabicText`, `LipSync`,
 * `restShape`, `MouthShape`) keep resolving to the same names.
 */

export * from "./lipsync";
