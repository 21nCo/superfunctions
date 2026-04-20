<script lang="ts">
  import Dialog from '../Dialog.svelte';
  import DialogTrigger from '../DialogTrigger.svelte';
  import DialogPortal from '../DialogPortal.svelte';
  import DialogOverlay from '../DialogOverlay.svelte';
  import DialogContent from '../DialogContent.svelte';
  import DialogTitle from '../DialogTitle.svelte';

  let { open = false }: { open?: boolean } = $props();
</script>

<Dialog {open} onOpenChange={() => {}}>
  <DialogTrigger>Toggle Dialog</DialogTrigger>
  <DialogPortal>
    <DialogOverlay />
    <DialogContent>
      <DialogTitle>Controlled Dialog</DialogTitle>
    </DialogContent>
  </DialogPortal>
</Dialog>
