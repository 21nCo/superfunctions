<script lang="ts">
  import Slider from '../Slider.svelte';
  import SliderTrack from '../SliderTrack.svelte';
  import SliderRange from '../SliderRange.svelte';
  import SliderThumb from '../SliderThumb.svelte';

  let { defaultValue = [50] } = $props();
</script>

<Slider {defaultValue} min={0} max={100} step={1}>
  <SliderTrack>
    <SliderRange />
  </SliderTrack>
  {#each defaultValue as _, index (index)}
    <SliderThumb {index} />
  {/each}
</Slider>
