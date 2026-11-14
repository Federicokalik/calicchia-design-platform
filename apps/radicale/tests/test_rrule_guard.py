"""
RRULE vietate dalla RFC che dateutil accetta (contratto dei moduli F2 §14.6).

Con `FREQ=DAILY;INTERVAL=0` dateutil non avanza mai: Radicale 3.7.8 accettava
la PUT e una REPORT calendar-query con time-range su quella collezione restava
appesa. La patch `caldes_vobject_fix` controlla le RRULE in
`RecurringComponent.getrruleset`, che Radicale chiama alla PUT
(`check_and_sanitize_items` → `component.rruleset`): la PUT risponde 400 e
l'oggetto non entra nel volume. Gli stessi valori li rifiuta calendar-core.
"""

from __future__ import annotations

import datetime
import threading
from pathlib import Path
from typing import Any, Dict

import pytest
from dateutil.rrule import rrulestr

import caldes_harness as h
import caldes_vobject_fix

P = "/%s" % h.PRINCIPAL

TIME_RANGE_QUERY = (
    '<?xml version="1.0" encoding="utf-8"?>'
    '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">'
    "<D:prop><D:getetag/></D:prop>"
    '<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">'
    '<C:time-range start="20270301T000000Z" end="20270401T000000Z"/>'
    "</C:comp-filter></C:comp-filter></C:filter>"
    "</C:calendar-query>"
)


@pytest.fixture
def live(tmp_path: Path) -> h.InProcessRadicale:
    rad = h.InProcessRadicale(tmp_path)
    rad.initialize(collections=("c",))
    rad.control.set_mode("live")
    return rad


def _report_with_timeout(rad: h.InProcessRadicale, timeout_s: float = 30.0) -> h.Response:
    """REPORT con time-range in un thread: senza la patch resterebbe appesa (il test fallisce, non si blocca)."""
    result: Dict[str, Any] = {}

    def run() -> None:
        try:
            result["response"] = rad.report(P + "/c/", h.PRINCIPAL, TIME_RANGE_QUERY)
        except Exception as exc:  # noqa: BLE001 - riportato sotto
            result["error"] = exc

    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    worker.join(timeout_s)
    assert not worker.is_alive(), "REPORT con time-range appesa (RRULE non controllata)"
    assert "error" not in result, repr(result.get("error"))
    return result["response"]


def test_premessa_dateutil_accetta_interval_zero() -> None:
    # Senza il controllo dateutil costruisce la regola senza errori.
    rule = rrulestr("FREQ=DAILY;INTERVAL=0", dtstart=datetime.datetime(2027, 2, 1, 8))
    assert rule is not None


@pytest.mark.parametrize(
    "rrule",
    [
        "FREQ=DAILY;INTERVAL=0",
        "FREQ=WEEKLY;INTERVAL=00;BYDAY=MO",
        "FREQ=DAILY;INTERVAL=-1",
        "FREQ=DAILY;INTERVAL=+0",
        "FREQ=DAILY;COUNT=0",
        "FREQ=DAILY;COUNT=-3",
        "FREQ=MONTHLY;BYMONTHDAY=0",
        "FREQ=MONTHLY;BYMONTHDAY=32",
        "FREQ=YEARLY;BYYEARDAY=0",
        "FREQ=YEARLY;BYWEEKNO=0",
        "FREQ=YEARLY;BYMONTH=13",
        "FREQ=YEARLY;BYMONTH=0",
    ],
)
def test_put_rifiuta_rrule_vietate(live: h.InProcessRadicale, rrule: str) -> None:
    res = live.put(P + "/c/bad.ics", h.PRINCIPAL, h.event_ics("bad@caldes.test", ["RRULE:" + rrule]))
    assert res.status == 400, res.describe()
    assert not (live.collection_dir("c") / "bad.ics").exists()
    # La collezione resta interrogabile con un time-range.
    assert _report_with_timeout(live).status == 207


def test_exrule_controllata(live: h.InProcessRadicale) -> None:
    res = live.put(P + "/c/bad.ics", h.PRINCIPAL,
                   h.event_ics("bad@caldes.test", ["RRULE:FREQ=DAILY", "EXRULE:FREQ=DAILY;INTERVAL=0"]))
    assert res.status == 400, res.describe()


@pytest.mark.parametrize(
    "rrule",
    [
        "FREQ=WEEKLY;BYDAY=MO,TU,TH,FR",
        "FREQ=DAILY;INTERVAL=2;UNTIL=20271231T000000Z",
        "FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=12",
        "FREQ=YEARLY;BYWEEKNO=-53;BYDAY=MO",
        "FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=25",
        "FREQ=DAILY;INTERVAL=1",
    ],
)
def test_put_accetta_rrule_valide(live: h.InProcessRadicale, rrule: str) -> None:
    res = live.put(P + "/c/ok.ics", h.PRINCIPAL, h.event_ics("ok@caldes.test", ["RRULE:" + rrule]))
    assert res.status == 201, res.describe()
    assert _report_with_timeout(live).status == 207


def test_oggetto_gia_salvato_non_blocca_la_report(live: h.InProcessRadicale) -> None:
    # Un file scritto prima della patch (o fuori da Radicale): Radicale rifà
    # check_and_sanitize_items alla lettura e lo salta come "broken item",
    # quindi la REPORT risponde senza di lui invece di restare appesa.
    ok = live.put(P + "/c/ok.ics", h.PRINCIPAL,
                  h.event_ics("ok@caldes.test", ["RRULE:FREQ=DAILY"], dtstart="DTSTART:20270310T080000Z"))
    assert ok.status == 201, ok.describe()
    target = live.collection_dir("c") / "vecchio.ics"
    target.write_text(h.event_ics("vecchio@caldes.test", ["RRULE:FREQ=DAILY;INTERVAL=0"]), encoding="utf-8")
    res = _report_with_timeout(live)
    assert res.status == 207, res.describe()
    hrefs = set(res.multistatus())
    assert P + "/c/ok.ics" in hrefs and P + "/c/vecchio.ics" not in hrefs, hrefs


def test_check_recurrence_rule() -> None:
    check = caldes_vobject_fix.check_recurrence_rule
    check("FREQ=WEEKLY;BYDAY=MO,TU,TH,FR")
    check("RRULE:FREQ=MONTHLY;BYMONTHDAY=-31,1;BYMONTH=1,12")
    for bad in ("FREQ=DAILY;INTERVAL=0", "RRULE:FREQ=DAILY;INTERVAL=0", "FREQ=DAILY\\;INTERVAL=0",
                "FREQ=DAILY;INTERVAL=1.5", "FREQ=DAILY;INTERVAL=", "FREQ=DAILY;COUNT=1000000000",
                "FREQ=MONTHLY;BYMONTHDAY=1,,2", "FREQ=YEARLY;BYYEARDAY=367"):
        with pytest.raises(caldes_vobject_fix.InvalidRecurrenceRule):
            check(bad)


def test_processo_reale_rifiuta_interval_zero(tmp_path: Path) -> None:
    # Come nell'immagine: la patch arriva da sitecustomize.
    with h.RadicaleProcess(tmp_path) as rad:
        rad.initialize(collections=("c",))
        rad.control.set_mode("live")
        res = rad.put(P + "/c/bad.ics", h.PRINCIPAL, h.event_ics("bad@caldes.test", ["RRULE:FREQ=DAILY;INTERVAL=0"]))
        assert res.status == 400, res.describe() + rad.logs()[-3000:]
        ok = rad.put(P + "/c/ok.ics", h.PRINCIPAL, h.event_ics("ok@caldes.test", ["RRULE:FREQ=DAILY;COUNT=3"]))
        assert ok.status == 201, ok.describe()
