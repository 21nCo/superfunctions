export interface PromptVariables {
  [key: string]: string | number | boolean;
}

export class PromptTemplate {
  constructor(private readonly config: {
    template: string;
    variables?: string[];
  }) {}

  format(variables: PromptVariables): string {
    let result = this.config.template;
    for (const [key, value] of Object.entries(variables)) {
      result = result.replace(new RegExp(`{${key}}`, "g"), String(value));
    }
    return result;
  }
}

export interface ChatMessageTemplate {
  role: "system" | "user" | "assistant";
  content: string;
}

export class ChatPromptTemplate {
  constructor(private readonly config: {
    messages: ChatMessageTemplate[];
  }) {}

  format(variables: PromptVariables): any[] {
    return this.config.messages.map(msg => {
      let content = msg.content;
      for (const [key, value] of Object.entries(variables)) {
        content = content.replace(new RegExp(`{${key}}`, "g"), String(value));
      }
      return { role: msg.role, content };
    });
  }
}
