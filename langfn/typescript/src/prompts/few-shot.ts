export interface FewShotExample {
  input: string;
  output: string;
}

export class FewShotPrompt {
  constructor(private readonly config: {
    prefix: string;
    examples: FewShotExample[];
    suffix: string;
    inputVariables: string[];
    exampleSeparator?: string;
  }) {}

  format(variables: Record<string, any>): string {
    const separator = this.config.exampleSeparator ?? "\n\n";
    const exampleStrs = this.config.examples.map(ex => 
      `Input: ${ex.input}\nOutput: ${ex.output}`
    );
    
    let res = `${this.config.prefix}${separator}${exampleStrs.join(separator)}${separator}${this.config.suffix}`;
    
    for (const [key, value] of Object.entries(variables)) {
      res = res.replace(new RegExp(`{${key}}`, "g"), String(value));
    }
    
    return res;
  }
}