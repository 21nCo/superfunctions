<script lang="ts">
  import { MdfnEditor } from '@mdfn/svelte';
  import type { ToolbarGroup } from '@mdfn/components';
  import type { MdfnEditorHandle, MdfnEditorProps } from '@mdfn/svelte';
  import type { ToolbarCommandTarget } from '@mdfn/components';
  import MdfnToolbar from './MdfnToolbar.svelte';
  let { toolbarGroups, hideToolbar = false, class: className = '', ...editorProps }: MdfnEditorProps & { toolbarGroups?: readonly ToolbarGroup[]; hideToolbar?: boolean } = $props();
  let editor = $state<MdfnEditorHandle | null>(null);
  const commandTarget = $derived.by<ToolbarCommandTarget | null>(() => editor ? ({
    can: (command: string) => editor?.can(command as Parameters<MdfnEditorHandle['can']>[0]) ?? false,
    run: (command: string) => editor?.run(command as Parameters<MdfnEditorHandle['run']>[0]) ?? false,
  }) : null);
  function setEditor(value: MdfnEditorHandle | null) {
    editor = value;
    editorProps.editorRef?.(value);
  }
</script>

<div class={className} data-mdfn-component="editor-shell">
  {#if !hideToolbar && !editorProps.readOnly}<MdfnToolbar controller={editorProps.controller} groups={toolbarGroups} {commandTarget} />{/if}
  <MdfnEditor {...editorProps} editorRef={setEditor} />
</div>
