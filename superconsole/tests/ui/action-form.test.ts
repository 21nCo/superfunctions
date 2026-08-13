import { describe, expect, it } from 'vitest';
import {
  createActionDraft,
  editableActionFields,
  validateActionInput,
} from '../../src/lib/components/action-form';
import type { AdminActionViewModel } from '../../src/lib/components/view-models';

function action(): AdminActionViewModel {
  return {
    id: 'sendfn.messages.send',
    label: 'Send message',
    targetIdInput: 'messageId',
    input: { messageId: 'message-1', retries: 2, metadata: { source: 'console' } },
    inputSchema: {
      type: 'object',
      properties: {
        messageId: { type: 'string' },
        recipient: { type: 'string', title: 'Recipient' },
        retries: { type: 'integer', minimum: 0 },
        urgent: { type: 'boolean' },
        metadata: { type: 'object' },
        tags: { type: 'array' },
      },
      required: ['messageId', 'recipient', 'metadata'],
      additionalProperties: false,
    },
  };
}

describe('schema-driven action input', () => {
  it('hides the prebound resource identity and initializes editable values', () => {
    const candidate = action();
    expect(editableActionFields(candidate).map((field) => field.name)).toEqual([
      'recipient', 'retries', 'urgent', 'metadata', 'tags',
    ]);
    expect(createActionDraft(candidate)).toMatchObject({
      recipient: '',
      retries: '2',
      metadata: '{\n  "source": "console"\n}',
      tags: '',
    });
  });

  it('parses primitive and JSON fields into the exact dispatch input', () => {
    const candidate = action();
    const result = validateActionInput(candidate, {
      recipient: 'ops@example.test',
      retries: '3',
      urgent: true,
      metadata: '{"source":"operator"}',
      tags: '["production","urgent"]',
    });
    expect(result).toEqual({
      ok: true,
      errors: {},
      input: {
        messageId: 'message-1',
        recipient: 'ops@example.test',
        retries: 3,
        urgent: true,
        metadata: { source: 'operator' },
        tags: ['production', 'urgent'],
      },
    });
  });

  it('rejects missing required values and malformed JSON before dispatch', () => {
    const result = validateActionInput(action(), {
      recipient: '',
      retries: 'not-a-number',
      urgent: false,
      metadata: '{broken',
      tags: '{}',
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toMatchObject({
      recipient: 'Recipient is required.',
      retries: 'Retries must be a valid integer.',
      metadata: 'Metadata must contain valid JSON.',
      tags: 'Tags must be a JSON array.',
    });
    expect(result.input.messageId).toBe('message-1');
  });
});
