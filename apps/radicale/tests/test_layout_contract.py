"""
Contratto del layout su disco di Radicale 3.7.8 (fase F1, piano: "contratto
del layout"; design §6.1-§6.3, §16.1; contratto control-plane §1.1 e §4).

L'API legge il volume di Radicale in sola lettura e ci costruisce sopra il
campanello (stat delle directory), il controllo d'identità (props del
principal) e il backup (tar sotto flock): questi test fissano le proprietà su
cui fa affidamento, così un aggiornamento di Radicale che le cambia rompe la
CI invece della produzione.

- `.Radicale.props` del principal e delle collezioni: JSON, dead prop in
  notazione Clark con valori stringa, proprietà note abbreviate;
- percorsi: `<filesystem_folder>/collection-root/<principal>/<collezione>/<href>`,
  file dell'oggetto = corpo della GET, ETag = sha256 del file;
- mtime delle directory: cambia a ogni scrittura (MKCALENDAR, PUT, PROPPATCH,
  MOVE, DELETE) e non con le letture (GET, PROPFIND, REPORT);
- cache in `.Radicale.cache` dentro la collezione (esclusa dal backup);
- lock globale `<filesystem_folder>/.Radicale.lock` compatibile con flock: lo
  script di backup che lo tiene in condiviso blocca le scritture;
- item rotto su disco con skip_broken_item: la collezione resta leggibile e la
  sync-collection lo riporta come 404 pur esistendo il file.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import threading
import time
from pathlib import Path
from typing import Dict, Optional

import pytest

import caldes_harness as h
import caldes_rights as cr

P = "/%s" % h.PRINCIPAL
CALENDAR_ID = "6c1f9a52-3b7e-4d21-9f0a-8e5d4c3b2a19"


@pytest.fixture
def live(tmp_path: Path) -> h.InProcessRadicale:
    rad = h.InProcessRadicale(tmp_path)
    rad.initialize(collections=())
    rad.control.set_mode("live")
    return rad


def _event(uid: str, summary: str = "Evento") -> str:
    return h.event_ics(uid, ["SUMMARY:" + summary])


# ─── .Radicale.props ──────────────────────────────────────────


def test_props_del_principal_con_il_marker(live: h.InProcessRadicale) -> None:
    path = h.principal_props_path(live.storage)
    assert path == live.principal_dir() / ".Radicale.props"
    props = json.loads(path.read_text(encoding="utf-8"))
    assert props == {
        "{urn:calicchia:caldes}volume-id": h.VOLUME_ID,
        "{urn:calicchia:caldes}epoch": "1",
    }
    assert cr.volume_marker_from_props(props) == cr.VolumeMarker(h.VOLUME_ID, 1)
    # Le stesse chiavi del contratto (volume-identity.schema.json e types.ts).
    schema = h.load_contract_schema("volume-identity.schema.json")
    assert set(schema["required"]) == {cr.DEAD_PROP_VOLUME_ID, cr.DEAD_PROP_EPOCH}
    for key in schema["required"]:
        assert re.fullmatch(schema["properties"][key]["pattern"], props[key])


def test_props_di_una_collezione_con_le_dead_prop(live: h.InProcessRadicale) -> None:
    body = h.mkcalendar_body("Festività", calendar_id=CALENDAR_ID, role="holidays", color="#FF2968FF")
    assert live.mkcalendar(P + "/f/", h.SERVICE_USER, body).status == 201
    props = json.loads((live.collection_dir("f") / ".Radicale.props").read_text(encoding="utf-8"))
    assert props["tag"] == "VCALENDAR"
    assert props["D:displayname"] == "Festività"
    assert props["ICAL:calendar-color"] == "#FF2968FF"
    assert props["{urn:calicchia:caldes}calendar-id"] == CALENDAR_ID
    assert props["{urn:calicchia:caldes}role"] == "holidays"
    assert all(isinstance(value, str) for value in props.values())
    # La discovery (F2) le legge con PROPFIND come caldes-svc.
    propfind = (
        '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:" xmlns:K="urn:calicchia:caldes">'
        "<D:prop><K:calendar-id/><K:role/><D:displayname/></D:prop></D:propfind>"
    )
    found = live.propfind(P + "/", h.SERVICE_USER, depth="1", body=propfind).multistatus()[P + "/f/"]["props"]
    assert found["{urn:calicchia:caldes}calendar-id"] == CALENDAR_ID
    assert found["{urn:calicchia:caldes}role"] == "holidays"


# ─── Percorsi, file ed ETag ───────────────────────────────────


def test_percorso_contenuto_ed_etag_dell_oggetto(live: h.InProcessRadicale) -> None:
    assert live.mkcalendar(P + "/c/", h.SERVICE_USER).status == 201
    res = live.put(P + "/c/a.ics", h.PRINCIPAL, _event("a@caldes.test", "Pranzo, cena"))
    assert res.status == 201
    path = live.storage / "collection-root" / h.PRINCIPAL / "c" / "a.ics"
    assert path.is_file()
    raw = path.read_bytes()
    body = live.get(P + "/c/a.ics", h.PRINCIPAL)
    assert body.body == raw
    assert body.header("ETag") == res.header("ETag") == '"%s"' % hashlib.sha256(raw).hexdigest()
    assert b"SUMMARY:Pranzo\\, cena" in raw


def test_cache_dentro_la_collezione(live: h.InProcessRadicale) -> None:
    assert live.mkcalendar(P + "/c/", h.SERVICE_USER).status == 201
    assert live.put(P + "/c/a.ics", h.PRINCIPAL, _event("a@caldes.test")).status == 201
    assert live.report(P + "/c/", h.PRINCIPAL, h.sync_collection_body()).status == 207
    cache = live.collection_dir("c") / ".Radicale.cache"
    assert (cache / "item" / "a.ics").is_file()
    assert (cache / "sync-token").is_dir()
    # Nessuna cache fuori dalle collezioni (use_cache_subfolder_* = False).
    assert not (live.storage / "collection-cache").exists()
    entries = sorted(p.name for p in live.storage.iterdir())
    assert entries == [".Radicale.lock", "collection-root"]


# ─── mtime delle directory (campanello dell'API) ──────────────


def test_mtime_cambia_solo_con_le_scritture(live: h.InProcessRadicale) -> None:
    watch = h.DirWatch({
        "principal": live.principal_dir(),
        "lav": live.collection_dir("lav"),
        "per": live.collection_dir("per"),
    })
    _, changed = watch.changed_by(lambda: live.mkcalendar(P + "/lav/", h.PRINCIPAL))
    assert changed == ["lav", "principal"]
    assert live.mkcalendar(P + "/per/", h.PRINCIPAL).status == 201

    res, changed = watch.changed_by(lambda: live.put(P + "/lav/a.ics", h.PRINCIPAL, _event("a@caldes.test")))
    assert res.status == 201 and changed == ["lav"]
    etag = res.header("ETag")

    reads = {
        "GET": lambda: live.get(P + "/lav/a.ics", h.PRINCIPAL),
        "PROPFIND Depth:1": lambda: live.propfind(P + "/lav/", h.PRINCIPAL, depth="1"),
        "PROPFIND principal": lambda: live.propfind(P + "/", h.PRINCIPAL, depth="1"),
        "REPORT sync-collection": lambda: live.report(P + "/lav/", h.PRINCIPAL, h.sync_collection_body()),
        "REPORT multiget": lambda: live.report(P + "/lav/", h.PRINCIPAL, h.multiget_body([P + "/lav/a.ics"])),
        "GET di nuovo": lambda: live.get(P + "/lav/a.ics", h.PRINCIPAL),
    }
    for label, action in reads.items():
        res, changed = watch.changed_by(action)
        assert res.status in (200, 207), label
        assert changed == [], "%s ha cambiato la mtime di %s" % (label, changed)

    writes = [
        ("PUT update (If-Match)", lambda: live.put(P + "/lav/a.ics", h.PRINCIPAL, _event("a@caldes.test", "Due"),
                                                   if_match=etag), ["lav"]),
        ("PROPPATCH collezione", lambda: live.proppatch(P + "/lav/", h.PRINCIPAL, (
            '<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:"><D:set><D:prop>'
            "<D:displayname>Lavoro</D:displayname></D:prop></D:set></D:propertyupdate>")), ["lav"]),
        ("MOVE lav→per", lambda: live.move(P + "/lav/a.ics", P + "/per/a.ics", h.PRINCIPAL), ["lav", "per"]),
        ("DELETE oggetto", lambda: live.delete(P + "/per/a.ics", h.PRINCIPAL), ["per"]),
        ("PROPPATCH principal (marker)", lambda: live.proppatch(P + "/", h.SERVICE_USER,
                                                                h.marker_proppatch_body(h.VOLUME_ID, 1)),
         ["principal"]),
    ]
    for label, action, expected in writes:
        res, changed = watch.changed_by(action)
        assert res.status in (200, 201, 204, 207), "%s: %s" % (label, res.describe())
        assert changed == expected, "%s: %s invece di %s" % (label, changed, expected)


def test_mtime_dei_file_props_del_principal(live: h.InProcessRadicale) -> None:
    # Il controllo d'identità dell'API ricarica le props quando cambiano: ogni
    # PROPPATCH le riscrive con rename (inode nuovo), le letture no.
    path = h.principal_props_path(live.storage)
    before = os.stat(path)
    assert live.propfind(P + "/", h.PRINCIPAL, depth="1").status == 207
    assert os.stat(path).st_ino == before.st_ino
    h.wait_for_mtime_tick()
    assert live.proppatch(P + "/", h.SERVICE_USER, h.marker_proppatch_body(h.VOLUME_ID, 2)).status == 207
    after = os.stat(path)
    assert (after.st_ino, after.st_mtime_ns) != (before.st_ino, before.st_mtime_ns)
    assert cr.volume_marker_from_props(json.loads(path.read_text(encoding="utf-8"))).epoch == 2


# ─── Item rotto (skip_broken_item) ────────────────────────────


def test_item_rotto_404_nella_sync_ma_file_presente(live: h.InProcessRadicale) -> None:
    assert live.mkcalendar(P + "/c/", h.SERVICE_USER).status == 201
    assert live.put(P + "/c/buono.ics", h.PRINCIPAL, _event("buono@caldes.test")).status == 201
    assert live.put(P + "/c/rotto.ics", h.PRINCIPAL, _event("rotto@caldes.test")).status == 201
    initial = live.report(P + "/c/", h.PRINCIPAL, h.sync_collection_body())
    token = re.search(r"<sync-token>([^<]+)</sync-token>", initial.text)
    assert token, initial.text
    broken = live.collection_dir("c") / "rotto.ics"
    h.wait_for_mtime_tick()
    broken.write_bytes(b"BEGIN:VCALENDAR\r\nquesto non e' un iCalendar\r\n")
    res = live.report(P + "/c/", h.PRINCIPAL, h.sync_collection_body(token.group(1)))
    assert res.status == 207, res.describe()
    entries = res.multistatus()
    assert entries.get(P + "/c/rotto.ics", {}).get("status") == 404, entries
    assert broken.is_file(), "l'indicizzatore distingue questo 404 da una cancellazione controllando il file"
    listing = live.propfind(P + "/c/", h.PRINCIPAL, depth="1")
    assert listing.status == 207
    assert P + "/c/buono.ics" in listing.multistatus()


# ─── Lock globale (backup) ────────────────────────────────────


def test_lock_globale_compatibile_con_flock(tmp_path: Path) -> None:
    # scripts/backup-calendar-stack.sh fa il tar del volume sotto
    # `flock -s <filesystem_folder>/.Radicale.lock`: Radicale prende lo stesso
    # lock (flock) in esclusiva per scrivere, quindi le scritture aspettano.
    with h.RadicaleProcess(tmp_path) as rad:
        rad.initialize(collections=("c",))
        rad.control.set_mode("live")
        lock_path = rad.storage / ".Radicale.lock"
        assert lock_path.is_file()
        result: Dict[str, Optional[int]] = {"status": None}

        def writer() -> None:
            result["status"] = rad.put(P + "/c/durante-il-backup.ics", h.PRINCIPAL,
                                       _event("backup@caldes.test")).status

        with open(lock_path, "r") as handle:
            fcntl.flock(handle.fileno(), fcntl.LOCK_SH)
            thread = threading.Thread(target=writer)
            thread.start()
            time.sleep(0.5)
            assert result["status"] is None, "la PUT non ha atteso il lock condiviso del backup"
            # Le letture invece passano anche durante il backup (lock condiviso).
            assert rad.propfind(P + "/c/", h.PRINCIPAL, depth="1").status == 207
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        thread.join(timeout=10)
        assert result["status"] == 201
