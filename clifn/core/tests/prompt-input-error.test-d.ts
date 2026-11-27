/**
 * Type-level contract of PromptInputError (D2): the no-argument form keeps the reference literal code, a
 * non-default code must be passed so the type matches the runtime value, and instanceof narrowing of an unknown
 * caught value gives the code union rather than any.
 */
import { describe, expectTypeOf, it } from "vitest";

import { createPrompt, PromptInputError, type PromptErrorCode } from "../src/prompt.js";

describe("PromptInputError types", () => {
  it("keeps the literal code of the reference form", () => {
    expectTypeOf(new PromptInputError("bad input").code).toEqualTypeOf<"CLIFN_PROMPT_INPUT_ERROR">();
    expectTypeOf(new PromptInputError("bad input", "CLIFN_PROMPT_INPUT_ERROR").code).toEqualTypeOf<"CLIFN_PROMPT_INPUT_ERROR">();
  });

  it("infers a passed non-default code", () => {
    const error = new PromptInputError("no tty", "CLIFN_PROMPT_NON_INTERACTIVE");
    expectTypeOf(error.code).toEqualTypeOf<"CLIFN_PROMPT_NON_INTERACTIVE">();
  });

  it("rejects a non-default code type without its runtime code, and unknown codes", () => {
    // Type-only probes: the functions are never called, so no error object is built.
    const missingRuntimeCode = () =>
      // @ts-expect-error the instance would carry CLIFN_PROMPT_INPUT_ERROR at runtime
      new PromptInputError<"CLIFN_PROMPT_NON_INTERACTIVE">("no tty");
    const unknownCode = () =>
      // @ts-expect-error not a prompt error code
      new PromptInputError("bad input", "SOMETHING_ELSE");
    expectTypeOf(missingRuntimeCode).toBeFunction();
    expectTypeOf(unknownCode).toBeFunction();
  });

  it("narrows an unknown caught value to the code union, not any", async () => {
    try {
      await createPrompt({ nonInteractive: true }).confirm("Continue?");
    } catch (error: unknown) {
      if (error instanceof PromptInputError) {
        expectTypeOf(error.code).not.toBeAny();
        expectTypeOf(error.code).toEqualTypeOf<PromptErrorCode>();
      }
    }
  });

  it("narrows a subclass of the reference form to the subclass", () => {
    class LabelledError extends PromptInputError {
      readonly label = "answer";
    }
    const caught: unknown = new LabelledError("bad input");
    if (caught instanceof LabelledError) {
      expectTypeOf(caught.label).toEqualTypeOf<string>();
      expectTypeOf(caught.code).toEqualTypeOf<"CLIFN_PROMPT_INPUT_ERROR">();
    }
  });
});
