# KRN

KRN łączy repozytorium, aktualny task, checkpoint, dowód i dostarczenie wokół natywnej sesji Codex/Pi. Host zachowuje model–tools loop, sesję i permissions. Product CLI działa przez Node; zainstalowane polecenie `krn` nadal wskazuje na GLOBAL compatibility release. Bieżące orientation i Paperclip readback znajdziesz w [CONTEXT](CONTEXT.md), aktualny graf w [architecture index](docs/architecture.md), a datowany status/dowody i propozycję uzupełnienia kanonicznych planów w [audit companion](docs/program/audit-2026-10-20.md) oraz [plan companion](docs/program/roadmap-2026-10-20.md). Kanoniczne Product plan i delivery roadmap pozostają w przypiętym [GLOBAL product plan](https://github.com/krn-works/krn-codex-skills/blob/0606e4145a2fd1937a6108c76089f219a4617546/docs/research/product-architecture.md) i [GLOBAL delivery roadmap](https://github.com/krn-works/krn-codex-skills/blob/0606e4145a2fd1937a6108c76089f219a4617546/docs/research/self-hardening-roadmap.md); update do nich jest propozycją, nie przyjętą zmianą.

## Lokalne środowisko

Używaj Node.js **24.21.0** i pnpm **12.10.1** zgodnie z przypiętym toolchainem. Dokumentowane przygotowanie środowiska: `pnpm install --frozen-lockfile` (nie wykonano w tej pracy). Nie oznacza host install ani konfiguracji globalnego CLI.

## Odczyty

Raport podróży dla znanego joba: `node src/cli/main.ts report journey --repo /path/to/repository --job JOB_ID`. Dla bounded read-only delegate invocation sprawdź dokładne flagi i input constraints w [delegate-command.md](docs/program/delegate-command.md); przykład używa jawnych tracked inputs i nowego `.krn/tmp` result directory.

Product CLI obsługuje także `start`, `checkpoint`, `stop`, `note`, `review` i `delegate`. Nieznane komendy są forwardowane przez `KRN_LEGACY_ENTRY` (domyślnie `~/.codex/krn/current/scripts/krn.mjs`) z recursion guard. Live execution jest opt-in. Przed integracją obowiązuje `npm run gate`, wymagane exact-head reviews, CI i Paperclip acceptance; lokalny gate nie zastępuje state/acceptance proof.
