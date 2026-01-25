<script lang="ts">
  export interface BreadcrumbItem {
    label: string;
    href?: string;
  }

  export let items: BreadcrumbItem[];
  export let separator: any = undefined;
</script>

{#if items.length > 0}
  <nav class="docsfn-breadcrumbs" aria-label="Breadcrumb">
    <ol class="docsfn-breadcrumbs-list">
      {#each items as item, index (index)}
        {@const isLast = index === items.length - 1}
        
        <li class="docsfn-breadcrumb-item">
          {#if item.href && !isLast}
            <a href={item.href} class="docsfn-breadcrumb-link">
              {item.label}
            </a>
          {:else}
            <span 
              class="docsfn-breadcrumb-current"
              aria-current={isLast ? 'page' : undefined}
            >
              {item.label}
            </span>
          {/if}
          
          {#if !isLast}
            <span class="docsfn-breadcrumb-separator-wrapper">
              {#if separator}
                <svelte:component this={separator} />
              {:else}
                <svg 
                  width="16" 
                  height="16" 
                  viewBox="0 0 16 16" 
                  fill="none"
                  aria-hidden="true"
                  class="docsfn-breadcrumb-separator"
                >
                  <path 
                    d="M6 4L10 8L6 12" 
                    stroke="currentColor" 
                    stroke-width="1.5" 
                    stroke-linecap="round" 
                    stroke-linejoin="round"
                  />
                </svg>
              {/if}
            </span>
          {/if}
        </li>
      {/each}
    </ol>
  </nav>
{/if}
