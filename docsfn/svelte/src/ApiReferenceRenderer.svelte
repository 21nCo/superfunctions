<script lang="ts">
  import type { ApiReference } from '@docsfn/core';
  import {
    Tabs,
    TabsList,
    TabsTrigger,
    TabsContent,
    ScrollArea,
    ScrollAreaViewport,
  } from '@uifn/svelte';

  export let api: ApiReference;

  $: spec = api.spec;
  $: paths = spec?.paths || {};
  $: pathKeys = Object.keys(paths);
  $: schemas = spec?.components?.schemas;

  let expandedMethods: Record<string, boolean> = {};

  function toggleMethod(key: string) {
    expandedMethods[key] = !expandedMethods[key];
  }
</script>

{#if !spec || !spec.info}
  <div class="docsfn-api-error">
    <p>Invalid API specification</p>
  </div>
{:else}
  <div class="docsfn-api-reference">
    <!-- API Info -->
    <div class="docsfn-api-header">
      <h1 class="docsfn-api-title">{spec.info.title || api.title}</h1>
      {#if spec.info.version}
        <span class="docsfn-api-version">v{spec.info.version}</span>
      {/if}
      {#if spec.info.description}
        <p class="docsfn-api-description">{spec.info.description}</p>
      {/if}
    </div>

    <!-- Endpoints -->
    {#if pathKeys.length > 0}
      <div class="docsfn-api-endpoints">
        <h2>Endpoints</h2>
        <ScrollArea class="docsfn-api-endpoints-scroll">
          <ScrollAreaViewport>
            {#each pathKeys as path (path)}
              <div class="docsfn-api-endpoint-group">
                <h3 class="docsfn-api-path">{path}</h3>
                {#each Object.entries(paths[path]).filter(([k]) => ['get', 'post', 'put', 'patch', 'delete'].includes(k.toLowerCase())) as [method, operation] (method)}
                  {@const methodKey = `${path}-${method}`}
                  {@const isExpanded = expandedMethods[methodKey]}
                  
                  <div class="docsfn-api-method method-{method.toLowerCase()}">
                    <button
                      class="docsfn-api-method-header"
                      on:click={() => toggleMethod(methodKey)}
                      data-expanded={isExpanded}
                    >
                      <span 
                        class="docsfn-api-method-badge"
                        data-method={method.toLowerCase()}
                      >
                        {method.toUpperCase()}
                      </span>
                      <span class="docsfn-api-method-summary">
                        {operation.summary || operation.operationId || 'No summary'}
                      </span>
                      <svg 
                        width="16" 
                        height="16" 
                        viewBox="0 0 16 16" 
                        class="docsfn-api-method-chevron"
                        aria-hidden="true"
                      >
                        <path 
                          d="M4 6L8 10L12 6" 
                          stroke="currentColor" 
                          stroke-width="2" 
                          stroke-linecap="round"
                        />
                      </svg>
                    </button>

                    {#if isExpanded}
                      <div class="docsfn-api-method-details">
                        {#if operation.description}
                          <p class="docsfn-api-method-description">{operation.description}</p>
                        {/if}

                        <Tabs defaultValue="parameters">
                          <TabsList>
                            {#if operation.parameters}
                              <TabsTrigger value="parameters">Parameters</TabsTrigger>
                            {/if}
                            {#if operation.requestBody}
                              <TabsTrigger value="request">Request</TabsTrigger>
                            {/if}
                            {#if operation.responses}
                              <TabsTrigger value="responses">Responses</TabsTrigger>
                            {/if}
                          </TabsList>

                          {#if operation.parameters}
                            <TabsContent value="parameters">
                              <table class="docsfn-api-params-table">
                                <thead>
                                  <tr>
                                    <th>Name</th>
                                    <th>In</th>
                                    <th>Type</th>
                                    <th>Required</th>
                                    <th>Description</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {#each operation.parameters as param}
                                    <tr>
                                      <td><code>{param.name}</code></td>
                                      <td>{param.in}</td>
                                      <td>{param.schema?.type || param.type}</td>
                                      <td>{param.required ? 'Yes' : 'No'}</td>
                                      <td>{param.description || '-'}</td>
                                    </tr>
                                  {/each}
                                </tbody>
                              </table>
                            </TabsContent>
                          {/if}

                          {#if operation.requestBody}
                            <TabsContent value="request">
                              <pre class="docsfn-api-code">{JSON.stringify(operation.requestBody, null, 2)}</pre>
                            </TabsContent>
                          {/if}

                          {#if operation.responses}
                            <TabsContent value="responses">
                              {#each Object.entries(operation.responses) as [code, response]}
                                <div class="docsfn-api-response">
                                  <span class="docsfn-api-response-code">{code}</span>
                                  <span class="docsfn-api-response-desc">{response.description}</span>
                                </div>
                              {/each}
                            </TabsContent>
                          {/if}
                        </Tabs>
                      </div>
                    {/if}
                  </div>
                {/each}
              </div>
            {/each}
          </ScrollAreaViewport>
        </ScrollArea>
      </div>
    {/if}

    <!-- Schemas -->
    {#if schemas}
      <div class="docsfn-api-schemas">
        <h2>Schemas</h2>
        <ScrollArea class="docsfn-api-schemas-scroll">
          <ScrollAreaViewport>
            {#each Object.entries(schemas) as [name, schema]}
              <div class="docsfn-api-schema">
                <h3>{name}</h3>
                {#if schema.description}
                  <p>{schema.description}</p>
                {/if}
                <pre class="docsfn-api-code">{JSON.stringify(schema, null, 2)}</pre>
              </div>
            {/each}
          </ScrollAreaViewport>
        </ScrollArea>
      </div>
    {/if}
  </div>
{/if}
