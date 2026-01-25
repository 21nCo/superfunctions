import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export interface ToolContext {
  metadata: Record<string, any>;
}

export interface ToolConfig<T extends z.ZodType> {
  name: string;
  description: string;
  schema: T;
  execute: (args: z.infer<T>, context: ToolContext) => Promise<any>;
}

export class Tool<T extends z.ZodType, R = any> {
  readonly name: string;
  readonly description: string;
  readonly schema: T;
  private readonly _execute: (args: z.infer<T>, context: ToolContext) => Promise<R>;

  constructor(config: ToolConfig<T>) {
    this.name = config.name;
    this.description = config.description;
    this.schema = config.schema;
    this._execute = config.execute;
  }

  json_schema(): any {
    return {
      name: this.name,
      description: this.description,
      parameters: zodToJsonSchema(this.schema)
    };
  }

  async run(args: any, context?: ToolContext): Promise<R> {
    const parsed = this.schema.parse(args);
    return this._execute(parsed, context || { metadata: {} });
  }
}
