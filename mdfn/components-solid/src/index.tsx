import { createMemo, createSignal, For, Show, type Component } from "solid-js";
import { Button, Card, Input, ToolbarButton, ToolbarRoot } from "@uifn/components-solid";
import { createAuthoringModel, createToolbarModel, runToolbarAction, type ToolbarCommandTarget, type ToolbarGroup } from "@mdfn/components";
import { Transaction, canTransitionReview, createCommentThread, decideSuggestion, transitionReview, type EditorController, type EditorialActor, type ReviewState } from "@mdfn/core";
import type { EditorMode } from "@mdfn/source";
import { MdfnEditor, createMdfnSignal, type MdfnEditorHandle, type MdfnEditorProps } from "@mdfn/solid";

export const MdfnToolbar: Component<{ controller: EditorController; groups?: readonly ToolbarGroup[]; ariaLabel?: string; class?: string; commandTarget?: ToolbarCommandTarget | null }> = (props) => {
  const snapshot = createMdfnSignal(props.controller);
  const model = () => { snapshot().version; return createToolbarModel(props.controller, props.groups, props.ariaLabel, props.commandTarget); };
  return <ToolbarRoot class={props.class} data-mdfn-component="toolbar" aria-label={model().ariaLabel}>
    <For each={model().groups}>{(group) => <span role="group" aria-label={group.label} data-mdfn-toolbar-group={group.id}>
      <For each={group.actions}>{(action) => <ToolbarButton value={action.id} type="button" disabled={action.disabled} aria-label={action.label} aria-pressed={action.pressed} title={action.shortcut ? `${action.label} (${action.shortcut})` : action.label} onClick={() => runToolbarAction(props.controller, action, props.commandTarget)}>{action.label}</ToolbarButton>}</For>
    </span>}</For>
  </ToolbarRoot>;
};

export interface MdfnEditorShellProps extends MdfnEditorProps { readonly toolbarGroups?: readonly ToolbarGroup[]; readonly hideToolbar?: boolean; readonly hideAuthoringChrome?: boolean; readonly actor?: EditorialActor; readonly onSelectFiles?: (files: readonly File[]) => Promise<string | undefined>; readonly onModeChange?: (mode: EditorMode) => void; }
export const MdfnEditorShell: Component<MdfnEditorShellProps> = (props) => {
  const [commandTarget, setCommandTarget] = createSignal<ToolbarCommandTarget | null>(null);
  const [editor, setEditorHandle] = createSignal<MdfnEditorHandle | null>(null);
  const setEditor = (value: MdfnEditorHandle | null): void => {
    setEditorHandle(value);
    setCommandTarget(value ? {
      can: (command) => value.can(command as Parameters<MdfnEditorHandle["can"]>[0]),
      run: (command) => value.run(command as Parameters<MdfnEditorHandle["run"]>[0]),
    } : null);
    props.editorRef?.(value);
  };
  return <div data-mdfn-component="editor-shell">
    {!props.hideToolbar && !props.readOnly && <MdfnToolbar controller={props.controller} groups={props.toolbarGroups} commandTarget={commandTarget()} />}
    {!props.hideAuthoringChrome && <MdfnAuthoringChrome controller={props.controller} editor={editor()} mode={props.mode} readOnly={props.readOnly} actor={props.actor} onSelectFiles={props.onSelectFiles} onModeChange={props.onModeChange} />}
    <MdfnEditor {...props} onFiles={async (files) => { const markdown = await props.onSelectFiles?.(files); if (markdown) editor()?.insertMarkdown(markdown); await props.onFiles?.(files); }} editorRef={setEditor} />
  </div>;
};

export interface MdfnAuthoringChromeProps { readonly controller: EditorController; readonly editor?: MdfnEditorHandle | null; readonly mode?: EditorMode; readonly readOnly?: boolean; readonly compact?: boolean; readonly actor?: EditorialActor; readonly onSelectFiles?: (files: readonly File[]) => Promise<string | undefined>; readonly onModeChange?: (mode: EditorMode) => void; }
const editorModes: readonly EditorMode[] = ["visual", "source", "split", "preview", "read-only"];

export const MdfnAuthoringChrome: Component<MdfnAuthoringChromeProps> = (props) => {
  const snapshot = createMdfnSignal(props.controller);
  const [slashQuery, setSlashQuery] = createSignal("");
  const [link, setLink] = createSignal("");
  const [rows, setRows] = createSignal(2);
  const [columns, setColumns] = createSignal(2);
  const [comment, setComment] = createSignal("");
  const actor = () => props.actor ?? { id: "local-author" };
  const model = createMemo(() => { snapshot().version; return createAuthoringModel(props.controller, { mode: props.mode, compact: props.compact, slashQuery: slashQuery() }); });
  const commandTarget = (): ToolbarCommandTarget | null => props.editor ? { can: (command) => props.editor?.can(command as Parameters<MdfnEditorHandle["can"]>[0]) ?? false, run: (command) => props.editor?.run(command as Parameters<MdfnEditorHandle["run"]>[0]) ?? false } : null;
  const updateSidecar = (sidecar: NonNullable<ReturnType<EditorController["getState"]>["sidecar"]>, source: string): void => { props.controller.dispatch(new Transaction().setSidecar(sidecar).withSource(source)); };
  const addComment = (): void => {
    const state = props.controller.getState();
    const selection = state.selection?.kind === "text" ? state.selection : { anchor: 0, head: 0 };
    const result = createCommentThread({ sidecar: state.sidecar, anchor: { from: Math.min(selection.anchor, selection.head), to: Math.max(selection.anchor, selection.head) }, body: comment(), actor: actor(), markdownLength: state.markdown.length });
    updateSidecar(result.sidecar, "editorial:comment"); setComment("");
  };
  const setReview = (to: ReviewState): void => updateSidecar(transitionReview({ sidecar: props.controller.getState().sidecar, to, actor: actor() }), "editorial:review");
  return <section data-mdfn-component="authoring-chrome" data-compact={model().compact ? "true" : "false"} aria-label="Markdown authoring controls">
    <nav aria-label="Editor mode" data-mdfn-surface="mode-switcher"><For each={editorModes}>{(mode) => <Button type="button" aria-pressed={props.mode === mode} disabled={!props.onModeChange} onClick={() => props.onModeChange?.(mode)}>{mode}</Button>}</For></nav>
    <Show when={!props.readOnly}><MdfnToolbar controller={props.controller} groups={model().bubble.groups} commandTarget={commandTarget()} ariaLabel="Selection formatting" /></Show>
    <Show when={!props.readOnly}><div data-mdfn-surface="floating-toolbar"><MdfnToolbar controller={props.controller} groups={model().floating.groups} commandTarget={commandTarget()} ariaLabel="Block formatting" /></div></Show>
    <Show when={!props.readOnly}><Card data-mdfn-surface="slash-menu"><Card.Header><Card.Title>Insert</Card.Title></Card.Header><Card.Content><Input aria-label="Filter insert commands" value={slashQuery()} onInput={(event) => setSlashQuery(event.currentTarget.value)} /><div role="listbox" aria-label="Insert commands"><For each={model().slashCommands}>{(item) => <Button type="button" role="option" onClick={() => item.kind === "command" && item.command ? props.editor?.run(item.command as Parameters<MdfnEditorHandle["run"]>[0]) : item.kind === "table" ? props.editor?.insertTable(rows(), columns()) : item.kind === "link" ? props.editor?.setLink(link()) : undefined}>{item.label}</Button>}</For></div></Card.Content></Card></Show>
    <Show when={!props.readOnly}><Card data-mdfn-surface="link-editor"><Card.Header><Card.Title>Link</Card.Title></Card.Header><Card.Content><Input type="url" aria-label="Link URL" value={link()} onInput={(event) => setLink(event.currentTarget.value)} /><Button type="button" onClick={() => props.editor?.setLink(link())}>Apply link</Button><Button type="button" onClick={() => props.editor?.removeLink()}>Remove link</Button></Card.Content></Card></Show>
    <Show when={!props.readOnly}><Card data-mdfn-surface="table-controls"><Card.Header><Card.Title>Table</Card.Title></Card.Header><Card.Content><Input type="number" min={1} max={100} aria-label="Table rows" value={rows()} onInput={(event) => setRows(Number(event.currentTarget.value))} /><Input type="number" min={1} max={100} aria-label="Table columns" value={columns()} onInput={(event) => setColumns(Number(event.currentTarget.value))} /><Button type="button" onClick={() => props.editor?.insertTable(rows(), columns())}>Insert table</Button></Card.Content></Card></Show>
    <Show when={!props.readOnly}><Card data-mdfn-surface="file-controls"><Card.Header><Card.Title>Files</Card.Title></Card.Header><Card.Content><Input type="file" aria-label="Select files" multiple onChange={(event) => { const files = [...(event.currentTarget.files ?? [])]; void props.onSelectFiles?.(files).then((markdown) => { if (markdown) props.editor?.insertMarkdown(markdown); }); }} /></Card.Content></Card></Show>
    <nav data-mdfn-surface="outline" aria-label="Document outline"><ol><For each={model().outline}>{(item) => <li data-level={item.level}><Button type="button" onClick={() => item.from !== undefined && props.controller.dispatch(new Transaction().setSelection({ kind: "text", anchor: item.from, head: item.from }).withSource("outline"))}>{item.text}</Button></li>}</For></ol></nav>
    <aside data-mdfn-surface="diagnostics" aria-label="Markdown diagnostics" aria-live="polite"><ul><For each={model().diagnostics}>{(diagnostic) => <li data-severity={diagnostic.severity}>{diagnostic.message}</li>}</For></ul></aside>
    <Card data-mdfn-surface="editorial"><Card.Header><Card.Title>Review</Card.Title></Card.Header><Card.Content><p>State: {model().reviewState}</p><Show when={!props.readOnly}><Input aria-label="Comment" value={comment()} onInput={(event) => setComment(event.currentTarget.value)} /><Button type="button" disabled={!comment().trim()} onClick={addComment}>Add comment</Button></Show><ul aria-label="Comments"><For each={model().comments ?? []}>{(thread) => <li>{thread.messages.at(-1)?.body} {thread.resolved ? "Resolved" : "Open"}</li>}</For></ul><ul aria-label="Suggestions"><For each={model().suggestions ?? []}>{(suggestion) => <li>{suggestion.replacement} ({suggestion.status}) <Show when={suggestion.status === "pending" && !props.readOnly}><Button type="button" onClick={() => decideSuggestion({ controller: props.controller, suggestionId: suggestion.id, decision: "accepted", actor: actor() })}>Accept</Button><Button type="button" onClick={() => decideSuggestion({ controller: props.controller, suggestionId: suggestion.id, decision: "rejected", actor: actor() })}>Reject</Button></Show></li>}</For></ul><Show when={!props.readOnly}><div aria-label="Review transitions"><For each={["draft", "in-review", "changes-requested", "approved"] as const}>{(state) => <Button type="button" disabled={state === model().reviewState || !canTransitionReview(model().reviewState, state)} onClick={() => setReview(state)}>{state}</Button>}</For></div></Show></Card.Content></Card>
    <Card data-mdfn-surface="history"><Card.Header><Card.Title>History</Card.Title></Card.Header><Card.Content><ol><For each={model().audit ?? []}>{(entry) => <li>{entry.action} by {entry.actorId}</li>}</For></ol></Card.Content></Card>
  </section>;
};

export { MdfnEditor } from "@mdfn/solid";
export const MDFN_COMPONENTS_SOLID_VERSION = "0.1.0" as const;
