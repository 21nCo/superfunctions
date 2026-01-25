<script lang="ts">
  import {
    DropdownMenu,
    DropdownMenuTrigger,
    DropdownMenuContent,
    DropdownMenuItem,
  } from '@uifn/svelte';

  export interface TopBarLink {
    label: string;
    href: string;
  }

  export interface TopBarDropdown {
    label: string;
    items: TopBarLink[];
  }

  export type TopBarItem = TopBarLink | TopBarDropdown;

  export let logo: any = undefined;
  export let items: TopBarItem[] = [];
  export let searchTrigger: any = undefined;
  export let versionSelector: any = undefined;
  export let mobileMenuTrigger: any = undefined;

  function isDropdown(item: TopBarItem): item is TopBarDropdown {
    return 'items' in item;
  }
</script>

<header class="docsfn-topbar">
  <div class="docsfn-topbar-container">
    <!-- Logo -->
    {#if logo}
      <div class="docsfn-topbar-logo">
        <svelte:component this={logo} />
      </div>
    {/if}

    <!-- Desktop Navigation -->
    <nav class="docsfn-topbar-nav" aria-label="Main navigation">
      {#each items as item, index (index)}
        {#if isDropdown(item)}
          <DropdownMenu>
            <DropdownMenuTrigger class="docsfn-topbar-dropdown-trigger">
              {item.label}
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
            <DropdownMenuContent class="docsfn-topbar-dropdown-content">
              {#each item.items as subItem, subIndex (subIndex)}
                <DropdownMenuItem>
                  <a href={subItem.href} class="docsfn-topbar-dropdown-item">
                    {subItem.label}
                  </a>
                </DropdownMenuItem>
              {/each}
            </DropdownMenuContent>
          </DropdownMenu>
        {:else}
          <a href={item.href} class="docsfn-topbar-link">
            {item.label}
          </a>
        {/if}
      {/each}
    </nav>

    <!-- Right side actions -->
    <div class="docsfn-topbar-actions">
      {#if searchTrigger}
        <svelte:component this={searchTrigger} />
      {/if}
      {#if versionSelector}
        <svelte:component this={versionSelector} />
      {/if}
      {#if mobileMenuTrigger}
        <svelte:component this={mobileMenuTrigger} />
      {/if}
    </div>
  </div>
</header>
