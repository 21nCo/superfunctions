import { sha256, type ArtifactStore, type ChangeHunks, type ChangeHunksCapture, type ChangeSnapshot, type PanelHarnessAdapter, type ReviewFnConfig, type SlotHarnessInput, type SlotHarnessOutput, type ContextAdapter, type ContextManifest, type ContextRequest, type ExecutionAdapter, type HarnessAdapter, type HarnessCapabilities, type HarnessInput, type HarnessOutput, type PreflightResult, type PublishRequest, type PublishResult, type ReportPublisher, type ReviewPolicy, type SourceControlAdapter, type TestReceipt } from "@superfunctions/reviewfn-core";

const ok: PreflightResult = { ok: true, diagnostics: [] };

export class MemoryArtifactStore implements ArtifactStore {
  public readonly values = new Map<string, Uint8Array>();
  public async put(kind: string, content: string | Uint8Array): Promise<{ digest: string; id: string }> { const bytes = Buffer.from(content); const digest = sha256(bytes); const id = `${kind}-${digest}`; this.values.set(id, bytes); return { digest, id }; }
  public async get(id: string): Promise<Uint8Array | undefined> { return this.values.get(id); }
  public async deleteExpired(): Promise<{ deleted: string[]; errors: string[] }> { return { deleted: [], errors: [] }; }
}

export class FakeContextAdapter implements ContextAdapter {
  public readonly id: string;
  public constructor(id: string, private readonly manifest: Omit<ContextManifest, "digest">, private readonly preflightResult: PreflightResult = ok) { this.id = id; }
  public async preflight(_request: ContextRequest): Promise<PreflightResult> { return this.preflightResult; }
  public async fetch(_request: ContextRequest): Promise<Omit<ContextManifest, "digest">> { return structuredClone(this.manifest); }
}

export interface FakeSourceControlOptions {
  baseCommit?: string;
  headCommit?: string;
  changedPaths?: string[];
  /** Hunks by `from` commit. When given, the adapter captures hunks and checks ancestry, so incremental reviews work. */
  hunks?: Record<string, ChangeHunks>;
}

export class FakeSourceControlAdapter implements SourceControlAdapter {
  public readonly id = "fake-source";
  public current: string;
  public changeHunks?: (root: string, from: string, to: string, maxBytes: number) => Promise<ChangeHunksCapture>;
  public isAncestor?: (root: string, ancestor: string, descendant: string) => Promise<boolean>;
  private readonly baseCommit: string;
  private readonly headCommit: string;
  private readonly changedPaths: string[];
  public constructor(options: FakeSourceControlOptions = {}) {
    this.baseCommit = options.baseCommit ?? "a".repeat(40);
    this.headCommit = options.headCommit ?? "b".repeat(40);
    this.current = this.headCommit;
    this.changedPaths = options.changedPaths ?? ["src/value.ts"];
    const hunks = options.hunks;
    if (hunks) {
      this.changeHunks = async (_root, from) => { const value = hunks[from]; if (!value) throw new Error(`No fixture hunks from ${from}.`); return { status: "parsed", hunks: structuredClone(value) }; };
      this.isAncestor = async (_root, ancestor) => ancestor === this.baseCommit || Object.hasOwn(hunks, ancestor);
    }
  }
  public async capture(): Promise<ChangeSnapshot> { return { repositoryId: "fixture", host: "local", targetBranch: "main", baseCommit: this.baseCommit, headCommit: this.headCommit, mergeBaseCommit: this.baseCommit, diffDigest: "c".repeat(64), changedPaths: [...this.changedPaths], capturedAt: "2026-01-01T00:00:00.000Z" }; }
  public async currentHead(): Promise<string> { return this.current; }
  public async verifyAnchor(_root: string, anchor: { path: string }): Promise<boolean> { return this.changedPaths.includes(anchor.path); }
}

export class FakeHarnessAdapter implements HarnessAdapter {
  public readonly capabilities: HarnessCapabilities = { id: "fake", version: "1", providers: ["fake"], authModes: ["none"], structuredOutput: true, observableEvents: true, usageMetrics: true, cancellation: true, toolControls: true, sandboxModes: ["isolated"] };
  public constructor(private readonly output: HarnessOutput) {}
  public async preflight(): Promise<PreflightResult> { return ok; }
  public async run(_input: HarnessInput): Promise<HarnessOutput> { return structuredClone(this.output); }
}

export class FakeExecutionAdapter implements ExecutionAdapter {
  public readonly id = "fake-execution";
  public constructor(private readonly receipts: TestReceipt[] = []) {}
  public async preflight(): Promise<PreflightResult> { return ok; }
  public async run(_root: string, _headCommit: string, _commands: string[][], _policy: ReviewPolicy): Promise<TestReceipt[]> { return structuredClone(this.receipts); }
}

export class FakePublisher implements ReportPublisher {
  public readonly id = "fake-publisher";
  public readonly requests: PublishRequest[] = [];
  public async preflight(): Promise<PreflightResult> { return ok; }
  public async publish(request: PublishRequest): Promise<PublishResult> { this.requests.push(request); return { status: "published", reference: "fixture" }; }
}

/** Scripted behavior for one panel slot. */
export type SlotBehavior = (input: SlotHarnessInput) => Promise<SlotHarnessOutput> | SlotHarnessOutput;

/** A completed lens output with no findings unless given; it inspects `inspectedPaths`. */
export function slotOutput(partial: Partial<SlotHarnessOutput> = {}): SlotHarnessOutput {
  return { terminal: "completed", requirements: [], assessments: [], evidence: [], findings: [], inspectedPaths: ["src/value.ts"], uninspected: [], events: [], ...partial };
}

/** Resolve after `ms`, or reject as soon as `signal` aborts. */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(new Error("aborted")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface FakePanelHarnessOptions {
  id?: string;
  /** The adapter contract version (`capabilities.version`), which preflight requires as `config.harness.version`; "1" by default. */
  version?: string;
  /** The version the harness reports (`resolved.harnessVersion`), as a real executable would; the contract version by default. */
  reportedVersion?: string;
  /** Behavior by slot ID; slots without one complete with `slotOutput()`. */
  behaviors?: Record<string, SlotBehavior>;
  /** Like Codex, overwrite `capabilities.version` with the reported version on every successful preflight. */
  overwriteVersionOnPreflight?: boolean;
  /** The model preflight resolves for a configuration; the configured model by default. */
  resolveModel?: (config: ReviewFnConfig) => string;
}

/**
 * One harness serving many panel slots, scripted per slot. It records every input and the most slots that were running
 * at once, so tests can observe prompts, workspaces and concurrency.
 */
export class FakePanelHarness implements PanelHarnessAdapter {
  public readonly capabilities: HarnessCapabilities;
  public readonly calls: SlotHarnessInput[] = [];
  public readonly behaviors: Record<string, SlotBehavior>;
  /** Every configuration preflight saw. */
  public readonly preflights: ReviewFnConfig[] = [];
  public readonly reportedVersion: string;
  /** The contract version preflight requires, fixed at construction as in a real adapter. */
  public readonly contractVersion: string;
  private readonly overwriteVersionOnPreflight: boolean;
  private readonly resolveModel?: (config: ReviewFnConfig) => string;
  public active = 0;
  public maxActive = 0;
  public constructor(options: FakePanelHarnessOptions = {}) {
    this.capabilities = { id: options.id ?? "fake", version: options.version ?? "1", providers: ["fake"], authModes: ["none"], structuredOutput: true, observableEvents: true, usageMetrics: true, cancellation: true, toolControls: true, sandboxModes: ["isolated"] };
    this.behaviors = { ...options.behaviors };
    this.contractVersion = this.capabilities.version;
    this.reportedVersion = options.reportedVersion ?? this.capabilities.version;
    this.overwriteVersionOnPreflight = options.overwriteVersionOnPreflight ?? false;
    this.resolveModel = options.resolveModel;
  }
  /** Like a real adapter, refuses a configuration for another adapter contract version. */
  public async preflight(config: ReviewFnConfig): Promise<PreflightResult> {
    this.preflights.push(structuredClone(config));
    if (config.harness.version !== this.contractVersion) return { ok: false, diagnostics: [{ code: "REVIEWFN_HARNESS_VERSION", level: "error", message: `Only ${this.capabilities.id} adapter contract version ${this.contractVersion} is supported.` }] };
    if (this.overwriteVersionOnPreflight) this.capabilities.version = this.reportedVersion;
    return { ok: true, diagnostics: [], resolved: { provider: config.inference.provider, model: this.resolveModel?.(config) ?? config.inference.model, auth: config.inference.auth, harnessVersion: this.reportedVersion } };
  }
  public async run(input: SlotHarnessInput): Promise<SlotHarnessOutput> {
    this.calls.push(input);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      const behavior = this.behaviors[input.slot.id];
      return structuredClone(behavior ? await behavior(input) : slotOutput());
    } finally { this.active -= 1; }
  }
  /** The input of the run for `slotId`. */
  public input(slotId: string): SlotHarnessInput {
    const found = this.calls.find(call => call.slot.id === slotId);
    if (!found) throw new Error(`Slot ${slotId} did not run.`);
    return found;
  }
}
