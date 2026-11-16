// Host entry of the context gauge: ~/.claude/settings.json runs this path with --host in every
// project, so it must outlive any refactor of the hook routes (t-t4pf6d0).
import { main } from '../../src/context/gauge.ts';

if (import.meta.main) await main();
