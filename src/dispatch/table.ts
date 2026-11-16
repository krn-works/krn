// The hook table: every Claude Code event KRN hooks, its routes, and the Codex events, in one place.
// `krn hook <event>` runs the routes of its event inside one process (dispatch.ts); scripts/render-hooks.ts
// writes .claude/settings.json hooks and .codex/hooks.json from this table, so no entry exists twice.

export interface HookModule {
  main: () => void | Promise<void>;
}

export interface Route {
  /** Names the route in the timing log. */
  name: string;
  /** Tool names the route serves, as a Claude Code matcher; absent serves every payload of the event. */
  tools?: string;
  /** A failed load or run refuses (exit 2) instead of letting the call through. */
  failClosed?: boolean;
  /** Loads the route's module on first use, so an event pays only for the routes that match it. */
  load: () => Promise<HookModule>;
}

export interface HookEvent {
  /** The event name Claude Code sends and settings.json keys. */
  claude: string;
  /** The `matcher` of the settings entry (SessionStart sources), when the event has one. */
  matcher?: string;
  timeout: number;
  routes: Route[];
}

const gauge = {
  name: 'gauge',
  load: () => import('../context/gauge.ts'),
} satisfies Route;
const stop = {
  name: 'stop',
  failClosed: true,
  load: () => import('../hook/stop.ts'),
} satisfies Route;

/** The events of `krn hook <event>`, keyed by the name on the command line. */
export const events = {
  'user-prompt': { claude: 'UserPromptSubmit', timeout: 5, routes: [gauge] },
  'session-start': {
    claude: 'SessionStart',
    matcher: 'startup|resume|clear|compact',
    timeout: 10,
    routes: [{ name: 'restart', load: () => import('../context/restart.ts') }],
  },
  'pre-tool': {
    claude: 'PreToolUse',
    timeout: 5,
    routes: [
      {
        name: 'memory-budget',
        tools: 'Write|Edit',
        failClosed: true,
        load: () => import('../../scripts/claude/memory-budget.ts'),
      },
      {
        name: 'bash-guards',
        tools: 'Bash',
        failClosed: true,
        load: () => import('../../scripts/claude/bash-guards.ts'),
      },
      {
        ...gauge,
        tools:
          'Agent|Task|WebFetch|WebSearch|NotebookEdit|Write|Edit|Bash|Read|Glob|Grep',
      },
      {
        name: 'subagent-model',
        tools: 'Agent|Task',
        load: () => import('../../scripts/claude/subagent-model.ts'),
      },
      {
        name: 'scope',
        tools: 'Write|Edit|NotebookEdit|Bash',
        failClosed: true,
        load: () => import('../hook/scope.ts'),
      },
      {
        name: 'edit-standards',
        tools: 'Edit|Write|MultiEdit|Bash',
        load: () => import('../hook/edit-route.ts'),
      },
    ],
  },
  'post-tool': { claude: 'PostToolUse', timeout: 10, routes: [gauge] },
  stop: { claude: 'Stop', timeout: 660, routes: [stop] },
  'subagent-stop': { claude: 'SubagentStop', timeout: 660, routes: [stop] },
} as const satisfies Record<string, HookEvent>;

export type EventName = keyof typeof events;

/** Names that older adoptions wrote into other repositories' settings: one route each, still served. */
export const legacyRoutes: Readonly<Record<string, Route>> = {
  session: { name: 'session', load: () => import('../hook/session-start.ts') },
  scope: {
    name: 'scope',
    failClosed: true,
    load: () => import('../hook/scope.ts'),
  },
  stash: {
    name: 'stash',
    failClosed: true,
    load: () => import('../hook/stash.ts'),
  },
  edit: { name: 'edit', load: () => import('../hook/edit-standards.ts') },
};

/** The Codex events and the one script that serves them. */
export const codexEvents = [
  {
    event: 'SessionStart',
    matcher: 'startup|resume|clear|compact|fork',
    timeout: 10,
    statusMessage: 'KRN: restoring state',
  },
  { event: 'UserPromptSubmit', timeout: 5 },
  { event: 'PostToolUse', matcher: '', timeout: 5 },
  { event: 'PreCompact', matcher: '', timeout: 10 },
] as const;

export const codexCommand =
  'node "$(git rev-parse --show-toplevel)/scripts/codex/context-hook.ts"';

/** True when `route` serves a payload whose tool is `tool`. */
export function serves(route: Route, tool: unknown): boolean {
  if (route.tools === undefined) return true;
  return (
    typeof tool === 'string' &&
    new RegExp(`^(?:${route.tools})$`, 'u').test(tool)
  );
}

/** The command a Claude Code settings entry runs for `event`. */
export function claudeCommand(event: EventName): string {
  return `NODE_COMPILE_CACHE="$CLAUDE_PROJECT_DIR/.krn/cache/node" node "$CLAUDE_PROJECT_DIR/src/dispatch/main.ts" ${event}`;
}
