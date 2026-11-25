import { PassThrough } from "node:stream";

const readlineMock = vi.hoisted(() => ({
  createInterface: vi.fn(),
}));

vi.mock("node:readline", () => ({ default: readlineMock, ...readlineMock }));

import { createPrompt, prompt, PromptInputError } from "../src/prompt.js";

function answerWith(answer: string) {
  readlineMock.createInterface.mockImplementation((options: { output: NodeJS.WritableStream }) => ({
    question(label: string, callback: (value: string) => void) {
      options.output.write(label);
      callback(answer);
    },
    close: vi.fn(),
  }));
}

function lastInterfaceOptions(): { input: unknown; output: unknown } {
  const calls = readlineMock.createInterface.mock.calls;
  return calls[calls.length - 1][0] as { input: unknown; output: unknown };
}

beforeEach(() => {
  readlineMock.createInterface.mockReset();
});

describe("createPrompt options", () => {
  it.each([
    ["select", (api: ReturnType<typeof createPrompt>) => api.select("Pick", [])],
    ["multiSelect", (api: ReturnType<typeof createPrompt>) => api.multiSelect("Pick", ["a"])],
    ["text", (api: ReturnType<typeof createPrompt>) => api.text("Name", { default: "x" })],
    ["confirm", (api: ReturnType<typeof createPrompt>) => api.confirm("Continue")],
  ])("nonInteractive makes %s throw CLIFN_PROMPT_NON_INTERACTIVE without asking", async (_name, call) => {
    const ask = vi.fn(async () => "y");
    const api = createPrompt({ ask, nonInteractive: true });

    const error = await call(api).then(
      () => undefined,
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(PromptInputError);
    expect(error).toMatchObject({ name: "PromptInputError", code: "CLIFN_PROMPT_NON_INTERACTIVE" });
    expect(ask).not.toHaveBeenCalled();
    expect(readlineMock.createInterface).not.toHaveBeenCalled();
  });

  it("keeps the input error code for invalid answers", async () => {
    const api = createPrompt({ ask: async () => "maybe", nonInteractive: false });
    await expect(api.confirm("Continue")).rejects.toMatchObject({ code: "CLIFN_PROMPT_INPUT_ERROR" });
    expect(new PromptInputError("x").code).toBe("CLIFN_PROMPT_INPUT_ERROR");
  });

  it("keeps the default instanceof behaviour for the class, subclasses and other errors", () => {
    class LabelledError extends PromptInputError {}
    const sub = new LabelledError("x");
    expect(sub).toBeInstanceOf(PromptInputError);
    expect(sub).toBeInstanceOf(LabelledError);
    expect(sub).toBeInstanceOf(Error);
    expect(new PromptInputError("x") instanceof LabelledError).toBe(false);
    expect(new Error("x") instanceof PromptInputError).toBe(false);
    expect(null instanceof PromptInputError).toBe(false);
  });

  it("writes the question of the default asker to the given output stream", async () => {
    const output = new PassThrough();
    const written: string[] = [];
    output.on("data", (chunk: Buffer) => written.push(chunk.toString("utf8")));
    answerWith("Ada");

    await expect(createPrompt({ output }).text("Name")).resolves.toBe("Ada");

    expect(lastInterfaceOptions()).toEqual({ input: process.stdin, output });
    expect(written.join("")).toBe("Name: ");
  });

  it.each([
    ["{ nonInteractive: false }", { nonInteractive: false }],
    ["{ output: undefined }", { output: undefined }],
  ])("sends the default asker to stderr for the new options form %s", async (_label, options) => {
    answerWith("y");
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await expect(createPrompt(options).confirm("Continue")).resolves.toBe(true);
    } finally {
      err.mockRestore();
    }

    expect(lastInterfaceOptions().output).toBe(process.stderr);
  });

  it.each([
    ["createPrompt()", () => createPrompt()],
    ["createPrompt({})", () => createPrompt({})],
    ["the prompt singleton", () => prompt],
  ])("keeps %s writing the question to stdout", async (_label, make) => {
    answerWith("1");
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await expect(make().select("Pick", ["a", "b"])).resolves.toBe("a");
    } finally {
      out.mockRestore();
    }

    expect(lastInterfaceOptions()).toEqual({ input: process.stdin, output: process.stdout });
  });
});
