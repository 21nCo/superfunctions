import React, { useState } from 'react';
import type { ApiReference } from '@docsfn/core';
import { Tabs, TabsList, TabsTrigger, TabsContent, ScrollArea, ScrollAreaViewport } from '@uifn/react';

export interface ApiReferenceRendererProps {
  api: ApiReference;
  className?: string;
}

/**
 * Renders an OpenAPI/Swagger specification
 * Basic implementation - can be enhanced with swagger-ui or redoc integration
 */
export function ApiReferenceRenderer({ api, className }: ApiReferenceRendererProps) {
  const spec = api.spec;
  
  if (!spec || !spec.info) {
    return (
      <div className={`docsfn-api-error ${className || ''}`}>
        <p>Invalid API specification</p>
      </div>
    );
  }

  const paths = spec.paths || {};
  const pathKeys = Object.keys(paths);

  return (
    <div className={`docsfn-api-reference ${className || ''}`}>
      {/* API Info */}
      <div className="docsfn-api-header">
        <h1 className="docsfn-api-title">{spec.info.title || api.title}</h1>
        {spec.info.version && (
          <span className="docsfn-api-version">v{spec.info.version}</span>
        )}
        {spec.info.description && (
          <p className="docsfn-api-description">{spec.info.description}</p>
        )}
      </div>

      {/* Endpoints */}
      {pathKeys.length > 0 && (
        <div className="docsfn-api-endpoints">
          <h2>Endpoints</h2>
          <ScrollArea className="docsfn-api-endpoints-scroll">
            <ScrollAreaViewport>
              {pathKeys.map((path) => (
                <EndpointGroup key={path} path={path} methods={paths[path]} />
              ))}
            </ScrollAreaViewport>
          </ScrollArea>
        </div>
      )}

      {/* Schemas (if present) */}
      {spec.components?.schemas && (
        <div className="docsfn-api-schemas">
          <h2>Schemas</h2>
          <ScrollArea className="docsfn-api-schemas-scroll">
            <ScrollAreaViewport>
              {Object.entries(spec.components.schemas).map(([name, schema]) => (
                <SchemaItem key={name} name={name} schema={schema as any} />
              ))}
            </ScrollAreaViewport>
          </ScrollArea>
        </div>
      )}
    </div>
  );
}

interface EndpointGroupProps {
  path: string;
  methods: Record<string, any>;
}

function EndpointGroup({ path, methods }: EndpointGroupProps) {
  const methodKeys = Object.keys(methods).filter(k => 
    ['get', 'post', 'put', 'patch', 'delete'].includes(k.toLowerCase())
  );

  return (
    <div className="docsfn-api-endpoint-group">
      <h3 className="docsfn-api-path">{path}</h3>
      {methodKeys.map((method) => (
        <EndpointMethod 
          key={method} 
          method={method.toUpperCase()} 
          operation={methods[method]} 
        />
      ))}
    </div>
  );
}

interface EndpointMethodProps {
  method: string;
  operation: any;
}

function EndpointMethod({ method, operation }: EndpointMethodProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const methodColors: Record<string, string> = {
    GET: 'blue',
    POST: 'green',
    PUT: 'orange',
    PATCH: 'purple',
    DELETE: 'red'
  };

  return (
    <div className={`docsfn-api-method method-${method.toLowerCase()}`}>
      <button
        className="docsfn-api-method-header"
        onClick={() => setIsExpanded(!isExpanded)}
        data-expanded={isExpanded}
      >
        <span 
          className="docsfn-api-method-badge"
          data-method={method.toLowerCase()}
        >
          {method}
        </span>
        <span className="docsfn-api-method-summary">
          {operation.summary || operation.operationId || 'No summary'}
        </span>
        <svg 
          width="16" 
          height="16" 
          viewBox="0 0 16 16" 
          className="docsfn-api-method-chevron"
          aria-hidden="true"
        >
          <path 
            d="M4 6L8 10L12 6" 
            stroke="currentColor" 
            strokeWidth="2" 
            strokeLinecap="round"
          />
        </svg>
      </button>

      {isExpanded && (
        <div className="docsfn-api-method-details">
          {operation.description && (
            <p className="docsfn-api-method-description">{operation.description}</p>
          )}

          <Tabs defaultValue="parameters">
            <TabsList>
              {operation.parameters && <TabsTrigger value="parameters">Parameters</TabsTrigger>}
              {operation.requestBody && <TabsTrigger value="request">Request</TabsTrigger>}
              {operation.responses && <TabsTrigger value="responses">Responses</TabsTrigger>}
            </TabsList>

            {operation.parameters && (
              <TabsContent value="parameters">
                <ParametersTable parameters={operation.parameters} />
              </TabsContent>
            )}

            {operation.requestBody && (
              <TabsContent value="request">
                <pre className="docsfn-api-code">
                  {JSON.stringify(operation.requestBody, null, 2)}
                </pre>
              </TabsContent>
            )}

            {operation.responses && (
              <TabsContent value="responses">
                {Object.entries(operation.responses).map(([code, response]: [string, any]) => (
                  <div key={code} className="docsfn-api-response">
                    <span className="docsfn-api-response-code">{code}</span>
                    <span className="docsfn-api-response-desc">{response.description}</span>
                  </div>
                ))}
              </TabsContent>
            )}
          </Tabs>
        </div>
      )}
    </div>
  );
}

interface ParametersTableProps {
  parameters: any[];
}

function ParametersTable({ parameters }: ParametersTableProps) {
  return (
    <table className="docsfn-api-params-table">
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
        {parameters.map((param, i) => (
          <tr key={i}>
            <td><code>{param.name}</code></td>
            <td>{param.in}</td>
            <td>{param.schema?.type || param.type}</td>
            <td>{param.required ? 'Yes' : 'No'}</td>
            <td>{param.description || '-'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface SchemaItemProps {
  name: string;
  schema: any;
}

function SchemaItem({ name, schema }: SchemaItemProps) {
  return (
    <div className="docsfn-api-schema">
      <h3>{name}</h3>
      {schema.description && <p>{schema.description}</p>}
      <pre className="docsfn-api-code">
        {JSON.stringify(schema, null, 2)}
      </pre>
    </div>
  );
}
