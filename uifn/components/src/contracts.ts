import { STYLED_COMPONENT_CATALOG } from './generated/catalog';

export type StyledComponentState = 'open' | 'closed' | 'checked' | 'unchecked' | 'mixed' | 'selected' | 'highlighted' | 'invalid' | 'disabled' | 'read-only' | 'loading' | 'dragging' | 'swiping' | 'focus-visible';
export type StyledDensity = 'compact' | 'comfortable' | 'spacious';

export type StyledContractErrorCode = 'UIFN_STYLED_COMPONENT_UNKNOWN' | 'UIFN_STYLED_PART_UNKNOWN';

export class UIFnStyledContractError extends Error {
  readonly name = 'UIFnStyledContractError';
  constructor(readonly code: StyledContractErrorCode, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface StyledPartRecipeOptions {
  state?: StyledComponentState;
  density?: StyledDensity;
  className?: string;
  vars?: Record<`--uifn-${string}`, string>;
}

export function getStyledComponentContract(id: string) {
  const contract = STYLED_COMPONENT_CATALOG.find((entry) => entry.id === id);
  if (!contract) throw new UIFnStyledContractError('UIFN_STYLED_COMPONENT_UNKNOWN', `Unknown styled component: ${id}`, { id });
  return contract;
}

export function mergeStyledClassName(primitive: string, part: string, userClassName?: string): string {
  const contract = getStyledComponentContract(primitive);
  if (!contract.parts.some((entry) => entry.id === part)) {
    throw new UIFnStyledContractError('UIFN_STYLED_PART_UNKNOWN', `Unknown styled part: ${primitive}.${part}`, { primitive, part });
  }
  return [`uifn-${primitive}`, `uifn-${primitive}__${part}`, userClassName].filter(Boolean).join(' ');
}

export function createStyledPartRecipe(primitive: string, part: string, options: StyledPartRecipeOptions = {}) {
  const className = mergeStyledClassName(primitive, part, options.className);
  return {
    className,
    vars: { ...(options.vars ?? {}) },
    data: {
      'uifn-component': primitive,
      'uifn-part': part,
      ...(options.state ? { state: options.state } : {}),
      ...(options.density ? { density: options.density } : {}),
    },
    selector: `[data-uifn-component="${primitive}"][data-uifn-part="${part}"]`,
  } as const;
}
