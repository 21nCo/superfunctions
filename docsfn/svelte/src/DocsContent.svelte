<script lang="ts">
  import { marked } from 'marked';
  
  export let content: string; // raw markdown
</script>

<div class="docsfn-content">
  {@html marked(content)}
</div>
