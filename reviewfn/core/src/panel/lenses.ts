import { ReviewFnError } from "../errors.js";

/** A review lens: versioned instructions that focus one slot. Lens IDs are what panel slots name in `lens`. */
export interface Lens {
  id: string;
  version: string;
  instructions: string;
}

const LENS_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Lenses a panel run may use. Registration rejects malformed or duplicate lenses, so a slot's lens is unambiguous. */
export class LensRegistry {
  private readonly lenses = new Map<string, Lens>();

  public constructor(lenses: readonly Lens[] = []) {
    for (const lens of lenses) this.register(lens);
  }

  public register(lens: Lens): this {
    if (!lens || typeof lens.id !== "string" || !LENS_ID.test(lens.id)) throw new ReviewFnError("REVIEWFN_CONFIG_INVALID", `Lens ID ${String(lens?.id)} must match ${LENS_ID.source}.`);
    if (typeof lens.version !== "string" || !lens.version.trim()) throw new ReviewFnError("REVIEWFN_CONFIG_INVALID", `Lens ${lens.id} requires a nonblank version.`);
    if (typeof lens.instructions !== "string" || !lens.instructions.trim()) throw new ReviewFnError("REVIEWFN_CONFIG_INVALID", `Lens ${lens.id} requires nonblank instructions.`);
    if (this.lenses.has(lens.id)) throw new ReviewFnError("REVIEWFN_CONFIG_INVALID", `Lens ${lens.id} is already registered.`);
    this.lenses.set(lens.id, Object.freeze({ id: lens.id, version: lens.version, instructions: lens.instructions }));
    return this;
  }

  public get(id: string): Lens | undefined {
    return this.lenses.get(id);
  }

  public has(id: string): boolean {
    return this.lenses.has(id);
  }

  public list(): Lens[] {
    return [...this.lenses.values()];
  }
}

/** The only lens this release ships: a general correctness and regression review. */
export const GENERAL_LENS: Lens = Object.freeze({
  id: "general",
  version: "1",
  instructions: [
    "Review the change for defects a careful senior reviewer would block on: incorrect behavior, regressions in unchanged callers, broken contracts or compatibility, data loss, security and privacy problems, races, resource leaks and missing error handling.",
    "Report a finding only with code, diff or test evidence at the cited commit. Prefer one precise finding per root cause over several overlapping ones.",
    "Use severity critical (P0) for exploitable or data-destroying defects, high (P1) for defects that break required behavior, medium (P2) for likely defects with limited impact, and low (P3) for minor defects. Never report style preferences.",
  ].join("\n"),
});

/** A registry holding the lenses this release ships. */
export function defaultLensRegistry(): LensRegistry {
  return new LensRegistry([GENERAL_LENS]);
}
