# Rekurencja Antyspam

Lekka, lokalna ochrona antyspamowa dla komentarzy WordPress i formularzy Contact Form 7. Wtyczka ocenia wyłącznie ruch przychodzący — nie przechwytuje ani nie blokuje `wp_mail()`.

## Najważniejsze właściwości

- scoring 0–100 dla aktywnego HTML/BBCode, linków, skracaczy, punycode, podejrzanego szumu i konfigurowalnych list;
- zachowanie wcześniejszej decyzji antyspamowej CF7;
- podpisany czas wypełnienia, honeypot, opcjonalny limit zweryfikowanych prób
  przed zapisem/mailem oraz limity przyjętych zgłoszeń na IP i powtarzalną
  tożsamość formularza;
- tryb obserwacyjny, który ocenia zgłoszenia, ale nie zmienia ich dostarczenia;
- lokalne i deterministyczne reguły domyślnie, bez zewnętrznych zapytań;
- opcjonalna reputacja DNSBL, SURBL i RDAP, domyślnie wyłączona;
- logi bez treści formularza, adresu e-mail, IP, tokenów i argumentów poczty;
- retencja `0` oznacza brak zapisywania logów diagnostycznych.

Pola techniczne, zgody, newsletter oraz telefon są pomijane podczas budowania tekstu ocenianego z CF7. Dzięki temu podpisy czasowe, tokeny i długie numery telefonu nie podbijają wyniku.

Limity zachowania nie zapisują surowych adresów IP, nazwisk, telefonów ani
e-maili. Klucze liczników zawierają wyłącznie skróty HMAC zależne od soli
WordPressa. Typowe pola `name`, `email`, `phone` i `tel` są wykrywane
automatycznie; nietypowe nazwy można podać filtrem
`rekurencja_antispam_cf7_identity_fields`.

## Instalacja

Skopiuj repozytorium do `wp-content/plugins/lightweight-rekurencja-antyspam` lub zainstaluj paczkę wydania i aktywuj wtyczkę. Ustawienia znajdują się w `Ustawienia → Rekurencja Antyspam`.

Bezpieczne ustawienia początkowe:

- próg miękki: `30`;
- próg twardy: `70`;
- tryb obserwacyjny: wyłączony po zakończeniu testu;
- retencja logów: `0`;
- DNSBL, SURBL i RDAP: wyłączone;
- kara za zwykły link: włączona.

Domyślna ochrona CF7 wymaga co najmniej `3` sekund wypełnienia, dopuszcza
`10` przyjętych zgłoszeń na formularz i IP w `15` minut oraz `3` przyjęte
zgłoszenia z tą samą nazwą, e-mailem lub telefonem w `24` godziny. Wartości
można zmienić w ustawieniach wtyczki bez modyfikowania motywu albo MU-pluginu.

Osobny limit zweryfikowanych prób na formularz i IP jest domyślnie wyłączony
(`0`). Po włączeniu zlicza próbę podczas wspólnej walidacji CF7, po przejściu
honeypota i podpisanego czasu, ale przed CFDB7 i wysyłką maila. Pierwsze `N`
prób w stałym oknie rozpoczynanym pierwszą próbą przechodzi do dalszej
walidacji, a `N+1` i kolejne są odrzucane. Zablokowane próby nie przedłużają
okna i generują najwyżej jeden wpis diagnostyczny w danym oknie. Licznik
korzysta z WordPress Transients; chroni przed typowym sekwencyjnym floodem,
lecz nie jest ścisłym atomowym limitem dla równoległego burstu.

Opcjonalny adres diagnostycznego BCC dotyczy wewnętrznych powiadomień CF7,
ale nie autoresponderów. Dla WPForms należy dodatkowo podać wewnętrzną
domenę odbiorców. Pusty adres BCC wyłącza tę funkcję.

## Prywatność

Przy retencji większej od zera zapisywane są wyłącznie: czas, typ integracji, wynik, decyzja, kody powodów oraz identyfikator formularza. Schemat tabeli zachowuje historyczne kolumny `source_ip` i `content` dla kompatybilności aktualizacji, ale wersje od 0.4.0 ich nie wypełniają.

Komentarze używają przez maksymalnie godzinę pseudonimowego licznika opartego na skrócie IP do ograniczenia serii prób. Formularze CF7 używają pseudonimowych liczników prób, przyjętych zgłoszeń i tożsamości tylko przez skonfigurowane okna limitów. Pełny adres IP ani surowa wartość pola tożsamości nie są zapisane w logu wtyczki.

## Rozwój i weryfikacja

```sh
php tests/run.php
find . -name '*.php' -not -path './vendor/*' -print0 | xargs -0 -n1 php -l
composer install
composer run lint
```

Test kontraktowy obejmuje rzeczywisty wzorzec rosyjskiego spamu z aktywnym linkiem, losowe tokeny, normalne zapytania PL/EN/RU, wykluczenie pól technicznych, rejestrację limitu na wspólnej walidacji CF7 oraz zachowanie trybu obserwacyjnego. Klasyczny POST i REST są dodatkowo falsyfikowane podczas kontrolowanego wdrożenia konsumenta.

## Changelog

### 0.6.0

- dodano domyślnie wyłączony, pseudonimowy limit zweryfikowanych prób CF7
  wykonywany przed CFDB7 i wysyłką maila;
- rozdzielono licznik wszystkich zweryfikowanych prób od dotychczasowych
  liczników przyjętych zgłoszeń i powtarzalnej tożsamości;
- rozszerzono test kontraktowy o stałe okno, ograniczenie logów, izolację
  formularza/IP oraz brak mutacji liczników w trybie obserwacyjnym.

### 0.5.0

- przeniesiono ochronę CF7 do jednego właściciela we wtyczce: podpisany czas,
  honeypot oraz pseudonimowe limity IP i tożsamości;
- dodano konfigurowalne, wewnętrzne kopie diagnostyczne CF7 i WPForms bez
  przechwytywania ogólnego `wp_mail()`;
- rozszerzono testy o rzeczywisty wzorzec automatu jednosekundowego i rotację IP.

### 0.4.1

- nadano stałym globalnym unikalny prefiks, aby uniknąć konfliktu m.in. z Ajax Search Lite.

### 0.4.0

- usunięto globalną bramkę `pre_wp_mail`;
- dodano silny, jawny sygnał aktywnego HTML i BBCode;
- wykluczono pola techniczne, zgody i telefon z tekstu CF7;
- tryb obserwacyjny nie zmienia już decyzji CF7 ani komentarzy;
- wyłączono domyślnie zewnętrzne sprawdzanie reputacji;
- wyłączono automatyczne ładowanie szerokich list słów przy aktywacji;
- logowanie nie przechowuje treści ani IP, a retencja `0` naprawdę wyłącza zapis.

### 0.3.0

Wersja źródłowa wdrożona wcześniej na Hasmed, zachowana w historii repozytorium jako commit importu. Hasmed nie jest celem rollout’u wersji 0.4.0.
