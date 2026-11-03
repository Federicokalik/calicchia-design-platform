"""
Identità del volume (fase F1; design §1 invariante 7, §3.3, §6.3, §16.3;
contratto control-plane §4).

Il marker è la coppia di dead prop `{urn:calicchia:caldes}volume-id` ed
`epoch` nel `.Radicale.props` del principal, scritte solo da caldes-svc con
PROPPATCH. caldes_rights dà permessi ai device sotto il principal solo se il
marker coincide con volume_id ed epoch della policy (cioè di
calendar_backend_state in PG): un volume vuoto, di un altro stack o
ripristinato da uno snapshot precedente all'ultimo cambio di epoch non viene
mai trattato come verità, e i device non vi creano né modificano nulla.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, Tuple

import pytest

import caldes_harness as h
import caldes_rights as cr

P = "/%s" % h.PRINCIPAL
VID = cr.DEAD_PROP_VOLUME_ID
EPOCH = cr.DEAD_PROP_EPOCH


# ─── Parsing del marker ───────────────────────────────────────


@pytest.mark.parametrize(
    ("props", "expected"),
    [
        ({VID: h.VOLUME_ID, EPOCH: "1"}, (h.VOLUME_ID, 1)),
        ({VID: h.VOLUME_ID.upper(), EPOCH: "1"}, (h.VOLUME_ID, 1)),
        ({VID: h.VOLUME_ID, EPOCH: "2147483647"}, (h.VOLUME_ID, 2147483647)),
        ({VID: h.VOLUME_ID, EPOCH: "12", "D:displayname": "Federico", "tag": ""}, (h.VOLUME_ID, 12)),
    ],
)
def test_marker_valido(props: Dict[str, Any], expected: Tuple[str, int]) -> None:
    marker = cr.volume_marker_from_props(props)
    assert marker is not None
    assert (marker.volume_id, marker.epoch) == expected


@pytest.mark.parametrize(
    "props",
    [
        {},
        {VID: h.VOLUME_ID},
        {EPOCH: "1"},
        {VID: h.VOLUME_ID, EPOCH: 1},
        {VID: h.VOLUME_ID, EPOCH: "01"},
        {VID: h.VOLUME_ID, EPOCH: " 1"},
        {VID: h.VOLUME_ID, EPOCH: "1 "},
        {VID: h.VOLUME_ID, EPOCH: "1\n"},
        {VID: h.VOLUME_ID, EPOCH: "0"},
        {VID: h.VOLUME_ID, EPOCH: "-1"},
        {VID: h.VOLUME_ID, EPOCH: "2147483648"},
        {VID: h.VOLUME_ID, EPOCH: "١"},
        {VID: h.VOLUME_ID + "\n", EPOCH: "1"},
        {VID: "3f2b8c1e7d4a4e9b9c2a1b2c3d4e5f60", EPOCH: "1"},
        {VID: "zz2b8c1e-7d4a-4e9b-9c2a-1b2c3d4e5f60", EPOCH: "1"},
        {VID: None, EPOCH: "1"},
        {"{DAV:}volume-id": h.VOLUME_ID, "{DAV:}epoch": "1"},
        [h.VOLUME_ID, "1"],
        None,
    ],
)
def test_marker_invalido_vale_come_assente(props: Any) -> None:
    assert cr.volume_marker_from_props(props) is None


def test_chiavi_del_marker_come_nel_contratto() -> None:
    schema = h.load_contract_schema("volume-identity.schema.json")
    assert set(schema["required"]) == {VID, EPOCH}
    for example in schema["examples"]:
        assert cr.volume_marker_from_props(example) is not None


@pytest.mark.parametrize(
    ("volume_id", "epoch", "marker", "expected"),
    [
        (h.VOLUME_ID, 1, cr.VolumeMarker(h.VOLUME_ID, 1), True),
        (h.VOLUME_ID.upper(), 1, cr.VolumeMarker(h.VOLUME_ID, 1), True),
        (h.VOLUME_ID, 2, cr.VolumeMarker(h.VOLUME_ID, 1), False),
        (h.OTHER_VOLUME_ID, 1, cr.VolumeMarker(h.VOLUME_ID, 1), False),
        (h.VOLUME_ID, 1, None, False),
        (None, 0, cr.VolumeMarker(h.VOLUME_ID, 1), False),
        (h.VOLUME_ID, 0, cr.VolumeMarker(h.VOLUME_ID, 1), False),
    ],
)
def test_confronto_dell_identita(volume_id: Any, epoch: int, marker: Any, expected: bool) -> None:
    assert cr.identity_matches(volume_id, epoch, marker) is expected


# ─── Lettura delle props dal volume ───────────────────────────


def _control(tmp_path: Path) -> Tuple[cr.ControlPlane, h.ControlFiles, Path]:
    files = h.ControlFiles(tmp_path / "control")
    storage = tmp_path / "collections"
    control = cr.ControlPlane(
        policy_file=str(files.policy), heartbeat_file=str(files.heartbeat),
        props_file=str(h.principal_props_path(storage)), principal=h.PRINCIPAL, reload_interval=0,
    )
    files.set_mode("shadow")
    return control, files, storage


def _identity_ok(control: cr.ControlPlane) -> bool:
    control.refresh(force=True)
    return control.evaluate().identity_ok


def test_props_ricaricate_quando_cambiano(tmp_path: Path) -> None:
    control, _, storage = _control(tmp_path)
    assert not _identity_ok(control), "principal assente"
    h.write_marker_file(storage, h.VOLUME_ID, 1)
    assert _identity_ok(control)
    h.write_marker_file(storage, h.OTHER_VOLUME_ID, 1)
    assert not _identity_ok(control)
    h.write_marker_file(storage, h.VOLUME_ID, 1)
    assert _identity_ok(control)
    h.write_marker_file(storage, h.VOLUME_ID, 2)
    assert not _identity_ok(control)


@pytest.mark.parametrize(
    "content",
    [b"{non json", b"[]", b"\xff\xfe{}", b'{"a": ' + b"1" * (1_048_577) + b"}", b""],
    ids=["non-json", "lista", "non-utf8", "oltre-1MiB", "vuoto"],
)
def test_props_illeggibili_identita_falsa(tmp_path: Path, content: bytes) -> None:
    control, _, storage = _control(tmp_path)
    h.write_marker_file(storage, h.VOLUME_ID, 1)
    assert _identity_ok(control)
    h.write_atomic(h.principal_props_path(storage), content)
    assert not _identity_ok(control)


def test_props_come_directory_identita_falsa(tmp_path: Path) -> None:
    control, _, storage = _control(tmp_path)
    h.principal_props_path(storage).mkdir(parents=True)
    assert not _identity_ok(control)


def test_policy_senza_volume_identita_mai_valida(tmp_path: Path) -> None:
    control, files, storage = _control(tmp_path)
    h.write_marker_file(storage, h.VOLUME_ID, 1)
    files.set_mode("shadow", volume_id=None)
    assert not _identity_ok(control), "volume non inizializzato in PG: nessun device sotto il principal"


def test_identita_dall_ultima_policy_valida(tmp_path: Path) -> None:
    control, files, storage = _control(tmp_path)
    h.write_marker_file(storage, h.VOLUME_ID, 1)
    assert _identity_ok(control)
    files.write_policy("{corrotta")
    assert _identity_ok(control), "identità dell'ultima policy valida vista"
    h.write_marker_file(storage, h.OTHER_VOLUME_ID, 1)
    assert not _identity_ok(control)


# ─── Radicale reale ───────────────────────────────────────────


@pytest.fixture
def server(tmp_path: Path) -> h.InProcessRadicale:
    rad = h.InProcessRadicale(tmp_path)
    rad.initialize(collections=("c",))
    return rad


def _tree(root: Path) -> Dict[str, Tuple[int, int]]:
    """Fotografia del volume (percorso → (inode, mtime)) senza le cache e il lock."""
    out: Dict[str, Tuple[int, int]] = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d != ".Radicale.cache"]
        for name in dirnames + filenames:
            if name.startswith(".Radicale.lock") or name.startswith(".Radicale.mtime_test"):
                continue
            path = Path(dirpath) / name
            st = os.stat(path)
            out[str(path.relative_to(root))] = (st.st_ino, st.st_mtime_ns)
    return out


def test_marker_scritto_da_caldes_svc(server: h.InProcessRadicale) -> None:
    props = json.loads(h.principal_props_path(server.storage).read_text(encoding="utf-8"))
    assert props == {VID: h.VOLUME_ID, EPOCH: "1"}
    server.control.set_mode("shadow")
    assert server.rights.control.evaluate().identity_ok
    assert server.propfind(P + "/", h.PRINCIPAL, depth="1").status == 207


def test_volume_id_maiuscolo_nel_marker(server: h.InProcessRadicale) -> None:
    assert server.proppatch(P + "/", h.SERVICE_USER, h.marker_proppatch_body(h.VOLUME_ID.upper(), 1)).status == 207
    server.control.set_mode("shadow")
    assert server.propfind(P + "/", h.PRINCIPAL).status == 207


def test_cambio_di_epoch_prima_su_radicale_poi_in_pg(server: h.InProcessRadicale) -> None:
    # Cutover e rollback (design §13.10, §13.12): epoch + 1 prima sul marker,
    # poi in PG e quindi nella policy; nel mezzo i device non hanno accesso.
    server.control.set_mode("live")
    assert server.put(P + "/c/a.ics", h.PRINCIPAL, h.event_ics("a@caldes.test", ["SUMMARY:A"])).status == 201
    assert server.proppatch(P + "/", h.SERVICE_USER, h.marker_proppatch_body(h.VOLUME_ID, 2)).status == 207
    assert server.propfind(P + "/", h.PRINCIPAL).status == 403
    assert server.get(P + "/c/a.ics", h.PRINCIPAL).status == 403
    # Policy aggiornata ma heartbeat ancora del vecchio epoch: frozen (sola lettura).
    server.control.write_policy(h.policy_doc("live", epoch=2))
    assert server.propfind(P + "/", h.PRINCIPAL).status == 207
    assert server.put(P + "/c/b.ics", h.PRINCIPAL, h.event_ics("b@caldes.test", ["SUMMARY:B"])).status == 403
    server.control.write_heartbeat(h.heartbeat_doc("radicale", epoch=2))
    assert server.put(P + "/c/b.ics", h.PRINCIPAL, h.event_ics("b@caldes.test", ["SUMMARY:B"])).status == 201


def test_snapshot_vecchio_con_epoch_precedente(server: h.InProcessRadicale) -> None:
    # Volume ripristinato da uno snapshot precedente all'ultimo cutover: marker
    # con epoch 1, PG a epoch 3.
    server.control.set_mode("live", epoch=3)
    assert server.propfind("/", h.PRINCIPAL).status == 207
    assert server.propfind(P + "/", h.PRINCIPAL).status == 403


def test_volume_di_un_altro_stack_intatto(tmp_path: Path) -> None:
    rad = h.InProcessRadicale(tmp_path)
    rad.initialize(volume_id=h.OTHER_VOLUME_ID, collections=("c", "f"))
    assert rad.put(P + "/c/x.ics", h.SERVICE_USER, h.event_ics("x@caldes.test", ["SUMMARY:X"])).status == 201
    rad.control.set_mode("live")
    before = _tree(rad.storage)
    attempts = [
        rad.propfind(P + "/", h.PRINCIPAL, depth="1"),
        rad.get(P + "/c/x.ics", h.PRINCIPAL),
        rad.put(P + "/c/x.ics", h.PRINCIPAL, h.event_ics("x@caldes.test", ["SUMMARY:Sovrascritto"])),
        rad.put(P + "/c/y.ics", h.PRINCIPAL, h.event_ics("y@caldes.test", ["SUMMARY:Nuovo"])),
        rad.delete(P + "/c/x.ics", h.PRINCIPAL),
        rad.mkcalendar(P + "/nuova/", h.PRINCIPAL),
        rad.proppatch(P + "/", h.PRINCIPAL, h.marker_proppatch_body(h.VOLUME_ID, 1)),
        rad.propfind(P + "/", h.PROBE_USER),
    ]
    assert [r.status for r in attempts] == [403] * len(attempts)
    assert _tree(rad.storage) == before, "un device ha modificato un volume con identità diversa"


def test_props_corrotte_sul_disco_poi_ripristinate(server: h.InProcessRadicale) -> None:
    server.control.set_mode("shadow")
    assert server.propfind(P + "/", h.PRINCIPAL).status == 207
    h.write_atomic(h.principal_props_path(server.storage), b"{corrotto")
    assert server.propfind(P + "/", h.PRINCIPAL).status == 403
    # Radicale non riesce a leggere le props del principal nemmeno per il
    # servizio (500): il marker non si ripara via CalDAV, si ripristina il
    # file dal backup del volume (runbook di restore, design §16.3).
    assert server.proppatch(P + "/", h.SERVICE_USER, h.marker_proppatch_body(h.VOLUME_ID, 1)).status == 500
    h.write_marker_file(server.storage, h.VOLUME_ID, 1)
    assert server.propfind(P + "/", h.PRINCIPAL).status == 207


def test_principal_cancellato_dal_volume(server: h.InProcessRadicale) -> None:
    server.control.set_mode("live")
    assert server.propfind(P + "/", h.PRINCIPAL).status == 207
    assert server.delete(P + "/", h.SERVICE_USER).status == 403, "caldes-svc non ha D sul principal"
    for path in sorted(server.principal_dir().rglob("*"), reverse=True):
        path.rmdir() if path.is_dir() else path.unlink()
    server.principal_dir().rmdir()
    assert server.propfind(P + "/", h.PRINCIPAL).status == 403
    assert not server.principal_dir().exists(), "il principal non si ricrea al login di un device"
