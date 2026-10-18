"""
Patch di fedeltà per vobject 0.9.9 (Radicale 3.7.8), fase F1 del passaggio
del calendario a Radicale (design §3.3, invariante 3 del §1).

Radicale riscrive OGNI oggetto ricevuto con PUT: lo legge con vobject e salva
su disco la riserializzazione. vobject 0.9.9 tratta come TEXT a valore singolo
sia le proprietà TEXT note (SUMMARY, LOCATION, DESCRIPTION...) sia tutte le
proprietà che non conosce (X-*, CONFERENCE...), e in decodifica tiene solo il
primo elemento della lista separata da virgole non escapate. Senza patch:

- "SUMMARY:Pranzo, cena" diventa "Pranzo";
- "LOCATION:Via Roma 1, Frosinone" diventa "Via Roma 1";
- "X-FOO:a,b,c" diventa "a" e "X-CALDES-SOURCE-ID:gruppo;voce" "gruppo\\;voce";
- "X-APPLE-STRUCTURED-LOCATION;VALUE=URI:geo:41.639,13.342" perde la longitudine;
- CONFERENCE e la DESCRIPTION dei VALARM vengono troncate.

La patch (idempotente, attiva all'import del modulo):

1. le proprietà sconosciute (defaultBehavior dei componenti iCalendar) passano a
   `_RawBehavior`: il valore letto resta byte per byte com'era (escape compresi)
   e viene riscritto identico;
2. `TextBehavior.decode` (proprietà TEXT note): le virgole non escapate restano
   un carattere letterale invece di separare valori, e alla riserializzazione
   diventano `\\,` come vuole RFC 5545 §3.3.11; i valori con `VALUE=URI` o
   `ENCODING=BASE64` restano verbatim (un URI non ha escape TEXT; vobject 0.9.9
   decodificherebbe il base64 in bytes e poi fallirebbe a riserializzarli);
3. `RecurringComponent.getrruleset` (e la property `rruleset`) rifiutano con
   ValueError le RRULE/EXRULE con valori vietati da RFC 5545 §3.3.10 che
   dateutil accetta senza errore: INTERVAL o COUNT non interi positivi,
   BYMONTHDAY/BYYEARDAY/BYWEEKNO uguali a 0 o fuori intervallo, BYMONTH fuori
   da 1..12 (`check_recurrence_rule`). Con INTERVAL=0 dateutil non avanza mai
   e una REPORT con time-range sulla collezione resterebbe appesa; Radicale
   chiama `component.rruleset` in `check_and_sanitize_items`, quindi la PUT
   risponde 400 ("Invalid recurrence rules") e l'oggetto non entra nel volume
   (contratto dei moduli F2 §14.6). Sono gli stessi valori che calendar-core
   rifiuta (parseRecurRule): un oggetto così non arriva né ai device né
   all'indice. Un oggetto già salvato (prima della patch) fa fallire la REPORT
   con un errore invece di bloccarla.

I valori impostati dal codice (non letti da un file), per esempio la
X-WR-CALNAME che Radicale aggiunge all'export di una collezione, continuano a
essere escapati come TEXT: la distinzione la portano due sottoclassi di str,
`_VerbatimText` (valore letto, da riscrivere identico) ed `_EscapedText`
(valore appena escapato da noi, da riportare al testo nativo dopo la
serializzazione). Entrambe sopravvivono a `copy.copy`/`duplicate` (Radicale
duplica i VEVENT nell'expand del REPORT) e diventano str semplici con pickle
(la cache degli item di Radicale non deve dipendere da questo modulo).

Attivazione: `sitecustomize.py` (stessa cartella, in PYTHONPATH nell'immagine)
importa il modulo all'avvio dell'interprete, prima che Radicale legga qualsiasi
item; `caldes_rights` lo reimporta ed esegue `self_test()` nel costruttore, così
Radicale non parte se la patch non è attiva o non funziona (un errore in
sitecustomize Python lo stampa e lo ignora). `caldes_selftest.py` la verifica
in build.

Solo libreria standard + vobject (già nell'immagine).
"""

from __future__ import annotations

import copy as _copy
import pickle as _pickle
from typing import Any, List, Optional

import vobject
import vobject.base as _vbase
import vobject.behavior as _vbehavior
import vobject.icalendar as _vical

__all__ = [
    "EXPECTED_VOBJECT_VERSION",
    "InvalidRecurrenceRule",
    "PatchError",
    "apply",
    "check_recurrence_rule",
    "is_applied",
    "self_test",
    "vobject_version",
]

#: Versione di vobject per cui la patch è stata scritta e verificata
#: (design §3.1). Con un'altra versione la patch si applica comunque, ma
#: self_test() decide se funziona davvero.
EXPECTED_VOBJECT_VERSION = "0.9.9"

#: Marcatore messo su TextBehavior quando la patch è applicata (idempotenza).
_PATCH_MARK = "_caldes_fidelity_patch"

#: Marcatore messo su RecurringComponent quando il controllo delle RRULE è attivo.
_RRULE_PATCH_MARK = "_caldes_rrule_guard"


class PatchError(RuntimeError):
    """La patch non è applicabile o il self-test è fallito."""


# ─── Valori marcati ───────────────────────────────────────────


class _VerbatimText(str):
    """Valore letto da un file e da riscrivere identico (nessun escape TEXT)."""

    __slots__ = ()

    def __copy__(self) -> "_VerbatimText":
        return self

    def __deepcopy__(self, memo: Any) -> "_VerbatimText":
        return self

    def __reduce__(self) -> Any:
        # Con pickle diventa una str semplice: la cache degli item di Radicale
        # (pickle su disco) non deve richiedere questo modulo per essere letta.
        return (str, (str(self),))


class _EscapedText(str):
    """Valore nativo appena escapato da encode(): decode() lo riporta al testo nativo."""

    __slots__ = ()

    def __copy__(self) -> "_EscapedText":
        return self

    def __deepcopy__(self, memo: Any) -> "_EscapedText":
        return self

    def __reduce__(self) -> Any:
        return (str, (str(self),))


def _param_upper(line: Any, name: str) -> str:
    """Valore di un parametro (es. 'value' → VALUE) in maiuscolo, '' se assente."""
    try:
        value = getattr(line, name + "_param")
    except AttributeError:
        return ""
    return str(value).upper() if value is not None else ""


def _unescape_text(value: str) -> str:
    """
    Testo nativo di un valore TEXT escapato, con le virgole non escapate
    conservate come carattere letterale (vobject le userebbe come separatore
    di lista e terrebbe solo il primo elemento).
    """
    return ",".join(_vical.stringToTextValues(value))


# ─── Comportamento delle proprietà sconosciute ────────────────


class _RawBehavior(_vbehavior.Behavior):
    """
    Proprietà iCalendar che vobject non conosce (X-*, CONFERENCE, ...): il
    valore letto resta verbatim; un valore impostato dal codice viene escapato
    come TEXT (stesso risultato della TextBehavior originale).
    """

    name = "CALDES-RAW"
    hasNative = False

    @classmethod
    def decode(cls, line: Any) -> None:
        if not line.encoded:
            return
        if isinstance(line.value, _EscapedText):
            # Ritorno da encode() durante la serializzazione di un valore nativo.
            line.value = _unescape_text(line.value)
        elif isinstance(line.value, str):
            line.value = _VerbatimText(line.value)
        line.encoded = False

    @classmethod
    def encode(cls, line: Any) -> None:
        if line.encoded:
            return
        if isinstance(line.value, str) and not isinstance(line.value, (_VerbatimText, _EscapedText)):
            line.value = _EscapedText(_vbase.backslashEscape(line.value))
        line.encoded = True


# ─── TextBehavior (proprietà TEXT note) ───────────────────────

_ORIGINAL_TEXT_ENCODE = _vical.TextBehavior.encode.__func__  # type: ignore[attr-defined]


def _text_decode(cls: Any, line: Any) -> None:
    if not line.encoded:
        return
    value = line.value
    if isinstance(value, _VerbatimText):
        pass  # già verbatim (es. riletto dopo encode durante la serializzazione)
    elif isinstance(value, _EscapedText):
        line.value = _unescape_text(value)
    elif isinstance(value, str) and (
        _param_upper(line, "value") == "URI"
        or _param_upper(line, "encoding") == cls.base64string
    ):
        # Un URI non ha escape TEXT (geo:41.639,13.342): resta identico. Il
        # base64 resta codificato: decodificarlo produrrebbe bytes che
        # l'encode originale di vobject 0.9.9 non sa riserializzare.
        line.value = _VerbatimText(value)
    elif isinstance(value, str):
        line.value = _unescape_text(value)
    line.encoded = False


def _text_encode(cls: Any, line: Any) -> None:
    if line.encoded:
        return
    if isinstance(line.value, _VerbatimText):
        line.encoded = True
        return
    _ORIGINAL_TEXT_ENCODE(cls, line)
    if isinstance(line.value, str) and not isinstance(line.value, _EscapedText):
        # decode() riporterà questo valore al testo nativo.
        line.value = _EscapedText(line.value)


# ─── RRULE vietate dalla RFC che dateutil accetta ─────────────


class InvalidRecurrenceRule(ValueError):
    """RRULE/EXRULE con un valore vietato da RFC 5545 §3.3.10 (rifiutata alla PUT)."""


#: Parti numeriche controllate: (minimo, massimo o None, ammette il segno).
#: Le altre (BYHOUR, BYMINUTE, BYSECOND, BYSETPOS, BYDAY ordinale) dateutil le
#: rifiuta già con ValueError; FREQ e le parti sconosciute anche.
_RRULE_NUMERIC_PARTS = {
    "INTERVAL": (1, None, False),
    "COUNT": (1, None, False),
    "BYMONTHDAY": (1, 31, True),
    "BYYEARDAY": (1, 366, True),
    "BYWEEKNO": (1, 53, True),
    "BYMONTH": (1, 12, False),
}

#: Cifre ammesse per INTERVAL e COUNT (come calendar-core): oltre non sono interi plausibili.
_RRULE_MAX_DIGITS = {"INTERVAL": 6, "COUNT": 9}


def check_recurrence_rule(value: str) -> None:
    """
    Lancia InvalidRecurrenceRule se la regola ha un valore vietato da RFC 5545
    §3.3.10 che dateutil accetterebbe: INTERVAL o COUNT non interi positivi
    (INTERVAL=0 fa girare dateutil all'infinito), BYMONTHDAY, BYYEARDAY e
    BYWEEKNO uguali a 0 o fuori intervallo, BYMONTH fuori da 1..12. Il resto
    della validazione resta a dateutil (stessi valori rifiutati da calendar-core).
    """
    if not isinstance(value, str):
        return
    # Come vobject.getrruleset: una libreria Ruby escapa i ';' delle RRULE.
    body = value.replace("\\", "").strip()
    if body[:6].upper() == "RRULE:":
        body = body[6:]
    for raw in body.split(";"):
        part = raw.strip()
        if not part or "=" not in part:
            continue
        name, _, val = part.partition("=")
        name = name.strip().upper()
        spec = _RRULE_NUMERIC_PARTS.get(name)
        if spec is None:
            continue
        low, high, signed = spec
        items = val.split(",") if name.startswith("BY") else [val]
        for item in items:
            text = item.strip()
            digits = text[1:] if signed and text[:1] in ("+", "-") else text
            max_digits = _RRULE_MAX_DIGITS.get(name, 3)
            if not digits.isdigit() or not digits.isascii() or len(digits) > max_digits:
                raise InvalidRecurrenceRule("RRULE non valida: %s=%r" % (name, val[:20]))
            number = int(digits)
            if number < low or (high is not None and number > high):
                raise InvalidRecurrenceRule("RRULE non valida: %s=%r fuori intervallo" % (name, val[:20]))


_ORIGINAL_GETRRULESET = _vical.RecurringComponent.getrruleset
_ORIGINAL_RRULESET_PROPERTY = _vical.RecurringComponent.__dict__.get("rruleset")


def _checked_getrruleset(self: Any, addRDate: bool = False) -> Any:
    for name in ("rrule", "exrule"):
        for line in self.contents.get(name, ()):
            check_recurrence_rule(line.value)
    return _ORIGINAL_GETRRULESET(self, addRDate)


def _apply_rrule_guard() -> None:
    component = _vical.RecurringComponent
    if getattr(component, _RRULE_PATCH_MARK, False):
        return
    prop = _ORIGINAL_RRULESET_PROPERTY
    if not isinstance(prop, property) or not callable(_ORIGINAL_GETRRULESET):
        raise PatchError("vobject %s: RecurringComponent senza getrruleset/rruleset: patch non applicabile"
                         % (vobject_version() or "?"))
    component.getrruleset = _checked_getrruleset
    # La property 'rruleset' tiene il riferimento alla funzione originale.
    component.rruleset = property(_checked_getrruleset, prop.fset)
    setattr(component, _RRULE_PATCH_MARK, True)


# ─── Applicazione ─────────────────────────────────────────────


def vobject_version() -> str:
    """Versione di vobject in uso ('' se non determinabile)."""
    return str(getattr(vobject, "VERSION", "") or "")


def _component_behaviors() -> List[type]:
    """Behavior dei componenti iCalendar che usano TextBehavior per le proprietà sconosciute."""
    found = []
    for name in dir(_vical):
        obj = getattr(_vical, name)
        if (
            isinstance(obj, type)
            and issubclass(obj, _vbehavior.Behavior)
            and getattr(obj, "defaultBehavior", None) in (_vical.TextBehavior, _RawBehavior)
        ):
            found.append(obj)
    return found


def is_applied() -> bool:
    """La patch è attiva in questo interprete."""
    if not getattr(_vical.TextBehavior, _PATCH_MARK, False):
        return False
    if not getattr(_vical.RecurringComponent, _RRULE_PATCH_MARK, False):
        return False
    behaviors = _component_behaviors()
    return bool(behaviors) and all(b.defaultBehavior is _RawBehavior for b in behaviors)


def apply() -> None:
    """Applica la patch (idempotente). Lancia PatchError se vobject non ha la forma attesa."""
    if is_applied():
        return
    text = getattr(_vical, "TextBehavior", None)
    if text is None or not hasattr(_vical, "stringToTextValues") or not hasattr(_vbase, "backslashEscape"):
        raise PatchError(
            "vobject %s non espone TextBehavior/stringToTextValues/backslashEscape: patch non applicabile"
            % (vobject_version() or "?")
        )
    behaviors = _component_behaviors()
    if not behaviors:
        raise PatchError("nessun componente iCalendar con defaultBehavior TextBehavior: patch non applicabile")
    _apply_rrule_guard()
    for behavior in behaviors:
        behavior.defaultBehavior = _RawBehavior
    text.decode = classmethod(_text_decode)
    text.encode = classmethod(_text_encode)
    setattr(text, _PATCH_MARK, True)


# ─── Self-test ────────────────────────────────────────────────

_SELF_TEST_ICS = "\r\n".join([
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Calicchia Design//caldes self-test//IT",
    "X-WR-CALNAME:Lavoro, casa",
    "BEGIN:VEVENT",
    "UID:caldes-selftest@caldes.it",
    "DTSTAMP:20261001T000000Z",
    "DTSTART:20261010T090000Z",
    "DTEND:20261010T100000Z",
    "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4",
    "SUMMARY:Pranzo, cena",
    "LOCATION:Via Roma 1, Frosinone",
    "DESCRIPTION:riga1\\nriga2\\, con virgola escapata\\; e punto e virgola",
    "CATEGORIES:lavoro,cliente",
    "X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-TITLE=\"Studio, Frosinone\":geo:41.639,13.342",
    "CONFERENCE;VALUE=URI;FEATURE=VIDEO:https://meet.caldes.test/stanza?a=1,2",
    "X-FOO:a,b,c",
    "X-CALDES-SOURCE-ID:gruppo;voce",
    "X-ESC:a\\,b",
    "ATTENDEE;CN=\"Rossi, Mario\";PARTSTAT=ACCEPTED:mailto:mario@example.com",
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "DESCRIPTION:Promemoria, tra poco",
    "TRIGGER:-PT15M",
    "X-WR-ALARMUID:1,2",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
])

#: Righe (dopo l'unfold) che la riserializzazione DEVE contenere.
_SELF_TEST_EXPECTED = (
    "X-WR-CALNAME:Lavoro, casa",
    "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4",
    "SUMMARY:Pranzo\\, cena",
    "LOCATION:Via Roma 1\\, Frosinone",
    "DESCRIPTION:riga1\\nriga2\\, con virgola escapata\\; e punto e virgola",
    "CATEGORIES:lavoro,cliente",
    "X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-TITLE=\"Studio, Frosinone\":geo:41.639,13.342",
    "CONFERENCE;FEATURE=VIDEO;VALUE=URI:https://meet.caldes.test/stanza?a=1,2",
    "X-FOO:a,b,c",
    "X-CALDES-SOURCE-ID:gruppo;voce",
    "X-ESC:a\\,b",
    "ATTENDEE;CN=\"Rossi, Mario\";PARTSTAT=ACCEPTED:mailto:mario@example.com",
    "DESCRIPTION:Promemoria\\, tra poco",
    "X-WR-ALARMUID:1,2",
)


def _unfolded_lines(text: str) -> List[str]:
    """Righe logiche di un iCalendar (unfold RFC 5545 §3.1)."""
    lines: List[str] = []
    for raw in text.replace("\r\n", "\n").split("\n"):
        if raw[:1] in (" ", "\t") and lines:
            lines[-1] += raw[1:]
        elif raw:
            lines.append(raw)
    return lines


def _check(condition: bool, message: str, failures: List[str]) -> None:
    if not condition:
        failures.append(message)


def self_test() -> None:
    """
    Verifica che la patch sia attiva e funzioni: riserializzazione fedele e
    idempotente, valori verbatim conservati anche dopo duplicate() (expand del
    REPORT), valori impostati dal codice escapati come TEXT, pickle in str
    semplici. Lancia PatchError con l'elenco dei problemi.
    """
    failures: List[str] = []
    if not is_applied():
        raise PatchError("patch di fedeltà vobject non applicata")

    try:
        calendar = vobject.readOne(_SELF_TEST_ICS)
        first = calendar.serialize()
        second = vobject.readOne(first).serialize()
    except Exception as exc:  # noqa: BLE001 - qualsiasi errore è un fallimento del self-test
        raise PatchError("riserializzazione fallita: %r" % (exc,)) from exc

    lines = _unfolded_lines(first)
    for expected in _SELF_TEST_EXPECTED:
        _check(expected in lines, "riga attesa assente: %r" % expected, failures)
    _check(first == second, "riserializzazione non idempotente", failures)

    # Expand del REPORT: Radicale duplica il VEVENT (ContentLine.duplicate non
    # copia 'encoded' né gli attributi aggiunti): i valori verbatim restano tali.
    try:
        vevent = calendar.vevent
        dup = vevent.duplicate(vevent)
        dup_lines = _unfolded_lines(dup.serialize())
        for expected in ("X-FOO:a,b,c", "X-CALDES-SOURCE-ID:gruppo;voce",
                         "SUMMARY:Pranzo\\, cena",
                         "CONFERENCE;FEATURE=VIDEO;VALUE=URI:https://meet.caldes.test/stanza?a=1,2"):
            _check(expected in dup_lines, "dopo duplicate() riga attesa assente: %r" % expected, failures)
    except Exception as exc:  # noqa: BLE001
        failures.append("duplicate() fallito: %r" % (exc,))

    # Valore impostato dal codice (come la X-WR-CALNAME dell'export di Radicale).
    try:
        native = vobject.iCalendar()
        native.add("X-WR-CALNAME").value = "Lavoro, casa\nseconda riga"
        native.add("X-CALDES-NOTA").value = "a;b"
        native_lines = _unfolded_lines(native.serialize())
        _check("X-WR-CALNAME:Lavoro\\, casa\\nseconda riga" in native_lines,
               "valore nativo di una X-prop non escapato come TEXT", failures)
        _check("X-CALDES-NOTA:a\\;b" in native_lines,
               "valore nativo di una X-prop non escapato come TEXT (;)", failures)
        _check(native.x_wr_calname.value == "Lavoro, casa\nseconda riga",
               "valore nativo alterato dalla serializzazione", failures)
    except Exception as exc:  # noqa: BLE001
        failures.append("serializzazione di valori nativi fallita: %r" % (exc,))

    # RRULE vietate dalla RFC che dateutil accetta (INTERVAL=0 non termina):
    # rruleset deve lanciare ValueError, che Radicale traduce in 400 alla PUT.
    try:
        bad = vobject.readOne(_SELF_TEST_ICS.replace("RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4",
                                                     "RRULE:FREQ=DAILY;INTERVAL=0"))
        try:
            bad.vevent.rruleset
            failures.append("RRULE con INTERVAL=0 accettata")
        except InvalidRecurrenceRule:
            pass
        _check(calendar.vevent.rruleset is not None, "RRULE valida rifiutata", failures)
    except Exception as exc:  # noqa: BLE001
        failures.append("controllo delle RRULE fallito: %r" % (exc,))

    # La cache degli item (pickle) non deve dipendere da questo modulo.
    try:
        x_foo = calendar.vevent.contents["x-foo"][0].value
        _check(isinstance(x_foo, _VerbatimText), "X-FOO non marcata come verbatim", failures)
        restored = _pickle.loads(_pickle.dumps(x_foo))
        _check(type(restored) is str and restored == "a,b,c", "pickle di un valore verbatim non è una str", failures)
        _check(_copy.copy(x_foo) is x_foo, "copy di un valore verbatim non lo conserva", failures)
    except Exception as exc:  # noqa: BLE001
        failures.append("controllo pickle/copy fallito: %r" % (exc,))

    if failures:
        raise PatchError("self-test della patch vobject fallito: " + "; ".join(failures))


def describe() -> Optional[str]:
    """Riga informativa per i log (versione e stato della patch)."""
    return "vobject %s, patch di fedeltà %s" % (
        vobject_version() or "?",
        "attiva" if is_applied() else "NON attiva",
    )


# La patch si applica all'import: chi importa il modulo (sitecustomize,
# caldes_rights, caldes_selftest) la ottiene prima di leggere qualsiasi item.
apply()
