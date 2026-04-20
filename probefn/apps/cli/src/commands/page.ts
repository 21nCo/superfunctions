import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  createSuccessEnvelope,
  createProbefnError,
  toErrorEnvelope,
  type JsonObject,
  type JsonValue,
  type ProbefnEnvelope,
} from '@probefn/contracts';
import {
  actOnPage,
  createCheckpointFromSession,
  findPageElement,
  openPage,
} from '@probefn/mcp-server';

import type { CliCommandContext, CliCommandResult } from '../index.js';

interface LayoutElement {
  elementId: string;
  role: string;
  name: string;
  text: string;
  visible: boolean;
}

interface CheckpointManifestRecord {
  checkpointId: string;
  createdAt: string;
  artifacts: Array<{
    kind: string;
    path: string;
  }>;
}

export async function runPageCommand(
  args: string[],
  context: CliCommandContext,
): Promise<CliCommandResult> {
  switch (args[0]) {
    case 'open':
      return handleOpen(args.slice(1), context);
    case 'find':
      return handleFind(args.slice(1), context);
    case 'act':
      return handleAct(args.slice(1), context);
    default:
      throw createProbefnError({
        code: 'E_CONFIG_INVALID',
        message: `Unknown page subcommand ${args[0] ?? '<none>'}.`,
        retryable: false,
      });
  }
}

async function handleOpen(
  args: string[],
  context: CliCommandContext,
): Promise<CliCommandResult> {
  const sessionId = requireFlag(args, '--session', 'Missing required --session flag.');
  const url = requireFlag(args, '--url', 'Missing required --url flag.');
  const envelope = await openPage(context.runtime, {
    sessionId,
    url,
  });
  const data = expectSuccess(envelope).data as {
    resolvedUrl: string;
  };
  return {
    envelope,
    human: data.resolvedUrl,
  };
}

async function handleFind(
  args: string[],
  context: CliCommandContext,
): Promise<CliCommandResult> {
  const sessionId = requireFlag(args, '--session', 'Missing required --session flag.');
  const query = requireFlag(args, '--query', 'Missing required --query flag.');

  const envelope = await findFromCheckpoint(context, sessionId, query)
    .catch(async (error) => {
      const candidate = toErrorEnvelope(error);
      if (!candidate.ok && candidate.error.code === 'E_SESSION_NOT_FOUND') {
        throw error;
      }

      return findPageElement(context.runtime, {
        sessionId,
        query,
      });
    });

  const data = expectSuccess(envelope).data as {
    elements: Array<{ elementId: string }>;
  };
  return {
    envelope,
    human: data.elements.map((element) => element.elementId).join(', '),
  };
}

async function handleAct(
  args: string[],
  context: CliCommandContext,
): Promise<CliCommandResult> {
  const sessionId = requireFlag(args, '--session', 'Missing required --session flag.');
  const action = requireFlag(args, '--action', 'Missing required --action flag.') as
    | 'click'
    | 'fill'
    | 'select'
    | 'hover'
    | 'press';
  const query = getFlagValue(args, '--query');
  const selector = getFlagValue(args, '--selector');
  const checkpointAfter = getOptionalFlagValue(args, '--checkpoint-after');

  if (!query && !selector) {
    throw createProbefnError({
      code: 'E_CONFIG_INVALID',
      message: 'Missing required --query or --selector flag.',
      retryable: false,
    });
  }

  const envelope = await actOnPage(context.runtime, {
    sessionId,
    action,
    ...(query ? { query } : {}),
    ...(selector ? { selector } : {}),
    ...(getFlagValue(args, '--value') ? { value: getFlagValue(args, '--value')! } : {}),
    ...(getFlagValue(args, '--key') ? { key: getFlagValue(args, '--key')! } : {}),
    ...(hasFlag(args, '--no-dom-confirmation') ? { requireDomConfirmation: false } : {}),
  });

  const success = expectSuccess(envelope);
  const actionData = {
    ...(success.data as JsonObject),
  };

  if (checkpointAfter) {
    const checkpointEnvelope = await createCheckpointFromSession(context.runtime, {
      sessionId,
      name: checkpointAfter,
    });
    const checkpointData = expectSuccess(checkpointEnvelope).data as {
      checkpointId: string;
    };
    actionData.checkpointId = checkpointData.checkpointId;
  }

  const finalEnvelope = createSuccessEnvelope(actionData, success.warnings);
  return {
    envelope: finalEnvelope,
    human: String(actionData.targetElementId ?? actionData.action),
  };
}

async function findFromCheckpoint(
  context: CliCommandContext,
  sessionId: string,
  query: string,
): Promise<ProbefnEnvelope<JsonValue>> {
  const { session } = await context.runtime.resolveSessionContext(sessionId);
  const checkpoint = await loadLatestCheckpoint(context.repoRoot, session.artifactRoot);
  if (!checkpoint) {
    throw createProbefnError({
      code: 'E_ACTION_TARGET_NOT_FOUND',
      message: 'No interactable element matched the provided query.',
      retryable: false,
      details: {
        query,
      },
    });
  }

  const layoutArtifact = checkpoint.artifacts.find((artifact) => artifact.kind === 'layout');
  if (!layoutArtifact) {
    throw createProbefnError({
      code: 'E_STORAGE_WRITE_FAILED',
      message: `Checkpoint ${checkpoint.checkpointId} is missing a layout artifact.`,
      retryable: false,
    });
  }

  const layout = JSON.parse(
    await readFile(path.resolve(context.repoRoot, layoutArtifact.path), 'utf8'),
  ) as {
    elements: LayoutElement[];
  };

  const candidates = scoreElements(layout.elements, query);
  const highestScore = candidates[0]?.score ?? 0;
  if (highestScore <= 0) {
    throw createProbefnError({
      code: 'E_ACTION_TARGET_NOT_FOUND',
      message: 'No interactable element matched the provided query.',
      retryable: false,
      details: {
        query,
      },
    });
  }

  const topCandidates = candidates.filter((candidate) => candidate.score === highestScore);
  if (topCandidates.length > 1) {
    throw createProbefnError({
      code: 'E_ACTION_AMBIGUOUS',
      message: 'Multiple interactable elements matched the provided query.',
      retryable: true,
      details: {
        query,
        candidateCount: topCandidates.length,
      },
    });
  }

  const element = topCandidates[0]!.element;
  return createSuccessEnvelope({
    elements: [
      {
        elementId: element.elementId,
        role: element.role,
        name: element.name,
      },
    ],
  });
}

function scoreElements(
  elements: LayoutElement[],
  query: string,
): Array<{ element: LayoutElement; score: number }> {
  const roleAliases: Record<string, string> = {
    button: 'button',
    link: 'link',
    textbox: 'textbox',
    input: 'textbox',
    field: 'textbox',
    select: 'combobox',
    dropdown: 'combobox',
    checkbox: 'checkbox',
    radio: 'radio',
  };
  const words = normalize(query).split(/\s+/).filter(Boolean);
  const roleHint = words.find((word) => roleAliases[word]) ?? null;
  const searchWords = words.filter((word) => !roleAliases[word]);
  const compactQuery = searchWords.join(' ');

  return elements
    .filter((element) => element.visible)
    .map((element) => {
      const haystack = normalize(`${element.name} ${element.text}`);
      let score = 0;

      if (roleHint && element.role === roleAliases[roleHint]) {
        score += 4;
      }

      if (compactQuery.length > 0 && normalize(element.name) === compactQuery) {
        score += 5;
      }

      for (const word of searchWords) {
        if (haystack.includes(word)) {
          score += 2;
        }
      }

      if (searchWords.length > 0 && searchWords.every((word) => haystack.includes(word))) {
        score += 3;
      }

      if (!roleHint && searchWords.length === 0) {
        score += 1;
      }

      return {
        element,
        score,
      };
    })
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.element.name.length - right.element.name.length;
    });
}

async function loadLatestCheckpoint(
  repoRoot: string,
  artifactRoot: string,
): Promise<CheckpointManifestRecord | null> {
  const checkpointsRoot = path.resolve(repoRoot, artifactRoot, 'checkpoints');

  let entries;
  try {
    entries = await readdir(checkpointsRoot, {
      withFileTypes: true,
    });
  } catch {
    return null;
  }

  const manifests = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const manifestPath = path.resolve(checkpointsRoot, entry.name, 'checkpoint.json');
        return JSON.parse(await readFile(manifestPath, 'utf8')) as CheckpointManifestRecord;
      }),
  );

  manifests.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return manifests[0] ?? null;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function expectSuccess(envelope: ProbefnEnvelope<JsonValue>) {
  if (!envelope.ok) {
    throw createProbefnError({
      code: envelope.error.code as never,
      message: envelope.error.message,
      retryable: envelope.error.retryable,
      ...(envelope.error.details ? { details: envelope.error.details } : {}),
    });
  }

  return envelope;
}

function getFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) {
    return undefined;
  }

  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    return undefined;
  }

  return value;
}

function getOptionalFlagValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index < 0) {
    return null;
  }

  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    return 'after-action';
  }

  return value;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function requireFlag(args: string[], flag: string, message: string): string {
  const value = getFlagValue(args, flag);
  if (!value) {
    throw createProbefnError({
      code: 'E_CONFIG_INVALID',
      message,
      retryable: false,
    });
  }

  return value;
}
