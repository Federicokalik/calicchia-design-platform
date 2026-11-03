"""
Test di fedeltà (fase F1, piano: "pytest fedeltà"; design §3.3 e invariante 3).

Un evento ricco come quelli di Apple, Google e Thunderbird (VTIMEZONE,
ricorrenza con EXDATE e override, VALARM, ATTENDEE e ORGANIZER con CN tra
virgolette, X-prop, URI con virgole, base64) deve uscire da Radicale dopo
PUT e GET (e da REPORT multiget ed expand) identico a com'è entrato, a meno
di ordine di proprietà e parametri, folding e forma canonica degli escape
TEXT (una virgola o un ';' non escapati in SUMMARY/LOCATION/DESCRIPTION
diventano '\\,' e '\\;', come vuole RFC 5545).

Il controllo di sensibilità mostra che senza la patch (vobject 0.9.9 nudo, in
un interprete isolato) lo stesso confronto fallisce: SUMMARY, LOCATION, X-prop
e URI vengono troncati alla prima virgola.
"""

from __future__ import annotations

import hashlib
import subprocess
import sys
from pathlib import Path
import pytest

import caldes_harness as h
import caldes_vobject_fix

P = "/%s" % h.PRINCIPAL
UID = "7F3A1C2E-0B1D-4E5F-9A8B-1234567890AB"

RICH_EVENT = h.ics([
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Apple Inc.//macOS 15.0//EN",
    "CALSCALE:GREGORIAN",
    "X-WR-CALNAME:Lavoro, casa",
    "BEGIN:VTIMEZONE",
    "TZID:Europe/Rome",
    "X-LIC-LOCATION:Europe/Rome",
    "BEGIN:DAYLIGHT",
    "TZOFFSETFROM:+0100",
    "TZOFFSETTO:+0200",
    "TZNAME:CEST",
    "DTSTART:19700329T020000",
    "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
    "END:DAYLIGHT",
    "BEGIN:STANDARD",
    "TZOFFSETFROM:+0200",
    "TZOFFSETTO:+0100",
    "TZNAME:CET",
    "DTSTART:19701025T030000",
    "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
    "END:STANDARD",
    "END:VTIMEZONE",
    "BEGIN:VEVENT",
    "UID:" + UID,
    "DTSTAMP:20261001T080000Z",
    "CREATED:20261001T075500Z",
    "LAST-MODIFIED:20261001T080000Z",
    "SEQUENCE:2",
    "DTSTART;TZID=Europe/Rome:20261012T090000",
    "DTEND;TZID=Europe/Rome:20261012T100000",
    "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20261130T225959Z",
    "EXDATE;TZID=Europe/Rome:20261014T090000,20261016T090000",
    "SUMMARY:Riunione, settimanale",
    "LOCATION:Studio Calicchia, Via Roma 1, Frosinone",
    "DESCRIPTION:Ordine del giorno:\\n1. budget\\, Q4\\n2. varie; eventuali",
    "CATEGORIES:Lavoro,Cliente",
    "CLASS:PUBLIC",
    "TRANSP:OPAQUE",
    "STATUS:CONFIRMED",
    "URL;VALUE=URI:https://caldes.test/riunione?a=1,2",
    "GEO:41.639;13.342",
    "ORGANIZER;CN=\"Calicchia, Federico\":mailto:federico@caldes.test",
    "ATTENDEE;CN=\"Rossi, Mario\";CUTYPE=INDIVIDUAL;PARTSTAT=ACCEPTED;ROLE=REQ-PARTICIPANT;RSVP=TRUE:"
    "mailto:mario.rossi@example.com",
    "ATTENDEE;CN=Bianchi;PARTSTAT=NEEDS-ACTION;ROLE=OPT-PARTICIPANT;X-NUM-GUESTS=0:mailto:bianchi@example.com",
    "X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-ADDRESS=\"Via Roma 1, Frosinone\";X-APPLE-RADIUS=70;"
    "X-TITLE=\"Studio Calicchia\":geo:41.639,13.342",
    "CONFERENCE;VALUE=URI;FEATURE=AUDIO,VIDEO;LABEL=\"Riunione, video\":https://meet.caldes.test/stanza?a=1,2",
    "X-MICROSOFT-CDO-BUSYSTATUS:BUSY",
    "X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC",
    "X-CALDES-SOURCE-ID:gruppo;voce",
    "X-FOO:a,b,c",
    "X-ESC:a\\,b",
    "X-BASE64;ENCODING=BASE64;VALUE=BINARY:aGVsbG8sIHdvcmxk",
    "ATTACH;FMTTYPE=application/pdf:https://caldes.test/file.pdf?x=1,2",
    "BEGIN:VALARM",
    "UID:A1B2C3D4-0000-4000-8000-000000000001",
    "X-WR-ALARMUID:A1B2C3D4-0000-4000-8000-000000000001",
    "ACTION:DISPLAY",
    "DESCRIPTION:Promemoria, tra poco",
    "TRIGGER:-PT15M",
    "X-APPLE-DEFAULT-ALARM:TRUE",
    "END:VALARM",
    "BEGIN:VALARM",
    "ACTION:AUDIO",
    "TRIGGER;VALUE=DATE-TIME:20261012T064500Z",
    "ATTACH;VALUE=URI:Chord",
    "END:VALARM",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:" + UID,
    "RECURRENCE-ID;TZID=Europe/Rome:20261019T090000",
    "DTSTAMP:20261001T080000Z",
    "SEQUENCE:3",
    "DTSTART;TZID=Europe/Rome:20261019T110000",
    "DTEND;TZID=Europe/Rome:20261019T120000",
    "SUMMARY:Riunione, spostata",
    "X-CALDES-NOTA:spostata, su richiesta",
    "END:VEVENT",
    "END:VCALENDAR",
])

def _assert_faithful(original: str, returned: str) -> None:
    before = h.canonical_ics(original)
    after = h.canonical_ics(returned)
    missing = [line for line in before if line not in after]
    added = [line for line in after if line not in before]
    assert not missing and not added, "perse: %r\naggiunte: %r" % (missing, added)


def _count(text: str, line: str) -> int:
    return sum(1 for item in h.unfold(text) if item == line)


@pytest.fixture
def live(tmp_path: Path) -> h.InProcessRadicale:
    rad = h.InProcessRadicale(tmp_path)
    rad.initialize(collections=("c",))
    rad.control.set_mode("live")
    return rad


def test_put_get_conserva_tutto(live: h.InProcessRadicale) -> None:
    res = live.put(P + "/c/ricco.ics", h.PRINCIPAL, RICH_EVENT)
    assert res.status == 201, res.describe()
    body = live.get(P + "/c/ricco.ics", h.PRINCIPAL)
    assert body.status == 200
    _assert_faithful(RICH_EVENT, body.text)
    lines = h.unfold(body.text)
    assert "SUMMARY:Riunione\\, settimanale" in lines
    assert "LOCATION:Studio Calicchia\\, Via Roma 1\\, Frosinone" in lines
    assert "DESCRIPTION:Promemoria\\, tra poco" in lines
    assert "X-FOO:a,b,c" in lines and "X-ESC:a\\,b" in lines and "X-CALDES-SOURCE-ID:gruppo;voce" in lines
    assert h.first_property(body.text, "X-APPLE-STRUCTURED-LOCATION") == "geo:41.639,13.342"
    assert h.first_property(body.text, "CONFERENCE") == "https://meet.caldes.test/stanza?a=1,2"
    assert _count(body.text, "BEGIN:VALARM") == 2
    assert _count(body.text, "BEGIN:VTIMEZONE") == 1
    assert sum(1 for line in lines if line.startswith("ATTENDEE")) == 2
    # Il file su disco è quello che torna con GET.
    assert (live.collection_dir("c") / "ricco.ics").read_bytes() == body.body


def test_riserializzazione_idempotente(live: h.InProcessRadicale) -> None:
    assert live.put(P + "/c/ricco.ics", h.PRINCIPAL, RICH_EVENT).status == 201
    first = live.get(P + "/c/ricco.ics", h.PRINCIPAL)
    etag = first.header("ETag")
    res = live.put(P + "/c/ricco.ics", h.PRINCIPAL, first.text, if_match=etag)
    assert res.status in (201, 204), res.describe()
    second = live.get(P + "/c/ricco.ics", h.PRINCIPAL)
    assert second.text == first.text
    assert second.header("ETag") == etag, "stesso contenuto, stesso ETag"


def test_report_multiget_conserva_tutto(live: h.InProcessRadicale) -> None:
    assert live.put(P + "/c/ricco.ics", h.PRINCIPAL, RICH_EVENT).status == 201
    res = live.report(P + "/c/", h.PRINCIPAL, h.multiget_body([P + "/c/ricco.ics"]))
    assert res.status == 207
    data = res.multistatus()[P + "/c/ricco.ics"]["props"]["{urn:ietf:params:xml:ns:caldav}calendar-data"]
    _assert_faithful(RICH_EVENT, data)


def test_expand_del_report_non_altera_le_proprieta_verbatim(live: h.InProcessRadicale) -> None:
    # L'expand duplica i VEVENT (ContentLine.duplicate perde 'encoded'): i
    # valori verbatim non devono essere escapati una seconda volta.
    assert live.put(P + "/c/ricco.ics", h.PRINCIPAL, RICH_EVENT).status == 201
    res = live.report(P + "/c/", h.PRINCIPAL, h.calendar_query_expand_body("20261012T000000Z", "20261024T000000Z"))
    assert res.status == 207, res.describe()
    data = res.multistatus()[P + "/c/ricco.ics"]["props"]["{urn:ietf:params:xml:ns:caldav}calendar-data"]
    lines = h.unfold(data)
    instances = [line for line in lines if line.startswith("RECURRENCE-ID")]
    # 12, 19 (override), 21, 23 ottobre: 14 e 16 sono EXDATE.
    assert len(instances) == 4, instances
    assert _count(data, "X-FOO:a,b,c") == 3
    assert _count(data, "X-CALDES-SOURCE-ID:gruppo;voce") == 3
    assert _count(data, "SUMMARY:Riunione\\, settimanale") == 3
    assert _count(data, "SUMMARY:Riunione\\, spostata") == 1
    assert _count(data, "X-CALDES-NOTA:spostata, su richiesta") == 1
    assert all("\\\\" not in line for line in lines), "doppio escape dopo duplicate()"


@pytest.mark.parametrize(
    ("line", "expected"),
    [
        ("SUMMARY:Pranzo, cena", "SUMMARY:Pranzo\\, cena"),
        ("SUMMARY:a;b", "SUMMARY:a\\;b"),
        ("SUMMARY:già\\, escapata", "SUMMARY:già\\, escapata"),
        ("COMMENT:uno, due, tre", "COMMENT:uno\\, due\\, tre"),
        ("X-APPLE-TRAVEL-START;VALUE=URI;ROUTING=CAR:geo:41.6,13.3", "X-APPLE-TRAVEL-START;ROUTING=CAR;VALUE=URI:geo:41.6,13.3"),
        ("X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij?a=1,2", "X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij?a=1,2"),
        ("X-MOZ-LASTACK:20261001T080000Z", "X-MOZ-LASTACK:20261001T080000Z"),
        ("X-SEMICOLON:a\\;b;c", "X-SEMICOLON:a\\;b;c"),
        ("X-BACKSLASH:C:\\\\percorso\\\\file", "X-BACKSLASH:C:\\\\percorso\\\\file"),
        ("DESCRIPTION;ENCODING=BASE64:aGVsbG8sIHdvcmxk", "DESCRIPTION;ENCODING=BASE64:aGVsbG8sIHdvcmxk"),
        ("LOCATION;VALUE=URI:geo:41.639,13.342", "LOCATION;VALUE=URI:geo:41.639,13.342"),
    ],
)
def test_singole_proprieta(live: h.InProcessRadicale, line: str, expected: str) -> None:
    name = "p" + hashlib.sha256(line.encode("utf-8")).hexdigest()[:12]
    res = live.put("%s/c/%s.ics" % (P, name), h.PRINCIPAL, h.event_ics(name + "@caldes.test", [line]))
    assert res.status == 201, res.describe()
    assert expected in h.unfold(live.get("%s/c/%s.ics" % (P, name), h.PRINCIPAL).text)


def _vanilla_vobject(text: str) -> "subprocess.CompletedProcess[str]":
    # Interprete isolato (-I: niente PYTHONPATH né sitecustomize, quindi niente
    # patch): vobject 0.9.9 nudo, come in Radicale senza i plugin di Caldes.
    script = (
        "import sys, vobject\n"
        "assert 'caldes_vobject_fix' not in sys.modules\n"
        "sys.stdout.write(vobject.readOne(sys.stdin.read()).serialize())\n"
    )
    return subprocess.run([sys.executable, "-I", "-c", script], input=text, capture_output=True, text=True,
                          timeout=60)


def test_senza_patch_vobject_tronca() -> None:
    # Senza la riga base64 (che vobject nudo non sa nemmeno riserializzare, vedi
    # sotto) il confronto rileva i troncamenti alla prima virgola.
    text = "\r\n".join(line for line in RICH_EVENT.split("\r\n") if not line.startswith("X-BASE64"))
    result = _vanilla_vobject(text)
    assert result.returncode == 0, result.stderr
    lines = h.unfold(result.stdout)
    assert "SUMMARY:Riunione" in lines
    assert "LOCATION:Studio Calicchia" in lines
    assert "X-FOO:a" in lines
    assert "X-CALDES-SOURCE-ID:gruppo\\;voce" in lines
    assert h.first_property(result.stdout, "X-APPLE-STRUCTURED-LOCATION") == "geo:41.639"
    assert h.first_property(result.stdout, "CONFERENCE") == "https://meet.caldes.test/stanza?a=1"
    assert h.first_property(result.stdout, "DESCRIPTION", "VALARM") == "Promemoria"
    with pytest.raises(AssertionError):
        _assert_faithful(text, result.stdout)


def test_senza_patch_il_base64_non_si_riserializza() -> None:
    # vobject 0.9.9 decodifica ENCODING=BASE64 in bytes e poi fallisce a
    # riserializzarli: senza patch la PUT di un oggetto così non va a buon fine.
    result = _vanilla_vobject(h.event_ics("b64@caldes.test", ["X-ALLEGATO;ENCODING=BASE64:aGVsbG8sIHdvcmxk"]))
    assert result.returncode != 0
    assert "has no attribute 'encode'" in result.stderr


def test_sitecustomize_attiva_la_patch_all_avvio() -> None:
    env = {"PYTHONPATH": str(h.PLUGINS_DIR), "PYTHONDONTWRITEBYTECODE": "1", "PATH": "/usr/bin:/bin"}
    script = (
        "import sys\n"
        "print('caldes_vobject_fix' in sys.modules)\n"
        "import caldes_vobject_fix\n"
        "print(caldes_vobject_fix.is_applied())\n"
    )
    result = subprocess.run([sys.executable, "-c", script], env=env, capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stderr
    assert result.stdout.split() == ["True", "True"]
    assert result.stderr == ""


def test_patch_idempotente_e_self_test() -> None:
    caldes_vobject_fix.apply()
    caldes_vobject_fix.apply()
    assert caldes_vobject_fix.is_applied()
    caldes_vobject_fix.self_test()
    assert caldes_vobject_fix.vobject_version() == caldes_vobject_fix.EXPECTED_VOBJECT_VERSION


def test_processo_reale_con_sitecustomize(tmp_path: Path) -> None:
    # Radicale in un processo separato con PYTHONPATH sui plugin, come
    # nell'immagine: nessun import esplicito della patch prima di servire.
    with h.RadicaleProcess(tmp_path) as rad:
        rad.initialize(collections=("c",))
        rad.control.set_mode("live")
        res = rad.put(P + "/c/ricco.ics", h.PRINCIPAL, RICH_EVENT)
        assert res.status == 201, res.describe() + rad.logs()[-3000:]
        body = rad.get(P + "/c/ricco.ics", h.PRINCIPAL)
        assert body.status == 200
        _assert_faithful(RICH_EVENT, body.text)
        assert "patch di fedeltà attiva" in rad.logs()
