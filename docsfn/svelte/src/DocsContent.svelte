<script lang="ts">
  import type { ComponentType } from "svelte";
  import {
    assertCompiledContentTrusted,
    compileSvelteContent,
    type CompiledContentArtifact,
    type DocsCompatPreset,
  } from "@docsfn/core/browser";

  export let compiled: CompiledContentArtifact | undefined = undefined;
  export let content = "";
  export let sourcePath: string | undefined = undefined;
  export let compatPreset: DocsCompatPreset = "none";
  export let allowUnsafeHtml = false;
  export let unsafeHtmlAllowlist: string[] = [];
  export let components: Record<string, ComponentType | undefined> = {};

  let activeTabs: Record<number, string> = {};

  $: compiledContent =
    compiled ??
    compileSvelteContent({
      source: content,
      sourcePath,
      compatPreset,
      allowRawHtml: allowUnsafeHtml,
    });

  $: if (compiled) {
    assertCompiledContentTrusted({
      source: compiled.transformedSource || compiled.source || "",
      sourcePath,
      policy: {
        allowUnsafeHtml,
        allowUnsafeHtmlAllowlist: unsafeHtmlAllowlist,
      },
    });
  }

  function activateTab(index: number, value: string) {
    activeTabs = {
      ...activeTabs,
      [index]: value,
    };
  }
</script>

<div class="docsfn-content">
  {#each compiledContent.blocks as block, index}
    {#if block.type === "heading"}
      <svelte:element this={`h${block.level}`} id={block.slug}>{@html block.html}</svelte:element>
    {:else if block.type === "paragraph"}
      <p>{@html block.html}</p>
    {:else if block.type === "list"}
      {@html block.html}
    {:else if block.type === "table"}
      {@html block.html}
    {:else if block.type === "code"}
      <pre data-docsfn-code="true"><code data-lang={block.lang}>{block.code}</code></pre>
    {:else if block.type === "mermaid"}
      <pre data-docsfn-mermaid="true"><code>{block.code}</code></pre>
    {:else if block.type === "callout"}
      <aside data-docsfn-callout={block.kind}>
        {@html block.html}
      </aside>
    {:else if block.type === "tabs"}
      {@const fallbackTab = block.items[0] ?? block.tabs[0]?.value ?? ""}
      {@const activeValue = activeTabs[index] ?? fallbackTab}
      {@const activeTab = block.tabs.find((tab) => tab.value === activeValue) ?? block.tabs[0]}
      <div data-docsfn-tabs="true">
        <div role="tablist" aria-label="Tabs">
          {#each block.items as item}
            <button
              type="button"
              role="tab"
              aria-selected={item === activeValue}
              on:click={() => activateTab(index, item)}
            >
              {item}
            </button>
          {/each}
        </div>
        <div role="tabpanel">
          {#if activeTab}
            <pre>{activeTab.content}</pre>
          {/if}
        </div>
      </div>
    {:else}
      {#if components[block.name]}
        <svelte:component this={components[block.name]}>{block.body ?? ""}</svelte:component>
      {:else}
        <div data-docsfn-component={block.name}>{block.body ?? ""}</div>
      {/if}
    {/if}
  {/each}

  <div data-docsfn-page-actions="true">
    <slot name="page-actions" />
  </div>
</div>
