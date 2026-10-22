# KRN

KRN łączy repozytorium, task, checkpoint, dowód i dostarczenie wokół natywnej sesji Codex/Pi. **Host posiada model–tools loop, sesję i permissions**; Product KRN dostarcza procedurę operatora, CLI i nadzorowaną ścieżkę live. Zobacz [bieżącą orientację](CONTEXT.md), [graf architektury](docs/architecture.md) oraz procedurę [krn-delivery](.agents/skills/krn-delivery/SKILL.md), która opisuje scoped implementację i handoff — nie zastępuje hosta ani akceptacji.

## Product i przygotowanie

Uruchamiaj Product przez przypięty Node **24.22.1**, np. `node src/cli/main.ts`. Zainstalowane `krn` pozostaje bez zmian i nadal wskazuje na GLOBAL compatibility release z przypięcia `0606e4145a2fd1937a6108c76089f219a4617546`; to odrębne od Product entry. Przygotowanie repo używa pnpm **12.10.1**: `pnpm install --frozen-lockfile` (w tej pracy nie wykonywano instalacji). Nie jest to instrukcja instalowania hosta ani globalnego CLI.

`start` tworzy lub zapisuje job worktree; samo nie implementuje ani nie dostarcza zmiany. `checkpoint` zapisuje żądanie w mailboxie. Istniejąca, opt-in ścieżka live konsumuje checkpoint, wykonuje commit i wymagane checki:

```sh
KRN_LIVE=1 npm run live -- --repo /absolute/repo/path --job JOB_ID --issue ISSUE_ID [--revision UPDATED_AT]
```

Nie dodawaj `--submit`. Korzysta ona z natywnego hosta. W bieżącym statusie i odczycie tasków źródłem prawdy jest Paperclip; datowane [audity](docs/program/audit-2026-10-20.md) i [plan companion](docs/program/roadmap-2026-10-20.md) są historią/dowodami, nie trackerem. Obowiązuje [zaakceptowany plan produktu](https://github.com/krn-works/krn-codex-skills/blob/daff3b1ab4c35ae628cde850ec0ca74b19eb20f3/docs/research/product-architecture.md) i [roadmapa dostarczania](https://github.com/krn-works/krn-codex-skills/blob/daff3b1ab4c35ae628cde850ec0ca74b19eb20f3/docs/research/self-hardening-roadmap.md).

Przygotowanie poleceń i istniejące odczyty opisują `docs/program/delegate-command.md` oraz `node src/cli/main.ts report journey --repo /path/to/repository --job JOB_ID`. Nieznane komendy są forwardowane do legacy entry przez `KRN_LEGACY_ENTRY` z recursion guard. Przed scaleniem wymagane są `npm run gate`, niezależne oceny Standards i Spec dla dokładnego SHA oraz CI. Dopiero po odczycie scalenia i zielonym CI na `main` lead może odnotować akceptację kwalifikującej się dostawy w Paperclip zgodnie z ADR 0007; lokalny gate sam jej nie potwierdza.
