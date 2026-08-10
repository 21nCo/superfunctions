export type ComponentRecipeVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
export type ComponentRecipeSize = 'sm' | 'md' | 'lg';
export type ComponentRecipeDensity = 'compact' | 'comfortable' | 'spacious';
export type ComponentRecipeStyle = Record<string, string | number | undefined>;
export type ComponentRecipeClasses = Readonly<Record<string, string | undefined>>;
export type ComponentRecipeStyles = Readonly<Record<string, ComponentRecipeStyle | undefined>>;

export interface OpenComponentRecipeOptions {
  variant?: ComponentRecipeVariant;
  size?: ComponentRecipeSize;
  density?: ComponentRecipeDensity;
  unstyled?: boolean;
  className?: string;
  classes?: ComponentRecipeClasses;
  style?: ComponentRecipeStyle;
  styles?: ComponentRecipeStyles;
  vars?: Record<`--uifn-${string}`, string>;
  state?: string;
}

/** Framework-neutral recipe used by package wrappers and registry-installed source. */
export function openComponentPartRecipe(component: string, part: string, options: OpenComponentRecipeOptions = {}) {
  const publicClasses = options.unstyled
    ? []
    : [
        `uifn-${component}`,
        `uifn-${component}__${part}`,
        part === 'root' && options.variant ? `uifn-${component}--${options.variant}` : undefined,
        part === 'root' && options.size ? `uifn-${component}--${options.size}` : undefined,
        part === 'root' && options.density ? `uifn-${component}--density-${options.density}` : undefined,
      ];
  const className = [...publicClasses, options.classes?.[part], options.className].filter(Boolean).join(' ');
  const style = {
    ...(options.styles?.[part] ?? {}),
    ...(options.style ?? {}),
    ...(options.vars ?? {}),
  };
  return {
    className,
    style,
    vars: { ...(options.vars ?? {}) },
    data: {
      'data-uifn-component': component,
      'data-uifn-part': part,
      ...(options.state ? { 'data-state': options.state } : {}),
      ...(options.density ? { 'data-uifn-density': options.density } : {}),
      ...(options.variant ? { 'data-uifn-variant': options.variant } : {}),
      ...(options.size ? { 'data-uifn-size': options.size } : {}),
      ...(options.unstyled ? { 'data-uifn-unstyled': 'true' } : {}),
    },
    selector: `[data-uifn-component="${component}"][data-uifn-part="${part}"]`,
  } as const;
}
