<script lang="ts">
  import { Transaction } from '@mdfn/core';
  import type { DomEditor } from '@mdfn/dom';
  import type { SourceEditor } from '@mdfn/source';
  import type { MdfnEditorHandle, MdfnEditorProps } from './types.js';

  let {
    controller,
    mode = 'visual',
    readOnly = false,
    ariaLabel = 'Markdown editor',
    class: className = '',
    onLoadError,
    editorRef,
  }: MdfnEditorProps = $props();

  let visualTarget = $state<HTMLElement>();
  let sourceTarget = $state<HTMLElement>();
  let previewTarget = $state<HTMLElement>();
  let loadError = $state<Error | null>(null);
  let value = $state('');

  $effect(() => {
    value = controller.getState().markdown;
    const unsubscribe = controller.subscribe((change) => { value = change.current.markdown; });
    return unsubscribe;
  });

  $effect(() => {
    const currentMode = mode;
    const currentVisual = visualTarget;
    const currentSource = sourceTarget;
    const currentPreview = previewTarget;
    let cancelled = false;
    let visual: DomEditor | undefined;
    let source: SourceEditor | undefined;
    const mount = async () => {
      try {
        if ((currentMode === 'visual' || currentMode === 'split') && currentVisual) {
          const module = await import('@mdfn/dom');
          if (cancelled) return;
          visual = module.createDomEditor({ target: currentVisual, controller, readOnly, attributes: { 'aria-label': ariaLabel } });
        }
        if ((currentMode === 'source' || currentMode === 'split') && currentSource) {
          const module = await import('@mdfn/source');
          if (cancelled) return;
          source = module.createSourceEditor({ target: currentSource, controller, readOnly, ariaLabel: `${ariaLabel} source` });
        }
        if ((currentMode === 'preview' || currentMode === 'read-only') && currentPreview) {
          const module = await import('@mdfn/source');
          if (cancelled) return;
          currentPreview.innerHTML = module.createPreview(controller).html;
        }
        const handle: MdfnEditorHandle = {
          focus() { visual?.focus(); source?.focus(); },
          run(command) { return visual?.run(command) ?? false; },
          can(command) { return visual?.can(command) ?? false; },
        };
        editorRef?.(handle);
      } catch (error) {
        loadError = error instanceof Error ? error : new Error(String(error));
        onLoadError?.(loadError);
      }
    };
    void mount();
    return () => { cancelled = true; editorRef?.(null); visual?.destroy(); source?.destroy(); };
  });

  $effect(() => {
    const currentValue = value;
    const currentMode = mode;
    const currentPreview = previewTarget;
    if ((currentMode !== 'preview' && currentMode !== 'read-only') || !currentPreview) return;
    let cancelled = false;
    void import('@mdfn/source').then((module) => {
      if (!cancelled) currentPreview.innerHTML = module.createPreview(controller).html;
    }).catch((error: unknown) => {
      loadError = error instanceof Error ? error : new Error(String(error));
      onLoadError?.(loadError);
    });
    void currentValue;
    return () => { cancelled = true; };
  });

  function updateFallback(event: Event) {
    const markdown = (event.currentTarget as HTMLTextAreaElement).value;
    const current = controller.getState().markdown;
    controller.dispatch(new Transaction().replaceSource(0, current.length, markdown).withSource('svelte:fallback'));
  }
</script>

{#if loadError}
  <div data-mdfn-source-fallback="true" class={className}>
    <div role="status">Visual editor unavailable: {loadError.message}</div>
    <textarea aria-label={`${ariaLabel} source fallback`} {value} readonly={readOnly} oninput={updateFallback}></textarea>
  </div>
{:else}
  <div data-mdfn-svelte="editor" data-mode={mode} class={className}>
    {#if mode === 'visual' || mode === 'split'}<div bind:this={visualTarget} data-mdfn-surface="visual"></div>{/if}
    {#if mode === 'source' || mode === 'split'}<div bind:this={sourceTarget} data-mdfn-surface="source"></div>{/if}
    {#if mode === 'preview' || mode === 'read-only'}<div bind:this={previewTarget} data-mdfn-surface="preview" aria-label={ariaLabel}></div>{/if}
  </div>
{/if}
