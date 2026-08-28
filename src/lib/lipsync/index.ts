/**
 * The lip-sync engine's public surface.
 *
 * `types.ts` is the contract the renderer and the signal already speak; this
 * module adds the engine, the compiler and the internal shapes a dev harness
 * needs to inspect a plan.
 */

export * from "./types";
export { LipSync, type Phase } from "./engine";
export { textToScore, buildScore, type BuildOpts } from "./score";
export { normalize, stripTashkeel, type Norm } from "./normalize";
export { arRegister } from "./g2p-ar";
export { getPrior, learn, type Prior } from "./priors";
export type { Chan, Cls, Phone, Phrase, Place, Score, Seg, Syl, Word, WordPlan } from "./model";
