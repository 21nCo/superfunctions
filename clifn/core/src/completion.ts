/**
 * Shell completion scripts (CLI-15): bash from a hand-written spec.
 *
 * A `CompletionSpec` describes a program's subcommands and flags, and `renderCompletion` turns it into a script for
 * one shell. Nothing here writes files (D11): the caller prints the script and the lines from
 * `completionInstructions`.
 */

export type CompletionShell = "bash";

export interface CompletionOption {
  /** The long flag with its dashes, such as `--format`. */
  long?: string;
  /** The short flag with its dash, such as `-f`. */
  short?: string;
  description?: string;
  /** Whether the flag reads a value (`--format json`, `--format=json`). */
  takesValue: boolean;
  /** The values offered after the flag. */
  choices?: readonly string[];
  /**
   * The value may be left out (commander `[value]`, cac `[value]`): a following word that starts with `-` is
   * another flag, not the value. Defaults to `false`.
   */
  valueOptional?: boolean;
  /** Whether subcommands accept the flag too. Defaults to `true`; `false` offers it only at its own level. */
  inherited?: boolean;
}

export interface CompletionCommand {
  name: string;
  description?: string;
  aliases?: readonly string[];
  options: readonly CompletionOption[];
  /** Nested subcommands; up to three levels of commands are completed. */
  commands?: readonly CompletionCommand[];
}

export interface CompletionSpec {
  /** The program name the shell completes, such as `my-cli`. */
  name: string;
  commands: readonly CompletionCommand[];
  /** Flags of the program itself, offered at every level. */
  options: readonly CompletionOption[];
}

export type CompletionSkipKind = "command" | "alias" | "option" | "choice";
export type CompletionSkipReason = "invalid-name" | "duplicate" | "too-deep";

/**
 * A name left out of the script. A command left out takes its flags and subcommands with it, and each of its aliases
 * is reported too, with the command's reason (or `invalid-name` for an alias outside the grammar). A command whose own
 * name is outside the grammar stays in the script under its first usable alias.
 */
export interface CompletionSkip {
  kind: CompletionSkipKind;
  name: string;
  /** The command path it belongs to (the program itself is `[]`). */
  path: string[];
  reason: CompletionSkipReason;
}

export interface CompletionResult {
  script: string;
  skipped: CompletionSkip[];
}

export interface CompletionInstructionsOptions {
  /** The command that prints the script; defaults to `<name> completion <shell>`. */
  command?: string;
}

export type CompletionErrorCode = "CLIFN_COMPLETION_INVALID_SPEC" | "CLIFN_COMPLETION_UNSUPPORTED_SHELL";

export class CompletionError extends Error {
  readonly code: CompletionErrorCode;

  constructor(code: CompletionErrorCode, message: string) {
    super(message);
    this.name = "CompletionError";
    this.code = code;
  }
}

/** Closed name grammar for commands, aliases, flags (without their dashes) and choices. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/;
const LONG_FLAG_PATTERN = /^--[A-Za-z0-9][A-Za-z0-9:_-]*$/;
const SHORT_FLAG_PATTERN = /^-[A-Za-z0-9][A-Za-z0-9:_-]*$/;
/** Commands below this many levels are left out. */
const MAX_DEPTH = 3;
const MAX_DESCRIPTION_LENGTH = 80;
const SHELLS: readonly CompletionShell[] = ["bash"];

function isShell(value: unknown): value is CompletionShell {
  return typeof value === "string" && (SHELLS as readonly string[]).includes(value);
}

function assertShell(shell: unknown): asserts shell is CompletionShell {
  if (!isShell(shell)) {
    const shown = typeof shell === "string" ? JSON.stringify(shell) : `a value of type ${typeof shell}`;
    throw new CompletionError("CLIFN_COMPLETION_UNSUPPORTED_SHELL", `Unsupported shell ${shown}: expected bash`);
  }
}

function assertProgramName(name: unknown): asserts name is string {
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
    const shown = typeof name === "string" ? JSON.stringify(name) : `a value of type ${typeof name}`;
    throw new CompletionError("CLIFN_COMPLETION_INVALID_SPEC", `Invalid program name ${shown}: expected ${NAME_PATTERN.source}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Normalisation.

interface Flag {
  long?: string;
  short?: string;
  description: string;
  /** `none`: a switch; `value`: always reads the next word; `optional`: reads it unless it starts with `-`. */
  value: "none" | "value" | "optional";
  choices: string[];
  inherited: boolean;
}

interface Level {
  /** Canonical command names from the program down to this level. */
  path: string[];
  /** `path` joined with `/`, which no name can contain. */
  key: string;
  name: string;
  aliases: string[];
  description: string;
  /** Flags defined at this level. */
  ownFlags: Flag[];
  children: Level[];
}

function invalidSpec(where: string, expected: string): CompletionError {
  return new CompletionError("CLIFN_COMPLETION_INVALID_SPEC", `Invalid completion spec: ${where} is not ${expected}`);
}

function specField(target: unknown, key: string, where: string): unknown {
  if (typeof target !== "object" || target === null) {
    throw invalidSpec(where, "an object");
  }
  return (target as Record<string, unknown>)[key];
}

function specStrings(value: unknown, where: string): string[] {
  if (value === undefined) {
    return [];
  }
  const items = Array.isArray(value) ? Array.from(value as unknown[]) : undefined;
  if (items === undefined || items.some((item) => typeof item !== "string")) {
    throw invalidSpec(where, "an array of strings");
  }
  return items as string[];
}

function specOptionalBoolean(value: unknown, where: string, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw invalidSpec(where, "a boolean");
  }
  return value;
}

function specOptionalString(value: unknown, where: string): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value !== "string") {
    throw invalidSpec(where, "a string");
  }
  return value;
}

function specArray(value: unknown, where: string, optional = false): readonly unknown[] {
  if (optional && value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw invalidSpec(where, "an array");
  }
  // Holes are read as `undefined`, so a sparse slot fails like any other malformed entry.
  return Array.from(value as unknown[]);
}

/** First line, control characters as spaces, at most 80 characters. */
function normalizeDescription(text: string): string {
  const firstLine = text.split(/\r\n|[\n\r\u2028\u2029]/, 1)[0] ?? "";
  // eslint-disable-next-line no-control-regex
  const visible = firstLine.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
  const characters = Array.from(visible);
  return characters.length > MAX_DESCRIPTION_LENGTH
    ? characters.slice(0, MAX_DESCRIPTION_LENGTH).join("").trimEnd()
    : visible;
}

function normalizeFlags(options: unknown, where: string, path: string[], skipped: CompletionSkip[]): Flag[] {
  const own: Flag[] = [];
  const seen = new Set<string>();
  specArray(options, where).forEach((option, index) => {
    const at = `${where}[${index}]`;
    const long = specField(option, "long", at);
    const short = specField(option, "short", at);
    if (long !== undefined && typeof long !== "string") throw invalidSpec(`${at}.long`, "a string");
    if (short !== undefined && typeof short !== "string") throw invalidSpec(`${at}.short`, "a string");
    const description = normalizeDescription(specOptionalString(specField(option, "description", at), `${at}.description`));
    const takesValue = specField(option, "takesValue", at);
    if (typeof takesValue !== "boolean") throw invalidSpec(`${at}.takesValue`, "a boolean");
    const rawChoices = specStrings(specField(option, "choices", at), `${at}.choices`);
    const valueOptional = specOptionalBoolean(specField(option, "valueOptional", at), `${at}.valueOptional`, false);
    const inherited = specOptionalBoolean(specField(option, "inherited", at), `${at}.inherited`, true);

    const accept = (flag: string | undefined, pattern: RegExp): string | undefined => {
      if (flag === undefined) {
        return undefined;
      }
      if (!pattern.test(flag)) {
        skipped.push({ kind: "option", name: flag, path, reason: "invalid-name" });
        return undefined;
      }
      if (seen.has(flag)) {
        skipped.push({ kind: "option", name: flag, path, reason: "duplicate" });
        return undefined;
      }
      seen.add(flag);
      return flag;
    };
    const keptLong = accept(long, LONG_FLAG_PATTERN);
    const keptShort = accept(short, SHORT_FLAG_PATTERN);
    if (keptLong === undefined && keptShort === undefined) {
      if (long === undefined && short === undefined) {
        skipped.push({ kind: "option", name: "", path, reason: "invalid-name" });
      }
      return;
    }
    const choices: string[] = [];
    for (const choice of takesValue ? rawChoices : []) {
      if (!NAME_PATTERN.test(choice)) {
        skipped.push({ kind: "choice", name: choice, path, reason: "invalid-name" });
      } else if (!choices.includes(choice)) {
        choices.push(choice);
      }
    }
    own.push({
      ...(keptLong === undefined ? {} : { long: keptLong }),
      ...(keptShort === undefined ? {} : { short: keptShort }),
      description,
      value: !takesValue ? "none" : valueOptional ? "optional" : "value",
      choices,
      inherited,
    });
  });
  return own;
}

function normalizeCommands(
  commands: unknown,
  where: string,
  parent: Level,
  depth: number,
  skipped: CompletionSkip[],
): Level[] {
  const levels: Level[] = [];
  const words = new Set<string>();
  specArray(commands, where, true).forEach((command, index) => {
    const at = `${where}[${index}]`;
    const name = specField(command, "name", at);
    if (typeof name !== "string") throw invalidSpec(`${at}.name`, "a string");
    const rawAliases = specStrings(specField(command, "aliases", at), `${at}.aliases`);
    const validName = NAME_PATTERN.test(name);
    if (!validName) {
      skipped.push({ kind: "command", name, path: parent.path, reason: "invalid-name" });
    }
    const dropped: CompletionSkipReason | undefined =
      depth > MAX_DEPTH ? "too-deep" : validName && words.has(name) ? "duplicate" : undefined;
    if (dropped !== undefined) {
      // The subtree is not read, so a cyclic hand-written spec stops here too. Each alias goes with its command.
      if (validName) {
        skipped.push({ kind: "command", name, path: parent.path, reason: dropped });
      }
      for (const alias of rawAliases) {
        const reason = NAME_PATTERN.test(alias) ? dropped : "invalid-name";
        skipped.push({ kind: "alias", name: alias, path: [...parent.path, name], reason });
      }
      return;
    }
    // A command whose own name is outside the grammar is completed under its first usable alias.
    const word = validName ? name : rawAliases.find((alias) => NAME_PATTERN.test(alias) && !words.has(alias));
    const path = [...parent.path, word ?? name];
    const aliases: string[] = [];
    if (word !== undefined) {
      words.add(word);
    }
    // The alias that stands in for the command is used once; a repeat of it is a duplicate like any other.
    let standIn = validName ? undefined : word;
    for (const alias of rawAliases) {
      if (alias === standIn) {
        standIn = undefined;
      } else if (!NAME_PATTERN.test(alias)) {
        skipped.push({ kind: "alias", name: alias, path, reason: "invalid-name" });
      } else if (words.has(alias)) {
        skipped.push({ kind: "alias", name: alias, path, reason: "duplicate" });
      } else {
        words.add(alias);
        aliases.push(alias);
      }
    }
    if (word === undefined) {
      // No name of the command can be completed, so its flags and subcommands are not offered either.
      return;
    }
    const description = normalizeDescription(specOptionalString(specField(command, "description", at), `${at}.description`));
    const own = normalizeFlags(specField(command, "options", at), `${at}.options`, path, skipped);
    const level: Level = { path, key: path.join("/"), name: word, aliases, description, ownFlags: own, children: [] };
    level.children = normalizeCommands(specField(command, "commands", at), `${at}.commands`, level, depth + 1, skipped);
    levels.push(level);
  });
  return levels;
}

function normalizeSpec(spec: unknown): { root: Level; skipped: CompletionSkip[] } {
  const name = specField(spec, "name", "spec");
  assertProgramName(name);
  const skipped: CompletionSkip[] = [];
  const own = normalizeFlags(specField(spec, "options", "spec"), "spec.options", [], skipped);
  const root: Level = { path: [], key: "", name, aliases: [], description: "", ownFlags: own, children: [] };
  root.children = normalizeCommands(specField(spec, "commands", "spec"), "spec.commands", root, 1, skipped);
  return { root, skipped };
}

function allLevels(root: Level): Level[] {
  return [root, ...root.children.flatMap(allLevels)];
}

function flagNames(flag: Flag): string[] {
  return [flag.long, flag.short].filter((name): name is string => name !== undefined);
}

/** A shell-safe identifier for a name: letters and digits as they are, any other character as `_` plus its hex code. */
function identifier(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, (character) => `_${character.charCodeAt(0).toString(16)}`);
}

// ---------------------------------------------------------------------------------------------------------------
// bash renderer.

/** POSIX single quotes. */
function posixQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function casePatterns(patterns: string[]): string {
  return patterns.map(posixQuote).join("|");
}

/**
 * Each flag a level defines itself, split into those its subcommands inherit and those offered only at the level.
 * bash's `_flag` looks a name up at the path's own level and then among the inherited definitions from the path
 * upwards, so each flag name at a level follows one definition: the level's own, else the nearest ancestor's that
 * passes down.
 */
function ownFlagsBy(levels: Level[], inherited: boolean): { level: Level; flag: Flag }[] {
  return levels.flatMap((level) => level.ownFlags.filter((flag) => flag.inherited === inherited).map((flag) => ({ level, flag })));
}

/** `case` lines that set `kind` (and `choices`) for each flag, keyed `<path>|<flag>`. */
function bashFlagCases(entries: { level: Level; flag: Flag }[], indent: string): string[] {
  return entries.map(({ level, flag }) => {
    const kind = flag.value === "none" ? "flag" : flag.value;
    const choices = flag.choices.length > 0 ? `; choices=${posixQuote(flag.choices.join(" "))}` : "";
    return `${indent}${casePatterns(flagNames(flag).map((name) => `${level.key}|${name}`))}) kind=${kind}${choices} ;;`;
  });
}

/** `case` lines that set the bash variable `name` to the space-separated words of each level. */
function bashWordCases(levels: Level[], words: (level: Level) => string[], name: string, indent: string): string[] {
  return levels.flatMap((level) => {
    const list = words(level);
    return list.length === 0 ? [] : [`${indent}${posixQuote(level.key)}) ${name}=${posixQuote(list.join(" "))} ;;`];
  });
}

/** `body` between `open` and `close`, or nothing when `body` is empty. */
function wrapIfAny(body: string[], open: string, close: string): string[] {
  return body.length === 0 ? [] : [open, ...body, close];
}

/** Moves the bash variable `p` from a path to its parent path. */
function bashParentPath(indent: string): string[] {
  return [`${indent}case "$p" in`, `${indent}  */*) p="\${p%/*}" ;;`, `${indent}  *) p='' ;;`, `${indent}esac`];
}

function renderBash(root: Level): string {
  const fn = `_clifn_${identifier(root.name)}`;
  const levels = allLevels(root);
  const lines: string[] = [
    `# bash completion for ${root.name}, generated by @clifn/core. Works with bash 3.2 and later.`,
    ``,
    `# Sets kind (none, flag, value or optional) and choices for the flag $2 as the subcommand path $1 defines it, or`,
    `# else its nearest ancestor that passes the flag down.`,
    `${fn}_flag() {`,
    `  local p="$1"`,
    `  kind=none`,
    `  choices=''`,
    ...wrapIfAny(bashFlagCases(ownFlagsBy(levels, false), "    "), `  case "$p|$2" in`, `  esac`),
    `  while [ "$kind" = none ]; do`,
    `    case "$p|$2" in`,
    ...bashFlagCases(ownFlagsBy(levels, true), "      "),
    `    esac`,
    `    if [ -z "$p" ]; then`,
    `      return 0`,
    `    fi`,
    ...bashParentPath("    "),
    `  done`,
    `}`,
    ``,
    `${fn}() {`,
    `  local IFS=$' \\t\\n'`,
    `  local brk line known gap join word path opt eq kind choices cur rest words more p n i`,
    `  local -a w`,
    `  COMPREPLY=()`,
    `  # bash splits a word at ':' and '=' when COMP_WORDBREAKS holds them, and a run of them (as in 'a::b') is a part`,
    `  # of its own; join the parts of one word back up. A part made only of those characters, or one that follows such`,
    `  # a part, is joined when no blank comes before it on COMP_LINE (without COMP_LINE: always).`,
    `  brk=''`,
    `  case "$COMP_WORDBREAKS" in *:*) brk=':' ;; esac`,
    `  case "$COMP_WORDBREAKS" in *=*) brk="$brk=" ;; esac`,
    `  line="$COMP_LINE"`,
    `  known=0`,
    `  if [ -n "$line" ]; then`,
    `    known=1`,
    `  fi`,
    `  n=0`,
    `  i=0`,
    `  while [ "$i" -le "$COMP_CWORD" ]; do`,
    `    word="\${COMP_WORDS[i]}"`,
    `    gap=0`,
    `    if [ "$known" = 1 ]; then`,
    `      rest="\${line%%[![:blank:]]*}"`,
    `      line="\${line#"$rest"}"`,
    `      if [ -n "$rest" ]; then`,
    `        gap=1`,
    `      fi`,
    `      case "$line" in`,
    `        "$word"*) line="\${line#"$word"}" ;;`,
    `        *) known=0 ;;`,
    `      esac`,
    `    fi`,
    `    join=0`,
    `    if [ "$n" -ge 2 ] && [ "$gap" = 0 ] && [ -n "$brk" ]; then`,
    `      case "$word" in`,
    `        ''|*[!"$brk"]*) ;;`,
    `        *) join=1 ;;`,
    `      esac`,
    `      case "\${w[n-1]}" in`,
    `        *:) case "$brk" in *:*) join=1 ;; esac ;;`,
    `        *=) case "$brk" in *=*) join=1 ;; esac ;;`,
    `      esac`,
    `    fi`,
    `    if [ "$join" = 1 ]; then`,
    `      w[n-1]="\${w[n-1]}$word"`,
    `    else`,
    `      w[n]="$word"`,
    `      n=$((n + 1))`,
    `    fi`,
    `    i=$((i + 1))`,
    `  done`,
    `  cur="\${w[n-1]}"`,
    `  # COMP_WORDS keeps the quotes and backslashes the user typed. No name can hold them, so the words before the`,
    `  # cursor are compared with them removed; nothing is evaluated.`,
    `  i=1`,
    `  while [ "$i" -lt $((n - 1)) ]; do`,
    `    word=\${w[i]//\\'/}`,
    `    word=\${word//\\"/}`,
    `    w[i]=\${word//\\\\/}`,
    `    i=$((i + 1))`,
    `  done`,
    `  # Walk the words before the cursor: subcommands move the path, and a flag that reads a value skips it.`,
    `  path=''`,
    `  opt=''`,
    `  eq=''`,
    `  i=1`,
    `  while [ "$i" -lt $((n - 1)) ]; do`,
    `    word="\${w[i]}"`,
    `    case "$word" in`,
    `      --)`,
    `        return 0`,
    `        ;;`,
    `      -*)`,
    `        ${fn}_flag "$path" "$word"`,
    `        case "$kind" in`,
    `          value|optional)`,
    `            if [ $((i + 1)) -eq $((n - 1)) ]; then`,
    `              opt="$word"`,
    `            fi`,
    `            case "$kind|\${w[i+1]}" in`,
    `              'optional|-'*) ;;`,
    `              *) i=$((i + 1)) ;;`,
    `            esac`,
    `            ;;`,
    `        esac`,
    `        ;;`,
    `      *)`,
    `        case "$path|$word" in`,
  ];
  for (const level of levels) {
    for (const child of level.children) {
      lines.push(
        `          ${casePatterns([child.name, ...child.aliases].map((word) => `${level.key}|${word}`))}) path=${posixQuote(child.key)} ;;`,
      );
    }
  }
  lines.push(
    `        esac`,
    `        ;;`,
    `    esac`,
    `    i=$((i + 1))`,
    `  done`,
    `  if [ -n "$opt" ]; then`,
    `    ${fn}_flag "$path" "$opt"`,
    `    # A flag whose value may be left out is followed by another flag here.`,
    `    case "$kind|$cur" in`,
    `      'optional|-'*) opt='' ;;`,
    `    esac`,
    `  fi`,
    `  if [ -z "$opt" ]; then`,
    `    case "$cur" in`,
    `      -*=*)`,
    `        opt="\${cur%%=*}"`,
    `        eq="$opt="`,
    `        ${fn}_flag "$path" "$opt"`,
    `        ;;`,
    `    esac`,
    `  fi`,
    `  words=''`,
    `  if [ -n "$opt" ]; then`,
    `    # A flag's value: its choices, or bash's default completion when it has none.`,
    `    if [ "$kind" = none ] || [ "$kind" = flag ] || [ -z "$choices" ]; then`,
    `      return 0`,
    `    fi`,
    `    for word in $choices; do`,
    `      words="$words $eq$word"`,
    `    done`,
    `  else`,
    `    case "$cur" in`,
    `      -*)`,
    `        # The flags of this path, then those its ancestors pass down, nearest first.`,
    ...wrapIfAny(
      bashWordCases(levels, (level) => level.ownFlags.filter((flag) => !flag.inherited).flatMap(flagNames), "words", "          "),
      `        case "$path" in`,
      `        esac`,
    ),
    `        p="$path"`,
    `        while :; do`,
    `          case "$p" in`,
    ...bashWordCases(levels, (level) => level.ownFlags.filter((flag) => flag.inherited).flatMap(flagNames), "more", "            "),
    `            *) more='' ;;`,
    `          esac`,
    `          for word in $more; do`,
    `            case " $words " in`,
    `              *" $word "*) ;;`,
    `              *) words="$words $word" ;;`,
    `            esac`,
    `          done`,
    `          if [ -z "$p" ]; then`,
    `            break`,
    `          fi`,
    ...bashParentPath("          "),
    `        done`,
    `        ;;`,
    `      *)`,
    `        case "$path" in`,
    ...bashWordCases(levels, (level) => level.children.flatMap((child) => [child.name, ...child.aliases]), "words", "          "),
    `        esac`,
    `        ;;`,
    `    esac`,
    `  fi`,
    `  COMPREPLY=($(compgen -W "$words" -- "$cur"))`,
    `  # Readline replaces only the text after the last ':' or '=' it split at, so drop what comes before it.`,
    `  case "$brk" in`,
    `    ':=') rest="\${cur##*[=:]}" ;;`,
    `    ':') rest="\${cur##*:}" ;;`,
    `    '=') rest="\${cur##*=}" ;;`,
    `    *) rest="$cur" ;;`,
    `  esac`,
    `  if [ "$rest" != "$cur" ]; then`,
    `    word="\${cur%"$rest"}"`,
    `    i=0`,
    `    while [ "$i" -lt \${#COMPREPLY[@]} ]; do`,
    `      COMPREPLY[i]="\${COMPREPLY[i]#"$word"}"`,
    `      i=$((i + 1))`,
    `    done`,
    `  fi`,
    `  return 0`,
    `}`,
    ``,
    `complete -o default -F ${fn} ${root.name}`,
    ``,
  );
  return lines.join("\n");
}

/**
 * Renders the completion script for one shell. Names outside the grammar, duplicates and commands below the third
 * level are left out of the script and listed in `skipped`; a command whose name is outside the grammar is completed
 * under its first usable alias.
 */
export function renderCompletion(spec: CompletionSpec, shell: CompletionShell): CompletionResult {
  assertShell(shell);
  const { root, skipped } = normalizeSpec(spec);
  const script = renderBash(root);
  return { script, skipped };
}

/** The lines that tell a user where to put the script. Nothing is written. */
export function completionInstructions(
  name: string,
  shell: CompletionShell,
  options: CompletionInstructionsOptions = {},
): string[] {
  assertProgramName(name);
  assertShell(shell);
  const command = options.command ?? `${name} completion ${shell}`;
  switch (shell) {
    case "bash":
      return [
        `To load ${name} completions in every new bash shell (with bash-completion 2), save the script:`,
        `  mkdir -p ~/.local/share/bash-completion/completions`,
        `  ${command} > ~/.local/share/bash-completion/completions/${name}`,
        `Or source it from ~/.bashrc:`,
        `  eval "$(${command})"`,
      ];
  }
}
