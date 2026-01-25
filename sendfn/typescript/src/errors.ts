export class SendfnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class EmailProviderError extends SendfnError {}
export class PushProviderError extends SendfnError {}
export class SuppressionError extends SendfnError {}
export class TemplateError extends SendfnError {}
export class DatabaseError extends SendfnError {}
export class ValidationError extends SendfnError {}
