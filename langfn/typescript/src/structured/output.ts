import { z } from "zod";

export class StructuredOutput<T extends z.ZodType> {
  constructor(private readonly schema: T) {}

  parse(text: string): z.infer<T> {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON object found in output");
    }

    try {
      const data = JSON.parse(jsonMatch[0]);
      return this.schema.parse(data);
    } catch (e: any) {
      throw new Error(`Failed to parse structured output: ${e.message}`);
    }
  }

  getSchema(): any {
    return this.schema;
  }
}
