# KRN: orientacja operatora

## Bieżący kierunek i status

**Paperclip jest właścicielem bieżącego statusu i tasków.** Ten plik jest orientacją, nie trackerem. Czytaj aktualny status bezpośrednio z Paperclip; wpisy w [datowanym audycie](docs/program/audit-2026-10-20.md) są historycznym readbackiem i zachowują ówczesne dowody oraz porażki.

Obowiązują zaakceptowane kanoniczne [plany produktu](https://github.com/krn-works/krn-codex-skills/blob/daff3b1ab4c35ae628cde850ec0ca74b19eb20f3/docs/research/product-architecture.md) i [roadmapa dostarczania](https://github.com/krn-works/krn-codex-skills/blob/daff3b1ab4c35ae628cde850ec0ca74b19eb20f3/docs/research/self-hardening-roadmap.md). Szersza propozycja P052 i jej crosswalk w [plan companion](docs/program/roadmap-2026-10-20.md) pozostają propozycją; nie tworzą same z siebie taska ani upoważnienia. Etykiety A0/A1/A2, B1/B2, M1–M5, R1/R2, Q1, T0/T1 są lokalnym nazewnictwem, a LON-ID i historyczne E1/E2 odrębnymi identyfikatorami.

## Operator i natywna procedura

Product entry to `node src/cli/main.ts` pod Node **24.21.0**. Product i GLOBAL mają odrębne dispatchery. Historyczny odczyt z [audytu 2026-10-20](docs/program/audit-2026-10-20.md) wskazywał zainstalowany GLOBAL compatibility release `0606e4145a2fd1937a6108c76089f219a4617546`; aktualny commit i stan instalacji odczytuj przez `krn doctor --json`. Zmiana źródła lub merge PR nie dowodzą aktualizacji hosta. Host zachowuje natywną sesję, model–tools loop i permissions. Procedura [krn-delivery](.agents/skills/krn-delivery/SKILL.md) wyznacza zakres implementacji i handoffu.

`start` tworzy lub rejestruje job worktree. `checkpoint` zapisuje żądanie checkpointu; sam nie wykonuje commitu. Istniejąca opt-in ścieżka `KRN_LIVE=1 npm run live -- --repo /absolute/repo/path --job JOB_ID --issue ISSUE_ID [--revision UPDATED_AT]` uruchamia nadzorowany przebieg, który konsumuje żądanie, commituje i sprawdza wynik. Nie używaj `--submit`. `start` ani checkpoint nie są dowodem akceptacji. Zachowaj przypięte pnpm **12.10.1**; przygotowanie repo opisuje `pnpm install --frozen-lockfile` (bez instalowania czegokolwiek w ramach tej orientacji).

Według ADR 0007 lead może zaakceptować kwalifikującą się implementację dostarczoną przez PR po wymaganym dowodzie. Decyzje o polityce, kwalifikacji i pamięci pozostają przy operatorze. Nie wnioskuj o ukończeniu A2 z samego discovery lub użycia ekranów: A2 nie jest tu ogłoszone jako ukończone.

## Granice dowodów i kwalifikacji

Zaobserwowane discovery wcześniejszego Matt-derived export (17 enabled, 0 errors) miało 0 model turns; operator odrzucił ten kierunek, a wycofanego project export nie należy reinstalować. To nie dowodzi użycia ani discovery obecnej własnej procedury. S5/backend/resource caps pozostają niekwalifikowane; W0 i FullR1 pozostają nieaktywne. Wcześniejsze readbacki `krn state check`, gate i statusów LON-309/LON-310 są opisane jako historyczne w [audicie](docs/program/audit-2026-10-20.md); nie przedstawiają obecnego stanu CI, PR ani acceptance.

Używaj istniejącego [charter](docs/program/charter.md), [rejestru propozycji](docs/program/proposals.md), [ExecPlan policy](docs/program/PLANS.md), [E1 history](docs/program/e1-plan.md) i audytów datowanych zgodnie z ich rolami. Rozróżniaj status Paperclip, kapsułę taska, trace evidence i zaakceptowane semantyczne rekordy Git.
