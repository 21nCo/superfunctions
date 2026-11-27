import readline from "node:readline";

export type PromptErrorCode = "CLIFN_PROMPT_INPUT_ERROR" | "CLIFN_PROMPT_NON_INTERACTIVE";

/** The code may be left out only for the default `CLIFN_PROMPT_INPUT_ERROR`; any other code must be passed. */
type PromptErrorCodeArgs<TCode extends PromptErrorCode> = TCode extends "CLIFN_PROMPT_INPUT_ERROR"
  ? [code?: TCode]
  : [code: TCode];

/**
 * `new PromptInputError(message)` keeps the literal type `code: "CLIFN_PROMPT_INPUT_ERROR"`; a non-default code must
 * be passed, so the type always matches the runtime code. `error instanceof PromptInputError` on an unknown value
 * narrows `code` to `PromptErrorCode` (TypeScript 5.3 and later), not `any`.
 */
export class PromptInputError<TCode extends PromptErrorCode = "CLIFN_PROMPT_INPUT_ERROR"> extends Error {
  readonly code: TCode;

  constructor(message: string, ...[code]: PromptErrorCodeArgs<TCode>) {
    super(message);
    this.name = "PromptInputError";
    this.code = (code ?? "CLIFN_PROMPT_INPUT_ERROR") as TCode;
  }

  // The default instanceof check; declared so narrowing infers the code from its constraint instead of `any`.
  static [Symbol.hasInstance]<T>(this: abstract new (...args: never) => T, value: unknown): value is T {
    return Function.prototype[Symbol.hasInstance].call(this, value);
  }
}

type AskFn = (label: string) => Promise<string>;

export interface PromptOptions {
  /** Answers each question; replaces the default readline asker. */
  ask?: AskFn;
  /**
   * Where the default asker writes the question. When an options object names `output` or `nonInteractive`, the
   * default is stderr, so stdout stays free for results; otherwise (including `createPrompt()` and `prompt`) it
   * is stdout, as before.
   */
  output?: NodeJS.WritableStream;
  /** Every prompt throws `PromptInputError` with code `CLIFN_PROMPT_NON_INTERACTIVE` instead of asking. */
  nonInteractive?: boolean;
}

export interface PromptApi {
  select<T extends string>(label: string, choices: T[]): Promise<T>;
  multiSelect<T extends string>(label: string, choices: T[]): Promise<T[]>;
  text(label: string, options?: { default?: string }): Promise<string>;
  confirm(label: string): Promise<boolean>;
}

function assertChoices(choices: readonly string[]): void {
  if (choices.length === 0) {
    throw new PromptInputError("choices cannot be empty");
  }
}

function createReadlineAskFn(output?: NodeJS.WritableStream): AskFn {
  return async (label: string): Promise<string> => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: output ?? process.stdout,
    });
    return await new Promise((resolve) => {
      rl.question(label, (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  };
}

function resolveChoice<T extends string>(value: string, choices: readonly T[]): T {
  const trimmed = value.trim();
  const byLabel = choices.find((choice) => choice === trimmed);
  if (byLabel) {
    return byLabel;
  }
  const idx = Number(trimmed);
  if (Number.isInteger(idx) && idx >= 1 && idx <= choices.length) {
    return choices[idx - 1];
  }
  throw new PromptInputError(`invalid selection "${value}"`);
}

function hasOwn(target: object, key: string): boolean {
  return Object.hasOwn(target, key);
}

function resolveAsk(options: PromptOptions | undefined): AskFn {
  if (options === undefined || options === null) {
    return createReadlineAskFn();
  }

  if (options.ask) {
    return options.ask;
  }

  // Only the options introduced with `output` and `nonInteractive` move the question to stderr (D2).
  const newForm = hasOwn(options, "output") || hasOwn(options, "nonInteractive");
  return createReadlineAskFn(options.output ?? (newForm ? process.stderr : undefined));
}

function nonInteractiveError(label: string): PromptInputError<"CLIFN_PROMPT_NON_INTERACTIVE"> {
  return new PromptInputError(
    `prompt "${label}" needs an answer, but prompts are non-interactive`,
    "CLIFN_PROMPT_NON_INTERACTIVE"
  );
}

function createNonInteractivePrompt(): PromptApi {
  return {
    async select(label) {
      throw nonInteractiveError(label);
    },
    async multiSelect(label) {
      throw nonInteractiveError(label);
    },
    async text(label) {
      throw nonInteractiveError(label);
    },
    async confirm(label) {
      throw nonInteractiveError(label);
    },
  };
}

export function createPrompt(options?: PromptOptions): PromptApi {
  if (options?.nonInteractive === true) {
    return createNonInteractivePrompt();
  }

  const ask = resolveAsk(options);

  return {
    async select<T extends string>(label: string, choices: T[]): Promise<T> {
      assertChoices(choices);
      const menu = choices.map((choice, idx) => `${idx + 1}) ${choice}`).join(", ");
      const input = await ask(`${label} [${menu}]: `);
      return resolveChoice(input, choices);
    },
    async multiSelect<T extends string>(label: string, choices: T[]): Promise<T[]> {
      assertChoices(choices);
      const menu = choices.map((choice, idx) => `${idx + 1}) ${choice}`).join(", ");
      const input = await ask(`${label} [${menu}] (comma-separated): `);
      const tokens = input
        .split(",")
        .map((token) => token.trim())
        .filter((token) => token.length > 0);
      if (tokens.length === 0) {
        return [];
      }
      const selected = tokens.map((token) => resolveChoice(token, choices));
      return Array.from(new Set(selected));
    },
    async text(label: string, options?: { default?: string }): Promise<string> {
      const input = await ask(`${label}: `);
      const trimmed = input.trim();
      if (trimmed.length === 0 && options?.default !== undefined) {
        return options.default;
      }
      return trimmed;
    },
    async confirm(label: string): Promise<boolean> {
      const input = (await ask(`${label} [y/n]: `)).trim().toLowerCase();
      if (input === "y" || input === "yes") {
        return true;
      }
      if (input === "n" || input === "no") {
        return false;
      }
      throw new PromptInputError(`invalid confirmation "${input}"`);
    },
  };
}

export const prompt: PromptApi = createPrompt();
