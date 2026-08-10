<script lang="ts">
  import * as UIFnSvelte from '@uifn/svelte';
  import { phase14PartProps } from './trace.mjs';

  interface Props {
    vector: any;
    rootProps: Record<string, unknown>;
    capture: (bridge: any) => void;
  }

  let { vector, rootProps, capture }: Props = $props();
  const Compound = $derived((UIFnSvelte as Record<string, any>)[vector.primitive]);
  const root = $derived(vector.anatomy[0]);
  const Root = $derived(Compound[root.component]);
  const parts = $derived(vector.anatomy.slice(1));
  const voidElements = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const elementName = (element: string) => element === 'heading' ? 'h2' : element;
</script>

{#snippet rootRender(payload: import('@uifn/svelte').SveltePrimitiveRenderPayload)}
  {@const rootAction = payload.action}
  {@const captured = capture(payload.bridge)}
  {#if voidElements.has(elementName(root.element))}
    <svelte:element
      this={elementName(root.element)}
      {...payload.props}
      use:rootAction={payload.actionParams}
    />
  {:else}
    <svelte:element
      this={elementName(root.element)}
      {...payload.props}
      use:rootAction={payload.actionParams}
    >
      {#if vector.primitive === 'DatePicker'}
        {@const byId = (id: string) => parts.find((part: any) => part.id === id)}
        {@const Label = Compound.Label}
        {@const Input = Compound.Input}
        {@const Segment = Compound.Segment}
        {@const Trigger = Compound.Trigger}
        {@const Positioner = Compound.Positioner}
        {@const Content = Compound.Content}
        {@const Header = Compound.Header}
        {@const Previous = Compound.Previous}
        {@const Next = Compound.Next}
        {@const Grid = Compound.Grid}
        {@const GridLabel = Compound.GridLabel}
        {@const Cell = Compound.Cell}
        {@const CellTrigger = Compound.CellTrigger}
        {@const HiddenInput = Compound.HiddenInput}
        <Label {...phase14PartProps(vector, byId('label'))}>DatePicker Label</Label>
        <Input {...phase14PartProps(vector, byId('input'))}>
          <Segment {...phase14PartProps(vector, byId('segment'))}>DatePicker Segment</Segment>
        </Input>
        <Trigger {...phase14PartProps(vector, byId('trigger'))}>DatePicker Trigger</Trigger>
        <Positioner {...phase14PartProps(vector, byId('positioner'))}>
          <Content {...phase14PartProps(vector, byId('content'))}>
            <Header {...phase14PartProps(vector, byId('header'))}>
              <Previous {...phase14PartProps(vector, byId('previous'))}>DatePicker Previous</Previous>
              <Next {...phase14PartProps(vector, byId('next'))}>DatePicker Next</Next>
            </Header>
            <Grid {...phase14PartProps(vector, byId('grid'))}>
              <GridLabel {...phase14PartProps(vector, byId('gridLabel'))}>DatePicker GridLabel</GridLabel>
              <tbody><tr><Cell {...phase14PartProps(vector, byId('cell'))}>
                <CellTrigger {...phase14PartProps(vector, byId('cellTrigger'))}>DatePicker CellTrigger</CellTrigger>
              </Cell></tr></tbody>
            </Grid>
          </Content>
        </Positioner>
        <HiddenInput {...phase14PartProps(vector, byId('hiddenInput'))} />
      {:else}
        {#each parts as part (`${part.id}:${part.value ?? 'one'}`)}
          {@const Part = Compound[part.component]}
          {@const props = phase14PartProps(vector, part)}
          {#if voidElements.has(elementName(part.element))}
            <Part {...props} />
          {:else}
            <Part {...props}>{vector.primitive} {part.component}</Part>
          {/if}
        {/each}
      {/if}
    </svelte:element>
  {/if}
{/snippet}

<Root {...rootProps} render={rootRender} />
