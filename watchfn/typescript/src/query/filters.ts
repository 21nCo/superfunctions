export type FilterOperator =
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "nin"
  | "contains"
  | "startsWith"
  | "endsWith"
  | "exists";

export interface FilterCondition {
  field: string;
  operator: FilterOperator;
  value: any;
}

export interface CompositeFilter {
  operator: "and" | "or";
  conditions: (FilterCondition | CompositeFilter)[];
}

export type Filter = FilterCondition | CompositeFilter;

export class FilterEvaluator {
  /**
   * Evaluate a filter against a data object
   */
  static evaluate(data: Record<string, any>, filter: Filter): boolean {
    if ("field" in filter) {
      return this.evaluateCondition(data, filter);
    } else {
      return this.evaluateComposite(data, filter);
    }
  }

  private static evaluateCondition(
    data: Record<string, any>,
    condition: FilterCondition
  ): boolean {
    const fieldValue = this.getFieldValue(data, condition.field);

    switch (condition.operator) {
      case "eq":
        return fieldValue === condition.value;
      case "ne":
        return fieldValue !== condition.value;
      case "gt":
        return fieldValue > condition.value;
      case "gte":
        return fieldValue >= condition.value;
      case "lt":
        return fieldValue < condition.value;
      case "lte":
        return fieldValue <= condition.value;
      case "in":
        return (
          Array.isArray(condition.value) && condition.value.includes(fieldValue)
        );
      case "nin":
        return (
          Array.isArray(condition.value) &&
          !condition.value.includes(fieldValue)
        );
      case "contains":
        return (
          typeof fieldValue === "string" &&
          fieldValue.includes(String(condition.value))
        );
      case "startsWith":
        return (
          typeof fieldValue === "string" &&
          fieldValue.startsWith(String(condition.value))
        );
      case "endsWith":
        return (
          typeof fieldValue === "string" &&
          fieldValue.endsWith(String(condition.value))
        );
      case "exists":
        return condition.value
          ? fieldValue !== undefined
          : fieldValue === undefined;
      default:
        throw new Error(`Unknown filter operator: ${condition.operator}`);
    }
  }

  private static evaluateComposite(
    data: Record<string, any>,
    composite: CompositeFilter
  ): boolean {
    const results = composite.conditions.map((condition) =>
      this.evaluate(data, condition)
    );

    if (composite.operator === "and") {
      return results.every((r) => r);
    } else {
      return results.some((r) => r);
    }
  }

  private static getFieldValue(data: Record<string, any>, field: string): any {
    // Support nested field access with dot notation
    const parts = field.split(".");
    let value: any = data;

    for (const part of parts) {
      if (value === undefined || value === null) {
        return undefined;
      }
      value = value[part];
    }

    return value;
  }

  /**
   * Build filter from simple object notation
   */
  static fromObject(obj: Record<string, any>): CompositeFilter {
    const conditions: FilterCondition[] = [];

    for (const [field, value] of Object.entries(obj)) {
      if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
      ) {
        // Object with operators like { gt: 100, lt: 200 }
        for (const [op, val] of Object.entries(value)) {
          conditions.push({
            field,
            operator: op as FilterOperator,
            value: val,
          });
        }
      } else {
        // Simple equality
        conditions.push({
          field,
          operator: "eq",
          value,
        });
      }
    }

    return {
      operator: "and",
      conditions,
    };
  }

  /**
   * Optimize filter by removing redundant conditions
   */
  static optimize(filter: Filter): Filter {
    if ("field" in filter) {
      return filter;
    }

    // Remove duplicate conditions
    const optimized: CompositeFilter = {
      operator: filter.operator,
      conditions: [],
    };

    const seen = new Set<string>();
    for (const condition of filter.conditions) {
      const key = JSON.stringify(condition);
      if (!seen.has(key)) {
        seen.add(key);
        optimized.conditions.push(this.optimize(condition));
      }
    }

    // Flatten nested same-operator composites
    if (optimized.conditions.length === 1) {
      return optimized.conditions[0];
    }

    return optimized;
  }
}
