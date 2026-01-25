<script lang="ts">
  import type { Version } from '@docsfn/core';
  import {
    DropdownMenu,
    DropdownMenuTrigger,
    DropdownMenuContent,
    DropdownMenuItem,
  } from '@uifn/svelte';

  export let versions: Version[];
  export let currentVersion: string;
  export let onVersionChange: ((versionSlug: string) => void) | undefined = undefined;

  $: current = versions.find(v => v.slug === currentVersion);

  function handleChange(versionSlug: string) {
    if (onVersionChange) {
      onVersionChange(versionSlug);
    } else {
      // Default behavior: Navigate to same page in different version
      const currentPath = window.location.pathname;
      // Replace version in path (e.g., /v2/docs/intro -> /v3/docs/intro)
      const versionSlugs = versions.map(v => v.slug).join('|');
      const regex = new RegExp(`^/(${versionSlugs})/`);
      const newPath = currentPath.replace(regex, `/${versionSlug}/`);
      window.location.href = newPath;
    }
  }
</script>

{#if versions.length > 1}
  <DropdownMenu>
    <DropdownMenuTrigger class="docsfn-version-switcher-trigger">
      <span class="docsfn-version-label">{current?.label || currentVersion}</span>
      <svg 
        width="12" 
        height="12" 
        viewBox="0 0 12 12" 
        fill="none"
        aria-hidden="true"
      >
        <path 
          d="M3 5L6 8L9 5" 
          stroke="currentColor" 
          stroke-width="1.5" 
          stroke-linecap="round" 
          stroke-linejoin="round"
        />
      </svg>
    </DropdownMenuTrigger>
    <DropdownMenuContent class="docsfn-version-switcher-content">
      {#each versions as version (version.slug)}
        {@const isActive = version.slug === currentVersion}
        <DropdownMenuItem 
          on:click={() => handleChange(version.slug)}
          class="docsfn-version-item {isActive ? 'active' : ''}"
          data-active={isActive}
        >
          <span class="docsfn-version-item-label">{version.label}</span>
          {#if version.isDefault}
            <span class="docsfn-version-badge">Default</span>
          {/if}
          {#if isActive}
            <svg 
              width="16" 
              height="16" 
              viewBox="0 0 16 16" 
              fill="none"
              class="docsfn-version-check"
              aria-hidden="true"
            >
              <path 
                d="M13 4L6 11L3 8" 
                stroke="currentColor" 
                stroke-width="2" 
                stroke-linecap="round" 
                stroke-linejoin="round"
              />
            </svg>
          {/if}
        </DropdownMenuItem>
      {/each}
    </DropdownMenuContent>
  </DropdownMenu>
{/if}
