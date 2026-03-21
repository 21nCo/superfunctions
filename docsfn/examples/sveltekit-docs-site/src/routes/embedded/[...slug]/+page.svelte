<script lang="ts">
  import type { PageData } from "./$types";

  export let data: PageData;
</script>

<article class="docsfn-embedded-page" data-docsfn-embedded-page="true">
  <h1>{data.page.title}</h1>
  {#if data.page.description}
    <p>{data.page.description}</p>
  {/if}
  {#if (data.page.headings ?? []).filter((heading) => heading.level > 1).length > 0}
    <section>
      <h2>On this page</h2>
      <ul class="docs-example-toc">
        {#each (data.page.headings ?? []).filter((heading) => heading.level > 1) as heading (heading.slug)}
          <li>
            <a href={`#${heading.slug}`}>{heading.text}</a>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
  <pre class="docs-example-content">{data.page.body}</pre>
</article>
