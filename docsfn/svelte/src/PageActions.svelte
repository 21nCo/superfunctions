<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
  import Copy from "@lucide/svelte/icons/copy";
  import Pencil from "@lucide/svelte/icons/pencil";
  import ThumbsDown from "@lucide/svelte/icons/thumbs-down";
  import ThumbsUp from "@lucide/svelte/icons/thumbs-up";

  export type PageFeedbackValue = "helpful" | "not-helpful";

  export let editLink: string | undefined = undefined;
  export let copyHref: string | undefined = undefined;
  export let showCopy = true;
  export let showFeedback = false;
  export let onFeedback: ((value: PageFeedbackValue) => void) | undefined = undefined;

  let copied = false;
  let feedback: PageFeedbackValue | undefined = undefined;
  let resetTimer: ReturnType<typeof setTimeout> | undefined = undefined;

  async function copyPageLink() {
    const href = copyHref ?? (typeof window !== "undefined" ? window.location.href : "");
    if (!href || typeof navigator === "undefined" || !navigator.clipboard) {
      return;
    }

    await navigator.clipboard.writeText(href);
    copied = true;
    if (resetTimer) {
      clearTimeout(resetTimer);
    }
    resetTimer = setTimeout(() => {
      copied = false;
    }, 1800);
  }

  function submitFeedback(value: PageFeedbackValue) {
    feedback = value;
    onFeedback?.(value);
  }
</script>

{#if showCopy || editLink || showFeedback}
  <div class="docsfn-page-actions" aria-label="Page actions">
    <div class="docsfn-page-actions-links">
      {#if showCopy}
        <button type="button" on:click={copyPageLink}>
          {#if copied}
            <Check size={15} strokeWidth={1.8} aria-hidden="true" />
            Copied
          {:else}
            <Copy size={15} strokeWidth={1.8} aria-hidden="true" />
            Copy link
          {/if}
        </button>
      {/if}
      {#if editLink}
        <a href={editLink} target="_blank" rel="noreferrer noopener">
          <Pencil size={15} strokeWidth={1.8} aria-hidden="true" />
          Edit page
        </a>
      {/if}
    </div>

    {#if showFeedback}
      <div class="docsfn-page-feedback">
        <span>{feedback ? "Thanks for the feedback" : "Was this helpful?"}</span>
        {#if !feedback}
          <button
            type="button"
            aria-label="This page was helpful"
            on:click={() => submitFeedback("helpful")}
          >
            <ThumbsUp size={15} strokeWidth={1.8} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="This page was not helpful"
            on:click={() => submitFeedback("not-helpful")}
          >
            <ThumbsDown size={15} strokeWidth={1.8} aria-hidden="true" />
          </button>
        {/if}
      </div>
    {/if}
  </div>
{/if}
