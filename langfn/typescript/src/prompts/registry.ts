import { Adapter, WhereClause } from "@superfunctions/db";
import { PromptTemplate } from "./template.js";

export interface PromptRecord {
  id: string;
  name: string;
  version: string;
  template: string;
  variables: string[];
  description?: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export class PromptRegistry {
  private tableName = "langfn_prompts";

  constructor(private readonly db: Adapter) {}

  async save(name: string, prompt: PromptTemplate, options: {
    version: string;
    description?: string;
    tags?: string[];
  }): Promise<void> {
    const record: PromptRecord = {
      id: `${name}:${options.version}`,
      name,
      version: options.version,
      template: (prompt as any).config.template,
      variables: (prompt as any).config.variables || [],
      description: options.description,
      tags: options.tags || [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await this.db.upsert({
      model: this.tableName,
      where: [{ field: "id", operator: "eq", value: record.id }],
      create: record,
      update: record
    });
  }

  async load(name: string, options: { version?: string } = {}): Promise<PromptTemplate | null> {
    const version = options.version || "latest";
    
    const where: WhereClause[] = options.version 
      ? [{ field: "id", operator: "eq", value: `${name}:${options.version}` }]
      : [{ field: "name", operator: "eq", value: name }];

    const record = await this.db.findOne<PromptRecord>({
      model: this.tableName,
      where
    });

    if (!record) return null;

    return new PromptTemplate({
      template: record.template,
      variables: record.variables
    });
  }

  async list(tags?: string[]): Promise<PromptRecord[]> {
    const where: WhereClause[] = [];
    // Note: The DB adapter doesn't support complex array contains operations
    // For now, we'll fetch all records and filter in memory if tags are provided
    const records = await this.db.findMany<PromptRecord>({
      model: this.tableName,
      where
    });

    if (!tags || tags.length === 0) return records;
    
    return records.filter(record => 
      tags.some(tag => record.tags.includes(tag))
    );
  }
}
