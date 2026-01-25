import { z } from "zod";
import { Tool } from "./base.js";

const CalculatorSchema = z.object({
  expression: z.string().describe("The mathematical expression to evaluate (e.g., '2 + 2 * 5')")
});

export const CalculatorTool = new Tool({
  name: "calculator",
  description: "Perform basic mathematical calculations.",
  schema: CalculatorSchema,
  execute: async (args) => {
    try {
      // Basic/Safe evaluation (placeholder)
      const safeExpression = args.expression.replace(/[^0-9+\-*/(). ]/g, "");
      // eslint-disable-next-line no-eval
      return String(eval(safeExpression));
    } catch (e: any) {
      return `Error: ${e.message}`;
    }
  }
});
