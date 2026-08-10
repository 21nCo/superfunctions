import { STYLED_COMPONENT_CATALOG } from '@uifn/components';
import type { ComponentSlug } from './component-inventory.js';
import type { WorkbenchRoute } from './routes.js';

export interface CatalogDemoPart {
  readonly id: string;
  readonly exportName: string;
  readonly many: boolean;
  readonly element: string;
  readonly voidElement: boolean;
  readonly parentId: string;
  readonly value?: string | number;
  readonly repeat: number;
}

export interface CatalogComponentDemo {
  readonly schemaVersion: 1;
  readonly fixtureVersion: string;
  readonly root: {
    readonly id: string;
    readonly exportName: string;
    readonly element: string;
    readonly voidElement: boolean;
  };
  readonly rootProps: Readonly<Record<string, unknown>>;
  readonly parts: readonly CatalogDemoPart[];
}

const demoBySlug = new Map(
  STYLED_COMPONENT_CATALOG.map((component) => [
    component.id,
    component.demo as CatalogComponentDemo,
  ]),
);

const catalogCropperImage = '/components/crop-landscape.svg';

const partText: Readonly<Record<string, string>> = Object.freeze({
  action: 'Confirm',
  cancel: 'Cancel',
  caption: 'Scan to open the uifn documentation',
  clear: 'Clear',
  close: 'Close',
  completed: 'Complete',
  content: 'Component content',
  decrement: 'Decrease',
  description: 'A production composition rendered from the public styled package.',
  empty: 'No matching options',
  error: 'Please check this value.',
  errorSummary: 'Please resolve the highlighted fields.',
  groupLabel: 'Options',
  increment: 'Increase',
  item: 'First option',
  itemDelete: 'Remove',
  itemName: 'roadmap.pdf',
  itemSize: '24 KB',
  itemText: 'First option',
  label: 'Example label',
  link: 'Open section',
  liveRegion: 'Item 1 of 3',
  next: 'Next',
  pause: 'Pause',
  previous: 'Previous',
  preview: 'Editable value',
  progress: 'Step 1 of 3',
  reset: 'Reset',
  skip: 'Skip tour',
  start: 'Start',
  status: 'Ready',
  submit: 'Save',
  title: 'Example title',
  trigger: 'Open example',
  undo: 'Undo',
  value: 'Current value',
  valueText: 'Current value',
});

type CatalogDemoCopy = string | readonly string[];

const componentPartText: Readonly<Record<string, Readonly<Record<string, CatalogDemoCopy>>>> = Object.freeze({
  accordion: Object.freeze({
    item: '',
    trigger: ['Account and security', 'Notifications', 'Billing and plans'],
    content: 'Manage sign-in methods, sessions, and workspace access.',
    indicator: '⌄',
  }),
  'alert-dialog': Object.freeze({
    trigger: 'Delete project',
    content: '',
    title: 'Delete this project?',
    description: 'This action cannot be undone. All project data will be permanently removed.',
    cancel: 'Cancel',
    action: 'Delete project',
    close: '×',
  }),
  'angle-slider': Object.freeze({
    valueText: '225°',
  }),
  autocomplete: Object.freeze({
    label: 'Assign teammate',
    clear: '×',
    content: '',
    item: ['Alex Morgan', 'Sam Rivera', 'Taylor Kim'],
    empty: 'No teammates found',
  }),
  badge: Object.freeze({
    root: 'Production',
  }),
  breadcrumb: Object.freeze({
    item: '',
    link: ['Workspace', 'Projects'],
    page: 'Settings',
    separator: '',
    ellipsis: '',
  }),
  button: Object.freeze({
    icon: '+',
    label: 'Save changes',
    spinner: '',
  }),
  card: Object.freeze({
    title: 'Deploy with confidence',
    description: 'Review release health, ownership, and recent changes in one place.',
    action: 'View status',
    content: 'All checks passed · 3 environments healthy',
    footer: 'Last deployed 8 minutes ago',
  }),
  carousel: Object.freeze({
    item: ['Project overview', 'Recent activity', 'Deployment status'],
    previous: 'Previous slide',
    next: 'Next slide',
    indicator: '',
    liveRegion: 'Slide 1 of 3',
  }),
  checkbox: Object.freeze({
    label: 'Email notifications',
    indicator: '✓',
  }),
  'checkbox-group': Object.freeze({
    label: 'Notification channels',
    item: ['Product updates', 'Security alerts', 'Weekly digest'],
    itemControl: '',
    itemIndicator: '✓',
  }),
  clipboard: Object.freeze({
    trigger: 'Copy invite link',
    status: 'Ready to copy',
  }),
  collapsible: Object.freeze({
    trigger: 'Advanced settings',
    content: 'Configure audit retention and environment-level permissions.',
  }),
  'color-picker': Object.freeze({
    content: '',
    label: 'Brand color',
    trigger: 'Choose color',
  }),
  combobox: Object.freeze({
    label: 'Assign teammate',
    trigger: '⌄',
    clear: '×',
    content: '',
    item: ['Alex Morgan', 'Sam Rivera', 'Taylor Kim'],
    itemIndicator: '✓',
    empty: 'No teammates found',
  }),
  command: Object.freeze({
    label: 'Command menu',
    input: '',
    list: '',
    empty: 'No commands found',
    loading: 'Loading commands…',
    group: '',
    groupHeading: ['Workspace', 'Navigation'],
    item: ['Search projects', 'Create project', 'Open settings', 'View activity', 'Invite teammate'],
    itemIndicator: '✓',
    separator: '',
    shortcut: ['⌘ K', '⌘ N', '⌘ ,', '⌘ A', '⌘ I'],
  }),
  'context-menu': Object.freeze({
    trigger: 'Right-click this project',
    content: '',
    item: ['Duplicate project', 'Rename project', 'Archive project'],
    itemIndicator: '',
    separator: '',
    group: '',
    groupLabel: 'Project actions',
    submenuTrigger: 'Move to',
    submenuContent: '',
  }),
  'date-input': Object.freeze({
    label: 'Start date',
    segment: ['07', '22', '2026'],
  }),
  'date-picker': Object.freeze({
    label: 'Due date',
    input: '',
    segment: ['07', '22', '2026'],
    trigger: 'Open calendar',
    content: '',
    previous: 'Previous month',
    next: 'Next month',
    gridLabel: 'July 2026',
    cell: '',
    cellTrigger: ['19', '20', '21', '22', '23', '24', '25'],
  }),
  dialog: Object.freeze({
    trigger: 'Edit profile',
    content: '',
    title: 'Edit profile',
    description: 'Update your display name and contact information.',
    close: '×',
  }),
  drawer: Object.freeze({
    trigger: 'Open filters',
    content: '',
    title: 'Filter activity',
    description: 'Narrow activity by member, type, and date.',
    close: '×',
  }),
  editable: Object.freeze({
    label: 'Display name',
    preview: 'Alex Morgan',
    input: '',
    control: '',
    submit: 'Save',
    cancel: 'Cancel',
  }),
  field: Object.freeze({
    label: 'Work email',
    control: '',
    description: 'We will only use this for account notifications.',
    requiredIndicator: '*',
  }),
  fieldset: Object.freeze({
    legend: 'Workspace notifications',
    content: 'Choose which updates your team should receive.',
    description: 'You can change these preferences at any time.',
  }),
  'file-upload': Object.freeze({
    label: 'Attachments',
    dropzone: 'Drop files here, or choose files',
    trigger: 'Choose files',
    itemGroup: '',
    item: '',
    itemName: ['roadmap.pdf', 'release-notes.txt'],
    itemSize: ['24 KB', '1 KB'],
    itemDelete: ['Remove roadmap.pdf', 'Remove release-notes.txt'],
    status: '2 files selected',
  }),
  'floating-panel': Object.freeze({
    trigger: 'Open inspector',
    content: '',
    title: 'Layout inspector',
    description: 'Review and resize the selected region.',
    close: 'Close',
  }),
  form: Object.freeze({
    actions: 'Save workspace',
  }),
  'hover-card': Object.freeze({
    trigger: '@alex',
    content: 'Alex Morgan · Frontend infrastructure · 42 shared projects',
  }),
  'image-cropper': Object.freeze({
    status: 'Ready to crop',
  }),
  'input-group': Object.freeze({
    addon: ['https://', ''],
    text: ['domain', ''],
    input: '',
    textarea: '',
    button: ['Copy', 'Clear'],
  }),
  listbox: Object.freeze({
    label: 'Workspace role',
    content: '',
    item: ['Member', 'Administrator', 'Viewer'],
    itemIndicator: '✓',
    group: '',
    groupLabel: '',
  }),
  menu: Object.freeze({
    trigger: 'Project actions',
    content: '',
    item: ['Duplicate project', 'Rename project', 'Archive project'],
    itemIndicator: '',
    separator: '',
    group: '',
    groupLabel: 'Actions',
    submenuTrigger: 'Move to',
    submenuContent: '',
  }),
  marquee: Object.freeze({
    item: ['Design review complete', 'Production deployed', 'New teammate joined'],
  }),
  menubar: Object.freeze({
    menu: '',
    trigger: ['File', 'Edit'],
    content: '',
    item: 'New project',
    submenuTrigger: 'Export',
    submenuContent: '',
  }),
  meter: Object.freeze({
    label: 'Storage used',
    valueText: '64%',
  }),
  'navigation-menu': Object.freeze({
    item: '',
    trigger: ['Products', 'Resources', 'Company'],
    content: '',
    link: ['Overview', 'Documentation', 'About'],
  }),
  'number-input': Object.freeze({
    label: 'Team seats',
    increment: 'Increase',
    decrement: 'Decrease',
    scrubber: 'Drag to adjust',
  }),
  pagination: Object.freeze({
    item: '',
    pageTrigger: ['1', '2', '3'],
    previous: 'Previous',
    next: 'Next',
    ellipsis: '…',
  }),
  'password-input': Object.freeze({
    label: 'Password',
    visibilityTrigger: 'Show password',
    strength: 'Strong password',
  }),
  'pin-input': Object.freeze({
    label: 'Verification code',
  }),
  popover: Object.freeze({
    anchor: '',
    trigger: 'Invite member',
    content: '',
    title: 'Invite a teammate',
    description: 'Send an invitation and choose their workspace role.',
    close: 'Close',
  }),
  progress: Object.freeze({
    label: 'Upload progress',
    valueText: '64%',
  }),
  'radio-group': Object.freeze({
    label: 'Plan',
    item: ['Starter', 'Professional', 'Enterprise'],
    itemControl: '',
    itemIndicator: '●',
  }),
  'rating-group': Object.freeze({
    label: 'Your rating',
    item: '',
    itemIndicator: ['★', '★', '★', '★', '★'],
    valueText: '4 out of 5',
  }),
  'segment-group': Object.freeze({
    label: 'View',
    item: ['List', 'Board', 'Timeline'],
    itemText: '',
  }),
  select: Object.freeze({
    label: 'Workspace role',
    trigger: '',
    clear: '×',
    content: '',
    item: '',
    itemText: ['Member', 'Administrator', 'Viewer'],
    itemIndicator: '✓',
    group: '',
    groupLabel: 'Available roles',
  }),
  'signature-pad': Object.freeze({
    label: 'Signature',
    clear: 'Clear',
    undo: 'Undo',
    status: 'Ready to sign',
  }),
  skeleton: Object.freeze({
    root: '',
  }),
  slider: Object.freeze({
    label: 'Volume',
    valueText: '64',
  }),
  splitter: Object.freeze({
    panel: ['Navigation', 'Editor'],
    resizeTrigger: 'Resize panels',
  }),
  steps: Object.freeze({
    item: '',
    trigger: ['Account', 'Profile', 'Review'],
    indicator: ['1', '2', '3'],
    separator: '',
    content: ['Create your account.', 'Complete your profile.', 'Review and submit.'],
    completed: 'Complete',
  }),
  switch: Object.freeze({
    label: 'Automatic updates',
  }),
  table: Object.freeze({
    caption: 'Recent deployments',
    row: '',
    head: ['Environment', 'Status', 'Owner'],
    cell: ['Production', 'Healthy', 'Platform', 'Preview', 'Ready', 'Web'],
  }),
  timer: Object.freeze({
    value: '05:00',
    start: 'Start',
    pause: 'Pause',
    reset: 'Reset',
    status: 'Ready',
  }),
  toast: Object.freeze({
    root: '',
    title: 'Changes published',
    description: 'Your updates are now live.',
    action: 'Undo',
    close: 'Close',
  }),
  toolbar: Object.freeze({
    button: 'Bold',
    link: 'Insert link',
    toggleGroup: 'Alignment',
    separator: '',
  }),
  tooltip: Object.freeze({
    trigger: 'Copy link',
    content: 'Copy project link',
  }),
  tour: Object.freeze({
    content: '',
    title: 'Invite your team',
    description: 'Add teammates and assign workspace roles.',
    previous: 'Previous',
    next: 'Next',
    skip: 'Skip tour',
    close: 'Close',
    progress: 'Step 1 of 3',
  }),
  'tree-view': Object.freeze({
    label: 'Project files',
    item: '',
    itemTrigger: ['›', '›'],
    itemText: ['Workspace', 'Projects'],
    branch: '',
    indicator: ['⌄', '⌄'],
  }),
  'tags-input': Object.freeze({
    label: 'Release tags',
    item: '',
    itemText: ['item-1', 'item-2'],
    itemDelete: ['Remove item-1', 'Remove item-2'],
    input: '',
    clear: 'Clear all tags',
    error: '',
  }),
  textarea: Object.freeze({
    root: '',
  }),
  'toggle-group': Object.freeze({
    item: ['Left', 'Center', 'Right'],
  }),
});

const componentRootText: Readonly<Record<string, string>> = Object.freeze({
  badge: 'Production',
  separator: '',
  toggle: 'Bold',
});

const curatedSelectionItems: Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>> =
  Object.freeze({
    autocomplete: Object.freeze([
      Object.freeze({ id: 'item-1', value: 'item-1', label: 'Alex Morgan', textValue: 'Alex Morgan' }),
      Object.freeze({ id: 'item-2', value: 'item-2', label: 'Sam Rivera', textValue: 'Sam Rivera' }),
      Object.freeze({ id: 'item-3', value: 'item-3', label: 'Taylor Kim', textValue: 'Taylor Kim', disabled: true }),
    ]),
    'checkbox-group': Object.freeze([
      Object.freeze({ id: 'item-1', value: 'item-1', label: 'Product updates', textValue: 'Product updates' }),
      Object.freeze({ id: 'item-2', value: 'item-2', label: 'Security alerts', textValue: 'Security alerts' }),
      Object.freeze({ id: 'item-3', value: 'item-3', label: 'Weekly digest', textValue: 'Weekly digest', disabled: true }),
    ]),
    'context-menu': Object.freeze([
      Object.freeze({ id: 'item-1', value: 'item-1', label: 'Duplicate project', textValue: 'Duplicate project' }),
      Object.freeze({ id: 'item-2', value: 'item-2', label: 'Rename project', textValue: 'Rename project' }),
      Object.freeze({ id: 'item-3', value: 'item-3', label: 'Archive project', textValue: 'Archive project', disabled: true }),
    ]),
    combobox: Object.freeze([
      Object.freeze({ id: 'item-1', value: 'item-1', label: 'Alex Morgan', textValue: 'Alex Morgan' }),
      Object.freeze({ id: 'item-2', value: 'item-2', label: 'Sam Rivera', textValue: 'Sam Rivera' }),
      Object.freeze({ id: 'item-3', value: 'item-3', label: 'Taylor Kim', textValue: 'Taylor Kim', disabled: true }),
    ]),
    command: Object.freeze([
      Object.freeze({ id: 'item-1', value: 'item-1', label: 'Search projects', textValue: 'Search projects', group: 'Workspace' }),
      Object.freeze({ id: 'item-2', value: 'item-2', label: 'Create project', textValue: 'Create project', group: 'Workspace' }),
      Object.freeze({ id: 'item-3', value: 'item-3', label: 'Open settings', textValue: 'Open settings', group: 'Navigation' }),
      Object.freeze({ id: 'item-4', value: 'item-4', label: 'View activity', textValue: 'View activity', group: 'Navigation' }),
      Object.freeze({ id: 'item-5', value: 'item-5', label: 'Invite teammate', textValue: 'Invite teammate', group: 'Workspace' }),
    ]),
    listbox: Object.freeze([
      Object.freeze({ id: 'item-1', value: 'item-1', label: 'Member', textValue: 'Member' }),
      Object.freeze({ id: 'item-2', value: 'item-2', label: 'Administrator', textValue: 'Administrator' }),
      Object.freeze({ id: 'item-3', value: 'item-3', label: 'Viewer', textValue: 'Viewer', disabled: true }),
    ]),
    menu: Object.freeze([
      Object.freeze({ id: 'item-1', value: 'item-1', label: 'Duplicate project', textValue: 'Duplicate project' }),
      Object.freeze({ id: 'item-2', value: 'item-2', label: 'Rename project', textValue: 'Rename project' }),
      Object.freeze({ id: 'item-3', value: 'item-3', label: 'Archive project', textValue: 'Archive project', disabled: true }),
    ]),
    'navigation-menu': Object.freeze([
      Object.freeze({ id: 'item-1', value: 'item-1', label: 'Products', textValue: 'Products' }),
      Object.freeze({ id: 'item-2', value: 'item-2', label: 'Resources', textValue: 'Resources' }),
      Object.freeze({ id: 'item-3', value: 'item-3', label: 'Company', textValue: 'Company', disabled: true }),
    ]),
    'radio-group': Object.freeze([
      Object.freeze({ id: 'item-1', value: 'item-1', label: 'Starter', textValue: 'Starter' }),
      Object.freeze({ id: 'item-2', value: 'item-2', label: 'Professional', textValue: 'Professional' }),
      Object.freeze({ id: 'item-3', value: 'item-3', label: 'Enterprise', textValue: 'Enterprise', disabled: true }),
    ]),
    'segment-group': Object.freeze([
      Object.freeze({ id: 'item-1', value: 'item-1', label: 'List', textValue: 'List' }),
      Object.freeze({ id: 'item-2', value: 'item-2', label: 'Board', textValue: 'Board' }),
      Object.freeze({ id: 'item-3', value: 'item-3', label: 'Timeline', textValue: 'Timeline', disabled: true }),
    ]),
    select: Object.freeze([
      Object.freeze({ id: 'item-1', value: 'item-1', label: 'Member', textValue: 'Member' }),
      Object.freeze({ id: 'item-2', value: 'item-2', label: 'Administrator', textValue: 'Administrator' }),
      Object.freeze({ id: 'item-3', value: 'item-3', label: 'Viewer', textValue: 'Viewer', disabled: true }),
    ]),
    'toggle-group': Object.freeze([
      Object.freeze({ id: 'item-1', value: 'item-1', label: 'Left', textValue: 'Left' }),
      Object.freeze({ id: 'item-2', value: 'item-2', label: 'Center', textValue: 'Center' }),
      Object.freeze({ id: 'item-3', value: 'item-3', label: 'Right', textValue: 'Right', disabled: true }),
    ]),
    toolbar: Object.freeze([
      Object.freeze({ id: 'item-1', value: 'item-1', label: 'Bold', textValue: 'Bold' }),
      Object.freeze({ id: 'item-2', value: 'item-2', label: 'Insert link', textValue: 'Insert link' }),
      Object.freeze({ id: 'item-3', value: 'item-3', label: 'Alignment', textValue: 'Alignment', disabled: true }),
    ]),
  });

const visualOnlyPartIds = new Set([
  'area',
  'areaThumb',
  'arrow',
  'backdrop',
  'channelSlider',
  'circle',
  'corner',
  'cropArea',
  'dragHandle',
  'handle',
  'image',
  'portal',
  'positioner',
  'range',
  'resizeHandle',
  'scrollbar',
  'spotlight',
  'swatch',
  'thumb',
  'track',
]);

const structuralPartIds = new Set([
  'actions',
  'control',
  'cropArea',
  'grid',
  'group',
  'header',
  'indicatorGroup',
  'list',
  'menu',
  'portal',
  'positioner',
  'row',
  'table',
  'tree',
  'viewport',
]);

export function catalogDemoShouldAddFallbackText(
  slug: ComponentSlug,
  part: CatalogDemoPart,
): boolean {
  if (Object.hasOwn(componentPartText[slug] ?? {}, part.id)) return false;
  if (
    part.voidElement
    || visualOnlyPartIds.has(part.id)
    || structuralPartIds.has(part.id)
  ) return false;
  if (slug === 'select' && part.id === 'valueText') return false;
  return true;
}

export function getCatalogComponentDemo(slug: ComponentSlug): CatalogComponentDemo {
  const demo = demoBySlug.get(slug);
  if (!demo) throw new TypeError(`Missing catalog component demo: ${slug}`);
  return demo;
}

export function catalogDemoChildren(
  demo: CatalogComponentDemo,
  parentId: string,
): readonly CatalogDemoPart[] {
  return demo.parts.filter((part) => part.parentId === parentId);
}

export function catalogDemoPartText(
  slug: ComponentSlug,
  part: CatalogDemoPart,
  instanceIndex = 0,
): string | undefined {
  const configured = componentPartText[slug]?.[part.id];
  if (configured !== undefined) {
    return typeof configured === 'string'
      ? configured
      : configured[instanceIndex] ?? configured.at(-1);
  }
  if (!catalogDemoShouldAddFallbackText(slug, part)) return undefined;
  if (part.id === 'fallback') return 'UI';
  if (part.id === 'indicator') return '✓';
  if (part.id === 'separator') return '·';
  if (part.id === 'cell' || part.id === 'cellTrigger') return '22';
  if (part.id === 'segment') return '2026';
  if (part.id === 'itemIndicator') return '✓';
  if (slug === 'hover-card' && part.id === 'content') {
    return 'Alex Morgan · Frontend infrastructure';
  }
  if (slug === 'menubar' && part.id === 'trigger') {
    return ['File', 'Edit'][instanceIndex] ?? `Menu ${instanceIndex + 1}`;
  }
  if (slug === 'pagination' && part.id === 'pageTrigger') {
    return String(instanceIndex + 1);
  }
  if (slug === 'scroll-area' && part.id === 'content') {
    return Array.from(
      { length: 18 },
      (_, index) => `Scrollable production content row ${index + 1}.`,
    ).join(' ');
  }
  if (slug === 'tabs' && part.id === 'trigger') {
    return ['Overview', 'Activity', 'Deployments'][instanceIndex] ?? `Tab ${instanceIndex + 1}`;
  }
  if (slug === 'tabs' && part.id === 'content') {
    return [
      'Project status and recent activity.',
      'Recent deployments and audit events.',
      'Production and preview environments.',
    ][instanceIndex] ?? `Panel ${instanceIndex + 1}`;
  }
  if (part.id === 'item' || part.id === 'itemText') {
    return ['First option', 'Second option', 'Unavailable option'][instanceIndex] ?? `Option ${instanceIndex + 1}`;
  }
  if (part.id === 'submenuTrigger') return 'More actions';
  if (part.id === 'submenuContent') return 'Nested action';
  if (part.id === 'content' && ['accordion', 'collapsible', 'tabs'].includes(slug)) {
    return 'Headless behavior and styled composition remain separate package layers.';
  }
  return partText[part.id] ?? `${part.id.replace(/([A-Z])/g, ' $1').toLowerCase()} example`;
}

export function catalogDemoRootText(slug: ComponentSlug): string | undefined {
  return componentRootText[slug];
}

export function catalogDemoPartInstances(part: CatalogDemoPart): readonly number[] {
  return Array.from({ length: Math.max(1, part.repeat) }, (_, index) => index);
}

export function catalogDemoPartProps(
  slug: ComponentSlug,
  part: CatalogDemoPart,
  instanceIndex = 0,
): Record<string, unknown> {
  const nativeProps: Record<string, unknown> = part.element === 'a'
    ? { href: '#preview' }
    : part.element === 'button'
      ? { type: 'button' }
      : {};
  if (
    part.id === 'input'
    && (slug === 'autocomplete' || slug === 'combobox')
  ) {
    return { ...nativeProps, placeholder: 'Search teammates…' };
  }
  if (slug === 'command' && part.id === 'loading') {
    return { ...nativeProps, hidden: true };
  }
  if (slug === 'input-group' && part.id === 'textarea') {
    return { ...nativeProps, hidden: true };
  }
  if (part.id === 'close') nativeProps['aria-label'] = 'Close';
  if (!part.many) return nativeProps;
  let value: string | number | undefined = part.value;
  if (typeof value === 'number') value += instanceIndex;
  else if (slug === 'menubar' && part.id === 'item') {
    value = `item-${instanceIndex + 1}-action`;
  } else if (slug === 'menubar' && (part.id === 'submenuTrigger' || part.id === 'submenuContent')) {
    value = `item-${instanceIndex + 1}-submenu`;
  } else if ((slug === 'date-input' || slug === 'date-picker') && part.id === 'segment') {
    value = ['month', 'day', 'year'][instanceIndex] ?? 'year';
  } else if (slug === 'date-picker' && (part.id === 'cell' || part.id === 'cellTrigger')) {
    value = `2026-07-${String(19 + instanceIndex).padStart(2, '0')}`;
  } else if (slug === 'image-cropper' && part.id === 'handle') {
    value = ['nw', 'ne', 'sw', 'se'][instanceIndex] ?? 'se';
  } else if (slug === 'pin-input' && part.id === 'input') {
    value = instanceIndex;
  } else if (slug === 'toolbar' && part.id === 'button') {
    value = 'item-1';
  } else if (slug === 'toolbar' && part.id === 'link') {
    value = 'item-2';
  } else if (value === 'item-1') {
    value = `item-${instanceIndex + 1}`;
  }
  return value === undefined ? nativeProps : { ...nativeProps, value };
}

export function catalogDemoRootPropsForRoute(
  slug: ComponentSlug,
  route: WorkbenchRoute,
): Record<string, unknown> {
  const demo = getCatalogComponentDemo(slug);
  const fixture = route.fixtureId ?? 'default';
  return {
    ...demo.rootProps,
    ...(curatedSelectionItems[slug] ? { items: curatedSelectionItems[slug] } : {}),
    ...(slug === 'angle-slider'
      ? {
          defaultValue: 225,
          min: 0,
          max: 360,
          step: 1,
          name: 'rotation',
        }
      : {}),
    ...(slug === 'color-picker'
      ? {
          defaultValue: '#635bff',
          alpha: true,
          name: 'brand-color',
          messages: {
            channels: {
              r: 'Red',
              g: 'Green',
              b: 'Blue',
              alpha: 'Alpha',
            },
          },
        }
      : {}),
    ...(slug === 'date-picker'
      ? {
          defaultValue: { year: 2026, month: 7, day: 22 },
          name: 'due-date',
        }
      : {}),
    ...(slug === 'image-cropper'
      ? {
          src: catalogCropperImage,
          defaultCrop: {
            x: 120,
            y: 75,
            width: 400,
            height: 250,
          },
          aspectRatio: 8 / 5,
          minSize: 80,
          maxSize: 520,
          defaultZoom: 1,
        }
      : {}),
    ...(slug === 'input'
      ? {
          type: 'email',
          name: 'email',
          placeholder: 'you@company.com',
          'aria-label': 'Work email',
        }
      : {}),
    ...(slug === 'input-group'
      ? {
          invalid: false,
        }
      : {}),
    ...(slug === 'command'
      ? {
          placeholder: 'Type a command or search…',
          defaultOpen: true,
        }
      : {}),
    ...(slug === 'pagination'
      ? {
          count: 36,
          pageSize: 12,
          defaultPage: 2,
        }
      : {}),
    ...(slug === 'card' ? { elevated: true } : {}),
    ...(slug === 'table' ? { striped: true } : {}),
    ...(slug === 'textarea'
      ? {
          name: 'message',
          placeholder: 'Add a note for your team…',
          rows: 4,
          'aria-label': 'Team note',
        }
      : {}),
    ...(slug === 'pin-input' ? { length: 6, otp: true } : {}),
    ...(slug === 'clipboard'
      ? {
          capability: {
            async writeText(value: string) {
              const clipboard = globalThis.navigator?.clipboard;
              try {
                if (clipboard?.writeText) await clipboard.writeText(value);
              } catch {
                // The catalog capability is deterministic even when the
                // preview browser denies the system clipboard permission.
              }
              (globalThis as typeof globalThis & { __uifnCatalogClipboard?: string })
                .__uifnCatalogClipboard = value;
            },
          },
          value: 'Copied from the uifn component catalog',
        }
      : {}),
    ...(slug === 'file-upload'
      ? {
          capability: {
            async pick() {
              return [
                {
                  name: 'roadmap.pdf',
                  size: 24_576,
                  type: 'application/pdf',
                  lastModified: 1_785_000_000_000,
                },
                {
                  name: 'release-notes.txt',
                  size: 1_024,
                  type: 'text/plain',
                  lastModified: 1_785_000_000_000,
                },
              ];
            },
          },
        }
      : {}),
    ...(fixture === 'open' ? { defaultOpen: true } : {}),
    ...(fixture === 'disabled' ? { disabled: true } : {}),
    ...(fixture === 'invalid' ? { invalid: true } : {}),
    ...(fixture === 'rtl' ? { dir: 'rtl' } : {}),
    'data-catalog-preview': 'true',
    'data-uifn-catalog-composition': 'complete',
  };
}

export function catalogDemoSnippetRootProps(
  slug: ComponentSlug,
): Readonly<Record<string, unknown>> {
  const props = catalogDemoRootPropsForRoute(slug, {
    id: `component-${slug}`,
    path: `/components/${slug}`,
    family: 'component',
    slug,
    title: slug,
  });
  const {
    capability: _capability,
    ['data-catalog-preview']: _catalogPreview,
    ['data-uifn-catalog-composition']: _catalogComposition,
    ...publicProps
  } = props;
  return publicProps;
}
