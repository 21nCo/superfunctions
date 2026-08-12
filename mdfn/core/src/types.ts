export type MdfnJsonPrimitive = string | number | boolean | null;
export type MdfnJsonValue =
  | MdfnJsonPrimitive
  | readonly MdfnJsonValue[]
  | { readonly [key: string]: MdfnJsonValue };

export type PreservationLevel = "exact" | "semantic" | "opaque";
export type DiagnosticSeverity = "info" | "warning" | "error";

export interface SourceSpan {
  readonly from: number;
  readonly to: number;
  readonly raw?: string;
  readonly syntax?: Readonly<Record<string, MdfnJsonValue>>;
  readonly preservation: PreservationLevel;
  readonly dirty?: boolean;
}

export interface MdfnMark {
  readonly type: string;
  readonly attrs?: Readonly<Record<string, MdfnJsonValue>>;
}

export interface MdfnNode {
  readonly type: string;
  readonly id?: string;
  readonly attrs?: Readonly<Record<string, MdfnJsonValue>>;
  readonly marks?: readonly MdfnMark[];
  readonly content?: readonly MdfnNode[];
  readonly text?: string;
  readonly source?: SourceSpan;
}

export interface MdfnDocument extends MdfnNode {
  readonly type: "doc";
  readonly schemaVersion: number;
  readonly content: readonly MdfnNode[];
}

export interface MdfnDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly severity: DiagnosticSeverity;
  readonly source?: { readonly from: number; readonly to: number };
  readonly nodeId?: string;
  readonly extension?: string;
  readonly details?: Readonly<Record<string, MdfnJsonValue>>;
}

export interface TextSelection {
  readonly kind: "text";
  readonly anchor: number;
  readonly head: number;
}

export interface NodeSelection {
  readonly kind: "node";
  readonly nodeId: string;
}

export type MdfnSelection = TextSelection | NodeSelection | null;

export interface SidecarAnchor {
  readonly from: number;
  readonly to: number;
  readonly affinity?: "before" | "after";
}

export interface CommentMessage {
  readonly id: string;
  readonly authorId: string;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt?: string;
}

export interface CommentThread {
  readonly id: string;
  readonly anchor: SidecarAnchor;
  readonly resolved: boolean;
  readonly messages: readonly CommentMessage[];
}

export interface Suggestion {
  readonly id: string;
  readonly anchor: SidecarAnchor;
  readonly replacement: string;
  readonly authorId: string;
  readonly status: "pending" | "accepted" | "rejected";
  readonly createdAt: string;
}

export interface AssetMetadata {
  readonly id: string;
  readonly mediaType: string;
  readonly name?: string;
  readonly byteSize?: number;
  readonly metadata?: Readonly<Record<string, MdfnJsonValue>>;
}

export interface MdfnSidecar {
  readonly comments?: readonly CommentThread[];
  readonly suggestions?: readonly Suggestion[];
  readonly assets?: readonly AssetMetadata[];
  readonly historyRef?: string;
}

export interface MdfnSnapshot {
  readonly format: "mdfn";
  readonly version: 1;
  readonly markdown: string;
  readonly document?: MdfnDocument;
  readonly schemaHash: string;
  readonly sourceHash: string;
  readonly diagnostics: readonly MdfnDiagnostic[];
  readonly sidecar?: MdfnSidecar;
}

export interface ParseResult {
  readonly document: MdfnDocument;
  readonly diagnostics: readonly MdfnDiagnostic[];
  readonly sourceHash?: string;
}

export interface SerializeResult {
  readonly markdown: string;
  readonly diagnostics: readonly MdfnDiagnostic[];
  readonly preservation: {
    readonly exactUntouched: boolean;
    readonly semanticSupported: boolean;
    readonly opaqueUnsupported: boolean;
    readonly touchedRegionOnly: boolean;
  };
}

export interface EditorProjector {
  parse(markdown: string): ParseResult;
  serialize(document: MdfnDocument, originalMarkdown: string): SerializeResult;
}

export interface EditorState {
  readonly version: number;
  readonly markdown: string;
  readonly document: MdfnDocument;
  readonly schemaHash: string;
  readonly sourceHash: string;
  readonly selection: MdfnSelection;
  readonly diagnostics: readonly MdfnDiagnostic[];
  readonly sidecar?: MdfnSidecar;
  readonly dirty: boolean;
}

export interface ChangedRange {
  readonly from: number;
  readonly to: number;
  readonly insertedLength: number;
}

export interface StateChange {
  readonly previous: EditorState;
  readonly current: EditorState;
  readonly changedRanges: readonly ChangedRange[];
  readonly documentChanged: boolean;
  readonly selectionChanged: boolean;
  readonly sidecarChanged: boolean;
  readonly source: string;
  readonly metadata: Readonly<Record<string, MdfnJsonValue>>;
}

export type EditorListener = (change: StateChange) => void;

export interface EditorCommandContext {
  readonly state: EditorState;
  dispatch(transaction: unknown): StateChange;
}

export type EditorCommand = (context: EditorCommandContext) => boolean;

export interface SchemaContribution {
  readonly nodes?: readonly string[];
  readonly marks?: readonly string[];
}

export interface ExtensionParseInput {
  readonly source: string;
  readonly offset: number;
  readonly line: string;
}

export interface ExtensionParseResult {
  readonly node: MdfnNode;
  readonly consumed: number;
  readonly diagnostics?: readonly MdfnDiagnostic[];
}

export interface ExtensionSerializeInput {
  readonly node: MdfnNode;
}

export interface ExtensionRenderInput {
  readonly node: MdfnNode;
  readonly escape: (value: string) => string;
}

export interface ExtensionMigration {
  readonly from: number;
  readonly to: number;
  migrate(document: MdfnDocument): MdfnDocument;
}

export interface PreservationDeclaration {
  readonly noEdit: "exact" | "semantic";
  readonly edited: "touched-region" | "semantic";
  readonly unsupported: "opaque" | "diagnostic-only";
}

export interface MdfnExtension {
  readonly name: string;
  readonly version: string;
  readonly priority?: number;
  readonly dependencies?: readonly string[];
  readonly conflicts?: readonly string[];
  readonly schema?: SchemaContribution;
  readonly parseMarkdown?: (input: ExtensionParseInput) => ExtensionParseResult | null;
  readonly serializeMarkdown?: (input: ExtensionSerializeInput) => string | null;
  readonly render?: (input: ExtensionRenderInput) => string | null;
  readonly commands?: Readonly<Record<string, EditorCommand>>;
  readonly keymap?: Readonly<Record<string, string>>;
  readonly inputRules?: readonly string[];
  readonly pasteRules?: readonly string[];
  readonly migrations?: readonly ExtensionMigration[];
  readonly diagnostics?: (document: MdfnDocument) => readonly MdfnDiagnostic[];
  readonly preservation: PreservationDeclaration;
  readonly security?: {
    readonly allowsRawHtml?: boolean;
    readonly urlSchemes?: readonly string[];
    readonly executesContent?: boolean;
  };
}
