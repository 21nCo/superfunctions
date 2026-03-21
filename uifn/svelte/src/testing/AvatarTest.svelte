<script lang="ts">
  import Avatar from '../Avatar.svelte';
  import AvatarImage from '../AvatarImage.svelte';
  import AvatarFallback from '../AvatarFallback.svelte';

  let { src = undefined, delayMs = undefined } = $props();
</script>

<Avatar>
  <AvatarImage {src} alt="Profile image" />
  <AvatarFallback {delayMs}>Fallback</AvatarFallback>
</Avatar>
