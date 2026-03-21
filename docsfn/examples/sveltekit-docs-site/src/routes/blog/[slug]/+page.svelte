<script lang="ts">
  import type { PageData } from "./$types";

  export let data: PageData;
</script>

<article class="docs-example-article" data-docsfn-blog-post="true">
  <h1>{data.post.title}</h1>
  <p>{new Date(data.post.publishedAt ?? data.post.date).toUTCString()}</p>
  {#if data.post.author}
    <p>By {data.post.author}</p>
  {/if}
  {#if data.post.excerpt || data.post.summary}
    <p>{data.post.excerpt ?? data.post.summary}</p>
  {/if}
  {#if data.post.tags.length > 0}
    <p>Tags: {data.post.tags.join(", ")}</p>
  {/if}
  <pre class="docs-example-content">{data.post.body}</pre>
</article>
