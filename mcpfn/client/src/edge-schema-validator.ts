import type {
  JsonSchemaType,
  JsonSchemaValidator,
  jsonSchemaValidator,
} from "@modelcontextprotocol/sdk/validation";
import {
  CfWorkerJsonSchemaValidator,
  type CfWorkerSchemaDraft,
} from "@modelcontextprotocol/sdk/validation/cfworker";

/** Draft for an output schema that declares no `$schema`: MCP's default
 * dialect, JSON Schema 2020-12. */
const DEFAULT_DRAFT: CfWorkerSchemaDraft = "2020-12";

/** Meta-schema URIs `@cfworker/json-schema` supports, normalized to https
 * without the empty fragment. */
const declaredDrafts = new Map<string, CfWorkerSchemaDraft>([
  ["https://json-schema.org/draft-04/schema", "4"],
  ["https://json-schema.org/draft-07/schema", "7"],
  ["https://json-schema.org/draft/2019-09/schema", "2019-09"],
  ["https://json-schema.org/draft/2020-12/schema", "2020-12"],
]);

/** The cfworker draft for a schema's declared `$schema`, the 2020-12 default
 * when it declares none, or `undefined` for a dialect cfworker cannot apply. */
export function edgeSchemaDraft(schema: JsonSchemaType): CfWorkerSchemaDraft | undefined {
  const declared = (schema as { $schema?: unknown }).$schema;
  if (declared === undefined) return DEFAULT_DRAFT;
  if (typeof declared !== "string") return undefined;
  const normalized = declared.replace(/^http:\/\//, "https://").replace(/#$/, "");
  return declaredDrafts.get(normalized);
}

/** Tool output schema validator for Cloudflare Workers and other hosts that
 * forbid runtime code generation. It validates each schema with the
 * `@cfworker/json-schema` draft its `$schema` declares (draft-04, draft-07,
 * 2019-09 or 2020-12, over http or https, with or without the empty fragment)
 * and with 2020-12 when it declares none. A schema that declares any other
 * dialect is reported as unsupported: every result checked against it fails
 * with that reason, so it is never validated under a different dialect. */
export class EdgeJsonSchemaValidator implements jsonSchemaValidator {
  private readonly validators = new Map<CfWorkerSchemaDraft, CfWorkerJsonSchemaValidator>();

  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
    const draft = edgeSchemaDraft(schema);
    if (draft === undefined) {
      const errorMessage = `unsupported JSON Schema dialect ${JSON.stringify(
        (schema as { $schema?: unknown }).$schema,
      )}; the edge validator supports draft-04, draft-07, 2019-09 and 2020-12`;
      return () => ({ valid: false, data: undefined, errorMessage });
    }
    let validator = this.validators.get(draft);
    if (!validator) {
      validator = new CfWorkerJsonSchemaValidator({ draft });
      this.validators.set(draft, validator);
    }
    return validator.getValidator<T>(schema);
  }
}
