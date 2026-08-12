<script lang="ts">
  import { ButtonRoot, CardContent, CardHeader, CardRoot, CardTitle, InputRoot } from '@uifn/components-svelte';
  import { createAuthoringModel } from '@mdfn/components';
  import { Transaction, canTransitionReview, createCommentThread, decideSuggestion, transitionReview, type EditorController, type EditorialActor, type ReviewState } from '@mdfn/core';
  import type { EditorMode } from '@mdfn/source';
  import type { MdfnEditorHandle } from '@mdfn/svelte';
  import MdfnToolbar from './MdfnToolbar.svelte';

  let { controller, editor = null, mode = 'visual', readOnly = false, compact = false, actor, onSelectFiles, onModeChange }: {
    controller: EditorController;
    editor?: MdfnEditorHandle | null;
    mode?: EditorMode;
    readOnly?: boolean;
    compact?: boolean;
    actor?: EditorialActor;
    onSelectFiles?: (files: readonly File[]) => Promise<string | undefined>;
    onModeChange?: (mode: EditorMode) => void;
  } = $props();
  let version = $state(0);
  let slashQuery = $state('');
  let link = $state('');
  let rows = $state(2);
  let columns = $state(2);
  let comment = $state('');
  const modes: readonly EditorMode[] = ['visual', 'source', 'split', 'preview', 'read-only'];
  $effect(() => {
    version = controller.getState().version;
    return controller.subscribe((change) => { version = change.current.version; });
  });
  const model = $derived.by(() => { void version; return createAuthoringModel(controller, { mode, compact, slashQuery }); });
  const currentActor = $derived(actor ?? { id: 'local-author' });
  const commandTarget = $derived(editor ? ({ can: (command: string) => editor?.can(command as Parameters<MdfnEditorHandle['can']>[0]) ?? false, run: (command: string) => editor?.run(command as Parameters<MdfnEditorHandle['run']>[0]) ?? false }) : null);

  function updateSidecar(sidecar: NonNullable<ReturnType<EditorController['getState']>['sidecar']>, source: string) {
    controller.dispatch(new Transaction().setSidecar(sidecar).withSource(source));
  }
  function addComment() {
    const state = controller.getState();
    const selection = state.selection?.kind === 'text' ? state.selection : { anchor: 0, head: 0 };
    const result = createCommentThread({ sidecar: state.sidecar, anchor: { from: Math.min(selection.anchor, selection.head), to: Math.max(selection.anchor, selection.head) }, body: comment, actor: currentActor, markdownLength: state.markdown.length });
    updateSidecar(result.sidecar, 'editorial:comment');
    comment = '';
  }
  function setReview(to: ReviewState) {
    updateSidecar(transitionReview({ sidecar: controller.getState().sidecar, to, actor: currentActor }), 'editorial:review');
  }
  function selectFiles(event: Event) {
    const files = [...((event.currentTarget as HTMLInputElement).files ?? [])];
    void onSelectFiles?.(files).then((markdown) => { if (markdown) editor?.insertMarkdown(markdown); });
  }
</script>

<section data-mdfn-component="authoring-chrome" data-compact={model.compact ? 'true' : 'false'} aria-label="Markdown authoring controls">
  <nav aria-label="Editor mode" data-mdfn-surface="mode-switcher">{#each modes as item}<ButtonRoot type="button" aria-pressed={mode === item} disabled={!onModeChange} onclick={() => onModeChange?.(item)}>{item}</ButtonRoot>{/each}</nav>
  {#if !readOnly}<div data-mdfn-surface="bubble-toolbar"><MdfnToolbar {controller} groups={model.bubble.groups} {commandTarget} ariaLabel="Selection formatting" /></div>{/if}
  {#if !readOnly}<div data-mdfn-surface="floating-toolbar"><MdfnToolbar {controller} groups={model.floating.groups} {commandTarget} ariaLabel="Block formatting" /></div>{/if}
  {#if !readOnly}
    <CardRoot data-mdfn-surface="slash-menu"><CardHeader><CardTitle>Insert</CardTitle></CardHeader><CardContent><InputRoot aria-label="Filter insert commands" value={slashQuery} oninput={(event: Event) => slashQuery = (event.currentTarget as HTMLInputElement).value} /><div role="listbox" aria-label="Insert commands">{#each model.slashCommands as item (item.id)}<ButtonRoot type="button" role="option" onclick={() => item.kind === 'command' && item.command ? editor?.run(item.command as Parameters<MdfnEditorHandle['run']>[0]) : item.kind === 'table' ? editor?.insertTable(rows, columns) : item.kind === 'link' ? editor?.setLink(link) : undefined}>{item.label}</ButtonRoot>{/each}</div></CardContent></CardRoot>
    <CardRoot data-mdfn-surface="link-editor"><CardHeader><CardTitle>Link</CardTitle></CardHeader><CardContent><InputRoot type="url" aria-label="Link URL" value={link} oninput={(event: Event) => link = (event.currentTarget as HTMLInputElement).value} /><ButtonRoot type="button" onclick={() => editor?.setLink(link)}>Apply link</ButtonRoot><ButtonRoot type="button" onclick={() => editor?.removeLink()}>Remove link</ButtonRoot></CardContent></CardRoot>
    <CardRoot data-mdfn-surface="table-controls"><CardHeader><CardTitle>Table</CardTitle></CardHeader><CardContent><InputRoot type="number" min={1} max={100} aria-label="Table rows" value={rows} oninput={(event: Event) => rows = Number((event.currentTarget as HTMLInputElement).value)} /><InputRoot type="number" min={1} max={100} aria-label="Table columns" value={columns} oninput={(event: Event) => columns = Number((event.currentTarget as HTMLInputElement).value)} /><ButtonRoot type="button" onclick={() => editor?.insertTable(rows, columns)}>Insert table</ButtonRoot></CardContent></CardRoot>
    <CardRoot data-mdfn-surface="file-controls"><CardHeader><CardTitle>Files</CardTitle></CardHeader><CardContent><InputRoot type="file" aria-label="Select files" multiple onchange={selectFiles} /></CardContent></CardRoot>
  {/if}
  <nav data-mdfn-surface="outline" aria-label="Document outline"><ol>{#each model.outline as item (item.id)}<li data-level={item.level}><ButtonRoot type="button" onclick={() => item.from !== undefined && controller.dispatch(new Transaction().setSelection({ kind: 'text', anchor: item.from, head: item.from }).withSource('outline'))}>{item.text}</ButtonRoot></li>{/each}</ol></nav>
  <aside data-mdfn-surface="diagnostics" aria-label="Markdown diagnostics" aria-live="polite"><ul>{#each model.diagnostics as diagnostic, index (`${diagnostic.code}-${index}`)}<li data-severity={diagnostic.severity}>{diagnostic.message}</li>{/each}</ul></aside>
  <CardRoot data-mdfn-surface="editorial"><CardHeader><CardTitle>Review</CardTitle></CardHeader><CardContent><p>State: {model.reviewState}</p>{#if !readOnly}<InputRoot aria-label="Comment" value={comment} oninput={(event: Event) => comment = (event.currentTarget as HTMLInputElement).value} /><ButtonRoot type="button" disabled={!comment.trim()} onclick={addComment}>Add comment</ButtonRoot>{/if}<ul aria-label="Comments">{#each model.comments ?? [] as thread (thread.id)}<li>{thread.messages.at(-1)?.body} {thread.resolved ? 'Resolved' : 'Open'}</li>{/each}</ul><ul aria-label="Suggestions">{#each model.suggestions ?? [] as suggestion (suggestion.id)}<li>{suggestion.replacement} ({suggestion.status}) {#if suggestion.status === 'pending' && !readOnly}<ButtonRoot type="button" onclick={() => decideSuggestion({ controller, suggestionId: suggestion.id, decision: 'accepted', actor: currentActor })}>Accept</ButtonRoot><ButtonRoot type="button" onclick={() => decideSuggestion({ controller, suggestionId: suggestion.id, decision: 'rejected', actor: currentActor })}>Reject</ButtonRoot>{/if}</li>{/each}</ul>{#if !readOnly}<div aria-label="Review transitions">{#each ['draft', 'in-review', 'changes-requested', 'approved'] as state}<ButtonRoot type="button" disabled={state === model.reviewState || !canTransitionReview(model.reviewState, state as ReviewState)} onclick={() => setReview(state as ReviewState)}>{state}</ButtonRoot>{/each}</div>{/if}</CardContent></CardRoot>
  <CardRoot data-mdfn-surface="history"><CardHeader><CardTitle>History</CardTitle></CardHeader><CardContent><ol>{#each model.audit ?? [] as entry (entry.id)}<li>{entry.action} by {entry.actorId}</li>{/each}</ol></CardContent></CardRoot>
</section>
