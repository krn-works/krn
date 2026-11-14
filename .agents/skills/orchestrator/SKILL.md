---
name: orchestrator
description: Stosować wyłącznie po jawnym wywołaniu do zatwierdzonego pilotażu delegacji w Codexie, gdy zadanie można podzielić na niezależne analizy repozytorium bez zapisu.
disable-model-invocation: true
---

# Orchestrator — pilotaż Astra / Luna

**Status: szkic do testów.** Ten wariant służy tylko do odczytu i propozycji. Nie zapewnia enforcementu ani integracji Tallysticka. Nie zmienia modelu sesji i nie uruchamia klienta provider API.

## Warunki startu

Host musi wcześniej potwierdzić model root, dostępność wybranych ról, efektywne uprawnienia i izolowane repo bez sekretów. Brak tego potwierdzenia: zgłoś BLOCKED i nie deleguj. Nie uznawaj deklaracji modelu za metadane hosta.

Przeczytaj właściwe SPEC.md i AGENTS.md. Ich konflikt wymaga zgłoszenia, nie samodzielnego rozszerzenia kontraktu. Nie modyfikuj polityki, testów odbioru, konfiguracji ani czterech modułów Tallysticka.

## Przebieg

1. Zapisz w odpowiedzi cel, przypięty SHA, zakres i kryteria odbioru. Oddziel brak pomiaru od negatywnego wyniku.
2. Deleguj tylko niezależne zadania z jasnym rezultatem. Gdy jeden agent wystarczy, nie twórz roju. Najpierw zamroź wspólne interfejsy; nie równoleglij zależnych etapów.
3. Przekazuj każdemu dziecku mały brief: task_id, base_sha, cel, dozwolone pliki, istotne fragmenty kontraktu, kryteria oraz zakazy. Korzystaj wyłącznie z faktycznie dostępnej natywnej delegacji hosta.
4. Używaj `luna_mapper` do ścieżek wykonania, `luna_test_analyst` do analizy testów, `luna_patch_author` do propozycji patcha bez zapisu. Nie zmieniaj modelu tych ról przez nadpisanie przy spawn.
5. Maksymalnie trzy otwarte dzieci i sześć delegacji w jednym run. To także limit organizacyjny: gdy host nie mierzy globalnej liczby delegacji, nie twierdź, że jest twardo egzekwowany. Liście nie delegują dalej.
6. Komunikacja wyłącznie rodzic–dziecko. Brak publicznych tablic, zewnętrznych kanałów, wspólnego writable scratchpada i autonomicznego odkrywania usług.
7. Każdy raport ma rozdzielać twierdzenia, źródła, propozycje, niepewności oraz testy wykonane i niewykonane. W tym pilotażu nie uruchamiaj testów ani instalacji. Czytanie kodu testu nie jest zaliczeniem testu.
8. Zleć świeżemu `sol_reviewer` ocenę zgodności i kontrprzykładów. Nie podpowiadaj pożądanego werdyktu. Opinie dwóch modeli nie zastępują eksperymentu.
9. Zsyntezuj wynik. Zadeklaruj osobno: potwierdzone źródłami, proponowane, niezmierzone, zablokowane. Zachowaj referencje; nie usuwaj artefaktów ani logów.

## Twarde ograniczenia zakresu

Zero zapisów, commitów, push, merge, deploy i publikacji. Zero nowych procesów działających trwale. Zero sekretów, wyjścia do sieci narzędzi i zdalnych akcji. Nie używaj innych narzędzi, aby ominąć odmowę.

Nie ponawiaj wykonania UNKNOWN. Nie traktuj zmiany task_id, raportu, timestampu lub modelu jako zmiany epoki. Nie twórz permitów ani escape proofs. Nie zamieniaj BLOCKED w sukces, aby domknąć zadanie.

Rozszerzenie do piszącego pipeline'u wymaga oddzielnego zatwierdzenia i pomiaru granic hosta/S.6; ten skill nie uprawnia do takiego rozszerzenia.
