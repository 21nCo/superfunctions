<script lang="ts">
  import Dialog from '../Dialog.svelte';
  import DialogTrigger from '../DialogTrigger.svelte';
  import DialogContent from '../DialogContent.svelte';
  import DialogTitle from '../DialogTitle.svelte';
  import DialogClose from '../DialogClose.svelte';
  import DialogPortal from '../DialogPortal.svelte';
  import DialogOverlay from '../DialogOverlay.svelte';

  let { defaultOpen = false } = $props();
</script>

<Dialog {defaultOpen}>
  <DialogTrigger>Open Dialog</DialogTrigger>
  <DialogPortal>
    <DialogOverlay />
    <DialogContent>
      <DialogTitle>Dialog Title</DialogTitle>
      <DialogClose>Close</DialogClose>
    </DialogContent>
  </DialogPortal>
</Dialog>
