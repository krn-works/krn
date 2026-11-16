// Renders the hook entries of .claude/settings.json and the whole of .codex/hooks.json from the hook table.
import { claudeCommand, codexCommand, codexEvents, events } from './table.ts';

/** The `hooks` object of .claude/settings.json: one command entry per event. */
export function claudeHooks(): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(events).map(([name, event]) => [
      event.claude,
      [
        {
          ...('matcher' in event ? { matcher: event.matcher } : {}),
          hooks: [
            {
              type: 'command',
              command: claudeCommand(name as keyof typeof events),
              timeout: event.timeout,
            },
          ],
        },
      ],
    ]),
  );
}

/** The content of .codex/hooks.json. */
export function codexHooks(): { hooks: Record<string, unknown> } {
  return {
    hooks: Object.fromEntries(
      codexEvents.map((event) => [
        event.event,
        [
          {
            ...('matcher' in event ? { matcher: event.matcher } : {}),
            hooks: [
              {
                type: 'command',
                command: codexCommand,
                timeout: event.timeout,
                ...('statusMessage' in event
                  ? { statusMessage: event.statusMessage }
                  : {}),
              },
            ],
          },
        ],
      ]),
    ),
  };
}

/** settings.json text with its hooks replaced by the table's; every other key stays. */
export function renderSettings(current: string): string {
  const settings = JSON.parse(current) as Record<string, unknown>;
  return `${JSON.stringify({ ...settings, hooks: claudeHooks() }, null, 2)}\n`;
}

export function renderCodex(): string {
  return `${JSON.stringify(codexHooks(), null, 2)}\n`;
}
