<script lang="ts">
  import { createAvatar } from '@uifn/core/primitives/avatar';
  import { setContext } from 'svelte';

  interface Props {
    children?: import('svelte').Snippet;
    class?: string;
  }

  let { children, class: className, ...rest }: Props = $props();

  const machine = createAvatar();
  let state = $state(machine.state);

  $effect(() => {
    return machine.subscribe((newState) => {
      state = newState;
    });
  });

  setContext('avatar', {
    get status() { return state.status; },
    setLoading: machine.actions.setLoading,
    setLoaded: machine.actions.setLoaded,
    setError: machine.actions.setError
  });
</script>

<span
  class={className}
  data-state={state.status}
  {...rest}
>
  {@render children?.()}
</span>
