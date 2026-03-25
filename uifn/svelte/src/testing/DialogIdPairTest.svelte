<script lang="ts">
  import Dialog from '../Dialog.svelte';
  import DialogTrigger from '../DialogTrigger.svelte';
  import DialogPortal from '../DialogPortal.svelte';
  import DialogOverlay from '../DialogOverlay.svelte';
  import DialogContent from '../DialogContent.svelte';
  import DialogTitle from '../DialogTitle.svelte';
</script>

<Dialog defaultOpen={true}>
  <DialogTrigger>Open Alpha Dialog</DialogTrigger>
  <DialogPortal>
    <DialogOverlay />
    <DialogContent>
      <DialogTitle>Alpha Dialog</DialogTitle>
    </DialogContent>
  </DialogPortal>
</Dialog>

<Dialog defaultOpen={true}>
  <DialogTrigger>Open Beta Dialog</DialogTrigger>
  <DialogPortal>
    <DialogOverlay />
    <DialogContent>
      <DialogTitle>Beta Dialog</DialogTitle>
    </DialogContent>
  </DialogPortal>
</Dialog>
