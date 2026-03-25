<script lang="ts">
  import ToastProvider from '../ToastProvider.svelte';
  import Toast from '../Toast.svelte';
  import ToastTitle from '../ToastTitle.svelte';
  import ToastViewport from '../ToastViewport.svelte';
</script>

<ToastProvider>
  {#each Array.from({ length: 25 }, (_, index) => index + 1) as item}
    <Toast defaultOpen duration={Infinity}>
      <ToastTitle>{`Toast ${item}`}</ToastTitle>
    </Toast>
  {/each}
  <ToastViewport />
</ToastProvider>
