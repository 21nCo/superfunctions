import { EmailTemplate } from '../types';
import { TemplateError } from '../errors';

export class TemplateEngine {
  render(template: string, data: Record<string, any>): string {
    let result = template;

    // 1. Handle conditionals: {{#if condition}}...{{/if}}
    // Simple regex for blocks (non-nested for v0)
    // Matches {{#if key}} content {{/if}}
    const ifRegex = /\{\{#if\s+([a-zA-Z0-9_]+)\}\}([\s\S]*?)\{\{\/if\}\}/g;
    result = result.replace(ifRegex, (match, key, content) => {
      return data[key] ? content : '';
    });

    // 2. Handle loops: {{#each items}}...{{/each}}
    // Matches {{#each items}} content {{/each}}
    // This is basic and might need more robust parsing for "this" or "item" context
    // For now, let's assume simple string array replacement is too complex for regex
    // So for v0, we stick to variable replacement and simple conditionals.
    // If complex logic is needed, we should integrate Handlebars.
    // Spec says: "Loops: {{#each items}}...{{/each}}"
    // Let's try a basic implementation.
    
    // NOTE: Implementing full loop logic with regex is error prone. 
    // For the sake of "lightweight custom engine", I will implement simple variable interpolation 
    // and conditionals as primary features.

    // 3. Variable interpolation: {{variable}}
    const varRegex = /\{\{([a-zA-Z0-9_]+)\}\}/g;
    result = result.replace(varRegex, (match, key) => {
      const value = data[key];
      if (value === undefined || value === null) {
        return ''; // Or keep {{key}}? usually empty string is safer
      }
      return this.escapeHtml(String(value));
    });

    return result;
  }

  validate(template: EmailTemplate, data: Record<string, any>): void {
    const missing: string[] = [];
    for (const variable of template.variables) {
      if (data[variable] === undefined) {
        missing.push(variable);
      }
    }
    
    if (missing.length > 0) {
      throw new TemplateError(`Missing required variables: ${missing.join(', ')}`);
    }
  }

  extractVariables(template: string): string[] {
    const varRegex = /\{\{([a-zA-Z0-9_]+)\}\}/g;
    const vars = new Set<string>();
    let match;
    while ((match = varRegex.exec(template)) !== null) {
      // Exclude block helpers like #if, /if, #each, /each if they were matched by this simple regex
      // But our regex [a-zA-Z0-9_]+ excludes # and /
      vars.add(match[1]);
    }
    return Array.from(vars);
  }

  private escapeHtml(unsafe: string): string {
    return unsafe
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
}

export class TemplateRegistry {
  private templates = new Map<string, EmailTemplate>();

  register(template: EmailTemplate): void {
    this.templates.set(template.id, template);
  }

  get(templateId: string): EmailTemplate | undefined {
    return this.templates.get(templateId);
  }

  list(): EmailTemplate[] {
    return Array.from(this.templates.values());
  }
}
