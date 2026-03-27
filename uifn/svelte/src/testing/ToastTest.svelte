<script lang="ts">
  import ToastProvider from '../ToastProvider.svelte';
  import Toast from '../Toast.svelte';
  import ToastTitle from '../ToastTitle.svelte';
  import ToastDescription from '../ToastDescription.svelte';
  import ToastClose from '../ToastClose.svelte';
  import ToastViewport from '../ToastViewport.svelte';

  let { defaultOpen = true, duration = 5000, includeViewport = true } = $props();
</script>

<ToastProvider>
  <Toast {defaultOpen} {duration}>
    <ToastTitle>Toast Title</ToastTitle>
    <ToastDescription>Toast Desc</ToastDescription>
    <ToastClose>Close</ToastClose>
  </Toast>
  {#if includeViewport}
    <ToastViewport />
  {/if}
</ToastProvider>
