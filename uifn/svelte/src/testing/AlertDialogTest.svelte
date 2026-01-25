<script lang="ts">
  import AlertDialog from '../AlertDialog.svelte';
  import AlertDialogTrigger from '../AlertDialogTrigger.svelte';
  import AlertDialogContent from '../AlertDialogContent.svelte';
  import AlertDialogTitle from '../AlertDialogTitle.svelte';
  import AlertDialogDescription from '../AlertDialogDescription.svelte';
  import AlertDialogAction from '../AlertDialogAction.svelte';
  import AlertDialogCancel from '../AlertDialogCancel.svelte';
  import AlertDialogPortal from '../AlertDialogPortal.svelte';
  import AlertDialogOverlay from '../AlertDialogOverlay.svelte';

  let { defaultOpen = false } = $props();
</script>

<AlertDialog {defaultOpen}>
  <AlertDialogTrigger>Open Alert</AlertDialogTrigger>
  <AlertDialogPortal>
    <AlertDialogOverlay />
    <AlertDialogContent>
      <AlertDialogTitle>Alert Title</AlertDialogTitle>
      <AlertDialogDescription>Alert Desc</AlertDialogDescription>
      <AlertDialogCancel>Cancel</AlertDialogCancel>
      <AlertDialogAction>Action</AlertDialogAction>
    </AlertDialogContent>
  </AlertDialogPortal>
</AlertDialog>
