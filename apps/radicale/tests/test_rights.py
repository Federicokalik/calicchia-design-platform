"""
Test di caldes_rights (fase F1, piano: "pytest rights").

- Conformità ai casi condivisi del contratto, eseguiti sul plugin reale con i
  file veri: modalità effettiva (fixtures/effective-mode.cases.json) e
  permessi (fixtures/rights-matrix.cases.json, gli stessi che i test TS
  eseguono su effectiveDeviceMode() ed expectedRadicaleRights()).
- Regole dei lettori che Python rischia di sbagliare (booleani come interi,
  NaN, '$' con a capo, cifre Unicode, BOM, dimensione).
- Radicale 3.7.8 reale in memoria con il config di produzione: shadow, live
  e frozen; policy corrotta → sola lettura; heartbeat assente o scaduto →
  frozen; marker assente o diverso → 403 e nessuna directory creata; nessun W
  su /iphone/ né su /caldes-svc/; DELETE di una collezione negato ai device.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Dict

import pytest

import caldes_harness as h
import caldes_rights as cr

EFFECTIVE = h.load_fixture("effective-mode.cases.json")
MATRIX = h.load_fixture("rights-matrix.cases.json")


# ─── Casi condivisi: modalità effettiva ───────────────────────


def _file_content(case: Dict[str, Any], key: str) -> h.FileContent:
    """Contenuto del file per un caso: testo verbatim, oggetto JSON o nessun file."""
    text = case.get(key + "_text")
    if text is not None:
        return text
    value = case.get(key)
    return None if value is None else value


def _control_plane(tmp_path: Path) -> cr.ControlPlane:
    files = h.ControlFiles(tmp_path / "control")
    return cr.ControlPlane(
        policy_file=str(files.policy),
        heartbeat_file=str(files.heartbeat),
        props_file=str(h.principal_props_path(tmp_path / "collections")),
        principal=EFFECTIVE["principal"],
        reload_interval=0,
    )


@pytest.mark.parametrize("case", EFFECTIVE["cases"], ids=[c["name"] for c in EFFECTIVE["cases"]])
def test_modalita_effettiva_casi_condivisi(tmp_path: Path, case: Dict[str, Any]) -> None:
    files = h.ControlFiles(tmp_path / "control")
    control = _control_plane(tmp_path)
    now = cr.parse_timestamp_ms(case["now"])
    if case["last_known_good"] is not None:
        # Il processo ha già visto questa policy valida prima del caso.
        files.write_policy(case["last_known_good"])
        files.write_heartbeat(None)
        control.refresh(force=True)
        assert control.evaluate(now_ms=now).effective.volume_id == case["last_known_good"]["volume_id"]
    files.write_policy(_file_content(case, "policy"))
    files.write_heartbeat(_file_content(case, "heartbeat"))
    control.refresh(force=True)
    effective = control.evaluate(now_ms=now).effective
    expected = case["expected"]
    assert effective.mode == expected["mode"]
    assert set(effective.reasons) == set(expected["reasons"])
    assert list(effective.reasons) == [r for r in cr.EFFECTIVE_MODE_REASONS if r in effective.reasons]
    assert effective.volume_id == expected["volume_id"]
    assert effective.epoch == expected["epoch"]
    assert cr.CANARY_COLLECTION in effective.hidden


def test_i_casi_condivisi_coprono_tutti_i_motivi() -> None:
    seen = {r for c in EFFECTIVE["cases"] for r in c["expected"]["reasons"]}
    assert seen == set(cr.EFFECTIVE_MODE_REASONS)


# ─── Casi condivisi: matrice dei permessi ─────────────────────


def _rights_for_context(tmp_path: Path, name: str, monkeypatch: pytest.MonkeyPatch) -> cr.Rights:
    """Un Rights reale con policy, heartbeat e props che producono il contesto `name`."""
    ctx = MATRIX["contexts"][name]
    root = tmp_path / name
    files = h.ControlFiles(root / "control")
    storage = root / "collections"
    backend = h.BACKEND_FOR_MODE[ctx["mode"]]
    files.write_policy(h.policy_doc(ctx["mode"], backend_mode=backend, readonly=ctx["readonly"], hidden=ctx["hidden"],
                                    principal=ctx["principal"]))
    files.write_heartbeat(h.heartbeat_doc(backend))
    if ctx["identity_ok"]:
        h.write_marker_file(storage, h.VOLUME_ID, 1, principal=ctx["principal"])
    else:
        # Volume di un altro stack: marker presente ma diverso.
        h.write_marker_file(storage, h.OTHER_VOLUME_ID, 1, principal=ctx["principal"])
    configuration = h.radicale_config.load([(str(h.CONFIG_FILE), False)])
    configuration.update({
        "rights": {
            "caldes_policy_file": str(files.policy),
            "caldes_heartbeat_file": str(files.heartbeat),
            "caldes_reload_interval": "0",
        },
        "storage": {"filesystem_folder": str(storage)},
    }, "test")
    monkeypatch.setenv("RADICALE_PRINCIPAL", ctx["principal"])
    rights = cr.Rights(configuration)
    evaluation = rights.control.evaluate()
    assert evaluation.effective.mode == ctx["mode"], evaluation
    assert evaluation.identity_ok is ctx["identity_ok"], evaluation
    return rights


@pytest.mark.parametrize("context", sorted(MATRIX["contexts"]))
def test_matrice_dei_permessi_casi_condivisi(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, context: str) -> None:
    rights = _rights_for_context(tmp_path, context, monkeypatch)
    cases = [c for c in MATRIX["cases"] if c["context"] == context]
    assert cases
    failures = []
    for case in cases:
        # Radicale passa sia path ripuliti sia path con le barre ('/federico/c/').
        for path in (case["path"], "/" + case["path"] + ("/" if case["path"] else "")):
            actual = rights.authorization(case["user"], path)
            if actual != case["expected"]:
                failures.append((case["user"], path, actual, case["expected"]))
    assert not failures, failures


def test_la_matrice_copre_il_prodotto_completo() -> None:
    expected = len(MATRIX["contexts"]) * len(MATRIX["users"]) * len(MATRIX["paths"])
    assert len(MATRIX["cases"]) == expected
    combos = {(c["context"], c["user"], c["path"]) for c in MATRIX["cases"]}
    assert len(combos) == expected


# ─── Regole dei lettori (dettagli di Python) ──────────────────


def _policy_bytes(**changes: Any) -> bytes:
    doc = h.policy_doc("shadow")
    doc.update(changes)
    return json.dumps(doc).encode("utf-8")


def _parse_policy(data: bytes) -> cr.Policy:
    return cr.parse_policy(cr.decode_control_file(data), h.PRINCIPAL)


@pytest.mark.parametrize(
    "data",
    [
        _policy_bytes(schema=True),
        _policy_bytes(version=True),
        _policy_bytes(epoch=False, volume_id=None),
        _policy_bytes(credential_epoch=-1),
        _policy_bytes(credential_epoch=2_147_483_648),
        _policy_bytes(version=1.5),
        _policy_bytes(principal="caldes-svc"),
        _policy_bytes(principal="Federico"),
        _policy_bytes(volume_id="3F2B8C1E-7D4A-4E9B-9C2A-1B2C3D4E5F60\n"),
        _policy_bytes(volume_id="３f2b8c1e-7d4a-4e9b-9c2a-1b2c3d4e5f60"),
        _policy_bytes(generated_at="2026-10-09T18:00:00.000Z\n"),
        _policy_bytes(generated_at="2026-10-09T18:00:00"),
        _policy_bytes(generated_at="٢026-10-09T18:00:00.000Z"),
        _policy_bytes(readonly=["a/b"]),
        _policy_bytes(readonly=[".nascosta"]),
        _policy_bytes(hidden=["con\u0085controllo"]),
        _policy_bytes(readonly="bookings"),
        _policy_bytes(reasons=[1]),
        b'{"schema": 1, "version": NaN}',
        b"\xef\xbb\xbf" + _policy_bytes(),
        b"\xff\xfe" + _policy_bytes(),
        _policy_bytes(readonly=["x" * 60_000, "y" * 6_000]),
        b"[" * 32_000 + b"]" * 32_000,
    ],
    ids=[
        "schema-booleano", "version-booleano", "epoch-booleano", "credential-negativo", "credential-oltre-int32",
        "version-non-intera", "principal-riservato", "principal-maiuscolo", "uuid-con-a-capo", "uuid-cifra-unicode",
        "timestamp-con-a-capo", "timestamp-senza-fuso", "timestamp-cifra-unicode", "nome-con-barra",
        "nome-con-punto", "nome-con-controllo-c1", "lista-non-array", "reason-non-stringa", "nan", "bom",
        "non-utf8", "oltre-64KiB", "annidamento-patologico",
    ],
)
def test_policy_invalida(data: bytes) -> None:
    with pytest.raises(cr.ControlFileError):
        _parse_policy(data)


def test_policy_valida_normalizza_e_ignora_campi_sconosciuti() -> None:
    policy = _parse_policy(_policy_bytes(
        volume_id=h.VOLUME_ID.upper(), version=3.0, futuro={"x": 1},
        reasons=["identity_mismatch", "codice_sconosciuto"], readonly=["f", "bookings", "f"],
    ))
    assert policy.volume_id == h.VOLUME_ID
    assert policy.version == 3
    assert policy.reasons == ("identity_mismatch",)
    assert policy.readonly == frozenset({"f", "bookings"})


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("2026-10-09T18:00:00.000Z", 1791568800000),
        ("2026-10-09T18:00:00Z", 1791568800000),
        ("2026-10-09T18:00:00.5Z", 1791568800500),
        ("2026-10-09T18:00:00.123456789Z", 1791568800123),
        ("2026-10-09T20:00:00.000+02:00", 1791568800000),
        ("2026-10-09T16:30:00.000-01:30", 1791568800000),
        ("2028-02-29T00:00:00.000Z", 1835395200000),
    ],
)
def test_timestamp_validi(text: str, expected: int) -> None:
    assert cr.parse_timestamp_ms(text) == expected


@pytest.mark.parametrize(
    "text",
    [
        "2026-09-31T00:00:00.000Z", "2027-02-29T00:00:00.000Z", "2026-10-09T24:00:00.000Z",
        "2026-10-09T18:60:00.000Z", "2026-10-09T18:00:60.000Z", "2026-10-09T18:00:00.000+24:00",
        "2026-10-09T18:00:00.000+02:60", "2026-10-09 18:00:00.000Z", "2026-10-09T18:00:00.0000000000Z",
        "0099-01-01T00:00:00.000Z", "2026-10-09T18:00:00.000z", "", None, 1791568800000,
    ],
)
def test_timestamp_invalidi(text: Any) -> None:
    with pytest.raises(cr.ControlFileError):
        cr.parse_timestamp_ms(text)


def test_heartbeat_invalido_per_api_version_e_epoch() -> None:
    for change in ({"api_version": "con spazio"}, {"api_version": ""}, {"api_version": "x" * 65},
                   {"api_version": "è"}, {"epoch": -1}, {"epoch": True}, {"mode": "live"}, {"schema": 2}):
        doc = h.heartbeat_doc("postgres")
        doc.update(change)
        with pytest.raises(cr.ControlFileError):
            cr.parse_heartbeat(doc)


def test_eta_del_heartbeat_valutata_a_ogni_chiamata(tmp_path: Path) -> None:
    files = h.ControlFiles(tmp_path / "control")
    control = _control_plane(tmp_path)
    files.write_policy(h.policy_doc("live"))
    files.write_heartbeat({"schema": 1, "api_version": "sha-x", "mode": "radicale", "epoch": 1,
                           "ts": "2026-10-09T18:00:00.000Z"})
    control.refresh(force=True)
    base = cr.parse_timestamp_ms("2026-10-09T18:00:00.000Z")
    assert control.evaluate(now_ms=base + 600_000).effective.mode == "live"
    # Nessuna rilettura dei file in mezzo: è l'orologio a far scadere il heartbeat.
    frozen = control.evaluate(now_ms=base + 600_001).effective
    assert frozen.mode == "frozen" and frozen.reasons == ("heartbeat_stale",)


def test_ricontrollo_al_massimo_ogni_intervallo(tmp_path: Path) -> None:
    files = h.ControlFiles(tmp_path / "control")
    clock = {"t": 1000.0}
    control = cr.ControlPlane(
        policy_file=str(files.policy), heartbeat_file=str(files.heartbeat),
        props_file=str(h.principal_props_path(tmp_path / "collections")), principal=h.PRINCIPAL,
        reload_interval=1.0, monotonic=lambda: clock["t"],
    )
    files.set_mode("shadow")
    control.refresh(force=True)
    assert control.evaluate().effective.mode == "shadow"
    files.write_heartbeat(None)
    clock["t"] += 0.5
    assert control.evaluate().effective.mode == "shadow", "riletto prima dell'intervallo"
    clock["t"] += 0.6
    assert control.evaluate().effective.reasons == ("heartbeat_missing",)


def test_file_riletto_anche_con_stessa_dimensione(tmp_path: Path) -> None:
    files = h.ControlFiles(tmp_path / "control")
    control = _control_plane(tmp_path)
    files.write_policy(h.policy_doc("shadow", readonly=["aaaa"]))
    files.write_heartbeat(h.heartbeat_doc("postgres"))
    control.refresh(force=True)
    assert control.evaluate().effective.readonly == frozenset({"aaaa"})
    files.write_policy(h.policy_doc("shadow", readonly=["bbbb"]))
    control.refresh(force=True)
    assert control.evaluate().effective.readonly == frozenset({"bbbb"})


# ─── Configurazione ───────────────────────────────────────────


def _configuration(tmp_path: Path, **rights: str) -> Any:
    configuration = h.radicale_config.load([(str(h.CONFIG_FILE), False)])
    values = {"caldes_policy_file": str(tmp_path / "p.json"), "caldes_heartbeat_file": str(tmp_path / "h.json")}
    values.update(rights)
    configuration.update({"rights": values, "storage": {"filesystem_folder": str(tmp_path / "c")}}, "test")
    return configuration


@pytest.mark.parametrize("principal", [None, "", "caldes-svc", "Federico", "con/barra", "x" * 65])
def test_principal_assente_o_invalido_blocca_il_caricamento(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, principal: Any
) -> None:
    if principal is None:
        monkeypatch.delenv("RADICALE_PRINCIPAL", raising=False)
    else:
        monkeypatch.setenv("RADICALE_PRINCIPAL", principal)
    with pytest.raises(cr.CaldesRightsConfigError):
        cr.Rights(_configuration(tmp_path))


@pytest.mark.parametrize(
    "rights",
    [{"caldes_policy_file": "relativo/policy.json"}, {"caldes_reload_interval": "-1"},
     {"caldes_reload_interval": "abc"}, {"caldes_reload_interval": "61"}, {"caldes_reload_interval": "nan"}],
)
def test_opzioni_invalide_bloccano_il_caricamento(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, rights: Dict[str, str]
) -> None:
    monkeypatch.setenv("RADICALE_PRINCIPAL", h.PRINCIPAL)
    with pytest.raises(cr.CaldesRightsConfigError):
        cr.Rights(_configuration(tmp_path, **rights))


def test_default_delle_opzioni(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RADICALE_PRINCIPAL", h.PRINCIPAL)
    configuration = h.radicale_config.load()
    configuration.update({"rights": {"type": "caldes_rights"},
                          "storage": {"filesystem_folder": str(tmp_path / "c")}}, "test")
    rights = cr.Rights(configuration)
    assert rights.control.policy_file == "/control/policy.json"
    assert rights.control.heartbeat_file == "/control/heartbeat.json"
    assert rights.control.reload_interval == 1.0
    assert rights.control.props_file == str(tmp_path / "c" / "collection-root" / h.PRINCIPAL / ".Radicale.props")


def test_errore_inatteso_nessun_permesso_sotto_il_principal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    rights = _rights_for_context(tmp_path, "live", monkeypatch)
    assert rights.authorization(h.PRINCIPAL, "federico/c") == "rw"

    def boom(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("guasto simulato")

    monkeypatch.setattr(cr, "effective_device_mode", boom)
    assert rights.authorization(h.PRINCIPAL, "federico/c") == ""
    assert rights.authorization(h.PRINCIPAL, "federico") == ""
    assert rights.authorization(h.PRINCIPAL, "") == "R"
    assert rights.authorization(h.SERVICE_USER, "federico/c") == "rwD"


def test_eventi_di_log_sulle_transizioni(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO, logger="radicale")
    rights = _rights_for_context(tmp_path, "live", monkeypatch)
    files = h.ControlFiles(tmp_path / "live" / "control")
    caplog.clear()
    for _ in range(3):
        files.write_policy("{non json")
        rights.authorization(h.PRINCIPAL, "federico/c")
    events = [json.loads(r.getMessage().split(" ", 1)[1]) for r in caplog.records
              if r.getMessage().startswith("caldes_event ")]
    invalid = [e for e in events if e["event"] == "policy_invalid"]
    changed = [e for e in events if e["event"] == "effective_mode_changed"]
    assert len(invalid) == 1 and invalid[0]["reason"] == "JSON non valido"
    assert len(changed) == 1 and changed[0]["mode"] == "shadow" and changed[0]["reasons"] == ["policy_invalid"]
    assert all(r.levelno == logging.WARNING for r in caplog.records if r.getMessage().startswith("caldes_event "))


# ─── Radicale reale in memoria ────────────────────────────────

P = "/%s" % h.PRINCIPAL
EVENT = h.event_ics("evento-1@caldes.test", ["SUMMARY:Riunione"])


@pytest.fixture
def server(tmp_path: Path) -> h.InProcessRadicale:
    """Radicale con il volume inizializzato da caldes-svc (marker, collezioni, un evento in c)."""
    rad = h.InProcessRadicale(tmp_path)
    rad.initialize()
    res = rad.put(P + "/c/esistente.ics", h.SERVICE_USER, h.event_ics("esistente@caldes.test", ["SUMMARY:Esistente"]))
    assert res.status == 201, res.describe()
    return rad


def _put(server: h.InProcessRadicale, collection: str, name: str = "nuovo", user: str = h.PRINCIPAL) -> int:
    uid = "%s-%s@caldes.test" % (collection.strip("_"), name)
    return server.put("%s/%s/%s.ics" % (P, collection, name), user, h.event_ics(uid, ["SUMMARY:Nuovo"])).status


def test_volume_vuoto_device_403_e_nessuna_directory(tmp_path: Path) -> None:
    rad = h.InProcessRadicale(tmp_path)
    # Nessuna policy vista dal processo.
    assert rad.propfind("/", h.PRINCIPAL).status == 207
    assert rad.propfind("/", h.PROBE_USER).status == 207
    assert rad.propfind(P + "/", h.PRINCIPAL).status == 403
    assert rad.mkcalendar(P + "/c/", h.PRINCIPAL).status == 403
    # Policy di un volume non inizializzato (F1 prima del wizard).
    rad.control.set_mode("shadow", volume_id=None)
    assert rad.propfind(P + "/", h.PRINCIPAL, depth="1").status == 403
    # Policy con un'identità, ma volume vuoto (marker assente).
    rad.control.set_mode("live")
    assert rad.propfind(P + "/", h.PRINCIPAL).status == 403
    assert rad.mkcol(P + "/", h.PRINCIPAL).status == 403
    assert rad.mkcalendar(P + "/c/", h.PRINCIPAL).status == 403
    assert rad.put(P + "/c/x.ics", h.PRINCIPAL, EVENT).status == 403
    assert not rad.principal_dir().exists()
    assert list((rad.storage / "collection-root").iterdir()) == []


def test_inizializzazione_solo_da_caldes_svc(tmp_path: Path) -> None:
    rad = h.InProcessRadicale(tmp_path)
    rad.control.set_mode("shadow")
    assert rad.mkcol(P + "/", h.PROBE_USER).status == 403
    assert rad.mkcol(P + "/", h.SERVICE_USER).status == 201
    assert rad.propfind(P + "/", h.PRINCIPAL).status == 403, "principal senza marker"
    assert rad.proppatch(P + "/", h.PRINCIPAL, h.marker_proppatch_body(h.VOLUME_ID, 1)).status == 403
    assert rad.proppatch(P + "/", h.SERVICE_USER, h.marker_proppatch_body(h.VOLUME_ID, 1)).status == 207
    assert rad.propfind(P + "/", h.PRINCIPAL).status == 207
    assert rad.mkcalendar(P + "/c/", h.PRINCIPAL).status == 403, "MKCALENDAR del device in shadow"
    assert rad.mkcalendar(P + "/c/", h.SERVICE_USER).status == 201


def test_shadow_sola_lettura(server: h.InProcessRadicale) -> None:
    server.control.set_mode("shadow")
    listing = server.propfind(P + "/", h.PRINCIPAL, depth="1")
    assert listing.status == 207
    assert set(listing.multistatus()) == {P + "/", P + "/c/", P + "/f/", P + "/bookings/", P + "/scadenze/",
                                          P + "/sub-abc/"}
    assert server.get(P + "/c/esistente.ics", h.PRINCIPAL).status == 200
    assert server.report(P + "/c/", h.PRINCIPAL, h.sync_collection_body()).status == 207
    assert _put(server, "c") == 403
    assert server.delete(P + "/c/esistente.ics", h.PRINCIPAL).status == 403
    assert server.mkcalendar(P + "/nuova/", h.PRINCIPAL).status == 403
    assert server.proppatch(P + "/c/", h.PRINCIPAL, h.marker_proppatch_body(h.VOLUME_ID, 1)).status == 403
    assert server.move(P + "/c/esistente.ics", P + "/scadenze/esistente.ics", h.PRINCIPAL).status == 403
    assert not server.collection_dir("nuova").exists()


def test_live_scrittura_con_le_collezioni_protette(server: h.InProcessRadicale) -> None:
    server.control.set_mode("live")
    assert _put(server, "c") == 201
    for protected in ("f", "bookings", "scadenze", "sub-abc"):
        assert _put(server, protected) == 403, protected
    for hidden in ("sub-new", "_canary", "_altro"):
        assert _put(server, hidden) == 403, hidden
        assert server.propfind("%s/%s/" % (P, hidden), h.PRINCIPAL).status == 403
    assert server.mkcalendar(P + "/nuova/", h.PRINCIPAL).status == 201
    assert server.mkcalendar(P + "/_sistema/", h.PRINCIPAL).status == 403
    assert server.delete(P + "/c/esistente.ics", h.PRINCIPAL).status == 200
    listing = server.propfind(P + "/", h.PRINCIPAL, depth="1").multistatus()
    assert P + "/nuova/" in listing and P + "/_canary/" not in listing and P + "/sub-new/" not in listing


def test_delete_di_una_collezione_negato_ai_device(server: h.InProcessRadicale) -> None:
    server.control.set_mode("live")
    for name in ("c", "f", "bookings"):
        assert server.delete("%s/%s/" % (P, name), h.PRINCIPAL).status == 403, name
        assert server.collection_dir(name).is_dir()
    assert server.mkcalendar(P + "/temporanea/", h.PRINCIPAL).status == 201
    assert server.delete(P + "/temporanea/", h.PRINCIPAL).status == 403
    assert server.delete(P + "/", h.PRINCIPAL).status == 403
    assert server.principal_dir().is_dir()
    # caldes-svc ha D sulle collezioni (non sul principal).
    assert server.delete(P + "/temporanea/", h.SERVICE_USER).status == 200
    assert not server.collection_dir("temporanea").exists()
    assert server.delete(P + "/", h.SERVICE_USER).status == 403


def test_frozen_dalla_policy(server: h.InProcessRadicale) -> None:
    server.control.set_mode("frozen")
    assert server.propfind(P + "/", h.PRINCIPAL, depth="1").status == 207
    assert server.get(P + "/c/esistente.ics", h.PRINCIPAL).status == 200
    assert _put(server, "c") == 403
    assert server.mkcalendar(P + "/nuova/", h.PRINCIPAL).status == 403


@pytest.mark.parametrize(
    ("label", "kwargs"),
    [
        ("scaduto", {"heartbeat_offset_s": -601}),
        ("futuro", {"heartbeat_offset_s": 120}),
        ("epoch-diverso", {"heartbeat_epoch": 2}),
        ("backend-postgres", {"heartbeat_mode": "postgres"}),
    ],
)
def test_heartbeat_non_valido_frozen(server: h.InProcessRadicale, label: str, kwargs: Dict[str, Any]) -> None:
    server.control.set_mode("live", **kwargs)
    assert server.rights.control.evaluate().effective.mode == "frozen", label
    assert server.propfind(P + "/", h.PRINCIPAL).status == 207
    assert _put(server, "c") == 403
    server.control.set_mode("live")
    assert _put(server, "c") == 201


def test_heartbeat_assente_o_corrotto_frozen(server: h.InProcessRadicale) -> None:
    server.control.set_mode("live")
    assert _put(server, "c", "uno") == 201
    server.control.write_heartbeat(None)
    assert _put(server, "c", "due") == 403
    server.control.write_heartbeat('{"schema": 1, "api_version"')
    assert _put(server, "c", "due") == 403
    assert server.get(P + "/c/uno.ics", h.PRINCIPAL).status == 200
    server.control.write_heartbeat(h.heartbeat_doc("radicale"))
    assert _put(server, "c", "due") == 201


def test_policy_corrotta_dopo_live_sola_lettura(server: h.InProcessRadicale) -> None:
    server.control.set_mode("live")
    assert _put(server, "c", "uno") == 201
    for broken in ("{non json", b"\xff\xfe\x00", "[]", json.dumps({**h.policy_doc("live"), "schema": 2}),
                   json.dumps({**h.policy_doc("live"), "principal": "altro"})):
        server.control.write_policy(broken)
        evaluation = server.rights.control.evaluate().effective
        assert evaluation.mode == "shadow" and evaluation.reasons == ("policy_invalid",), broken
        assert server.propfind(P + "/", h.PRINCIPAL, depth="1").status == 207
        assert server.get(P + "/c/uno.ics", h.PRINCIPAL).status == 200
        assert _put(server, "c", "due") == 403
        # Le liste dell'ultima policy valida restano: f resta in sola lettura, sub-new nascosta.
        assert server.propfind(P + "/sub-new/", h.PRINCIPAL).status == 403
    server.control.write_policy(None)
    assert server.rights.control.evaluate().effective.reasons == ("policy_missing",)
    assert _put(server, "c", "due") == 403
    server.control.set_mode("live")
    assert _put(server, "c", "due") == 201


def test_marker_diverso_o_assente_403(server: h.InProcessRadicale) -> None:
    server.control.set_mode("live", volume_id=h.OTHER_VOLUME_ID)
    assert server.propfind("/", h.PRINCIPAL).status == 207
    assert server.propfind(P + "/", h.PRINCIPAL).status == 403
    assert server.get(P + "/c/esistente.ics", h.PRINCIPAL).status == 403
    assert _put(server, "c") == 403
    server.control.set_mode("live", epoch=2, heartbeat_epoch=2)
    assert server.propfind(P + "/", h.PRINCIPAL).status == 403, "epoch diverso"
    remove = ('<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:" xmlns:K="urn:calicchia:caldes">'
              "<D:remove><D:prop><K:volume-id/></D:prop></D:remove></D:propertyupdate>")
    server.control.set_mode("live")
    assert server.propfind(P + "/", h.PRINCIPAL).status == 207
    assert server.proppatch(P + "/", h.SERVICE_USER, remove).status == 207
    assert server.propfind(P + "/", h.PRINCIPAL).status == 403, "marker senza volume-id"


def test_nessun_w_su_altri_principal(server: h.InProcessRadicale) -> None:
    server.control.set_mode("live")
    root = server.storage / "collection-root"
    # Il device (principal canonico) non tocca altri principal.
    assert server.propfind("/iphone/", h.PRINCIPAL).status == 403
    assert server.mkcol("/iphone/", h.PRINCIPAL).status == 403
    assert server.mkcalendar("/iphone/c/", h.PRINCIPAL).status == 403
    assert server.put("/iphone/c/x.ics", h.PRINCIPAL, EVENT).status == 403
    assert server.propfind("/caldes-svc/", h.PRINCIPAL).status == 403
    # Un utente che non è il principal canonico non ottiene nulla, nemmeno il proprio principal.
    assert server.propfind("/iphone/", "iphone").status == 403
    assert server.propfind("/", "iphone").status == 403
    assert server.propfind(P + "/", "iphone").status == 403
    # caldes-svc non crea /caldes-svc/ al login né con MKCOL.
    assert server.propfind("/caldes-svc/", h.SERVICE_USER).status == 403
    assert server.mkcol("/caldes-svc/", h.SERVICE_USER).status == 403
    assert server.mkcol("/iphone/", h.SERVICE_USER).status == 403
    # Il probe non crea /caldes-probe/.
    assert server.propfind("/caldes-probe/", h.PROBE_USER).status == 403
    assert sorted(p.name for p in root.iterdir()) == [h.PRINCIPAL]


def test_canary_scrivibile_solo_dal_probe_in_live(server: h.InProcessRadicale) -> None:
    server.control.set_mode("shadow")
    assert _put(server, "_canary", "beat", h.PROBE_USER) == 403
    server.control.set_mode("frozen")
    assert _put(server, "_canary", "beat", h.PROBE_USER) == 403
    server.control.set_mode("live")
    assert _put(server, "_canary", "beat", h.PROBE_USER) == 201
    assert _put(server, "_canary", "device", h.PRINCIPAL) == 403
    assert server.get(P + "/_canary/beat.ics", h.PRINCIPAL).status == 403
    assert _put(server, "_altro", "beat", h.PROBE_USER) == 403
    assert _put(server, "c", "probe", h.PROBE_USER) == 201, "il probe ha i permessi del device"


def test_utente_anonimo_401(server: h.InProcessRadicale) -> None:
    server.control.set_mode("live")
    assert server.propfind("/", None).status == 401
    assert server.propfind(P + "/", None).status == 401
    assert server.propfind(P + "/", h.PRINCIPAL).status == 207
    assert server.request("PROPFIND", P + "/", h.PRINCIPAL, h.PROPFIND_ALLPROP, {"Depth": "0"},
                          password="sbagliata").status == 401


def test_marker_del_principal_scrivibile_solo_da_caldes_svc_anche_in_live(server: h.InProcessRadicale) -> None:
    """
    I device hanno sempre e solo R sul principal (contratto §8): un'app-password
    valida (telefono rubato, client difettoso) non può togliere o falsificare il
    marker d'identità, che lo scrive solo caldes-svc (§4.2). MKCALENDAR di una
    collezione nuova resta ammessa in live: Radicale controlla la `w` del path
    nuovo, non la W del principal.
    """
    server.control.set_mode("live")
    props = server.principal_dir() / ".Radicale.props"
    before = props.read_bytes()
    remove = ('<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:" xmlns:K="urn:calicchia:caldes">'
              "<D:remove><D:prop><K:volume-id/><K:epoch/></D:prop></D:remove></D:propertyupdate>")
    for user in (h.PRINCIPAL, h.PROBE_USER):
        assert server.proppatch(P + "/", user, remove).status == 403, user
        assert server.proppatch(P + "/", user, h.marker_proppatch_body(h.OTHER_VOLUME_ID, 7)).status == 403, user
    assert props.read_bytes() == before, "marker intatto"
    assert server.propfind(P + "/", h.PRINCIPAL).status == 207
    assert server.propfind(P + "/", h.PROBE_USER).status == 207
    # Le collezioni restano utilizzabili dal device in live.
    assert server.mkcalendar(P + "/dal-telefono/", h.PRINCIPAL).status == 201
    assert _put(server, "dal-telefono") == 201
    assert _put(server, "c") == 201
    # caldes-svc resta l'unico che può riscriverlo (riassegnazione d'identità dal wizard).
    assert server.proppatch(P + "/", h.SERVICE_USER, h.marker_proppatch_body(h.VOLUME_ID, 1)).status == 207


def test_dead_prop_delle_collezioni_scritte_da_un_device_restano_dati_non_fidati(server: h.InProcessRadicale) -> None:
    """
    In live un device scrive le dead prop delle collezioni che può scrivere
    (Radicale non distingue PROPPATCH da PUT): anche `{urn:calicchia:caldes}role`
    e `calendar-id`. I rights non possono impedirlo; per questo la 162 non usa
    mai la dead prop role di una riga nata da un device e la discovery (F2) non
    adotta una collezione per calendar-id se il nome non coincide con il
    sidecar (contratto §3.3 e §4.5). Qui si fissa il comportamento di Radicale
    su cui poggiano quelle regole.
    """
    server.control.set_mode("live")
    forged = ('<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:" xmlns:K="urn:calicchia:caldes">'
              "<D:set><D:prop><K:role>bookings</K:role><K:calendar-id>11111111-2222-4333-8444-555555555555</K:calendar-id>"
              "</D:prop></D:set></D:propertyupdate>")
    assert server.mkcalendar(P + "/finta/", h.PRINCIPAL).status == 201
    assert server.proppatch(P + "/finta/", h.PRINCIPAL, forged).status == 207
    assert server.proppatch(P + "/c/", h.PRINCIPAL, forged).status == 207
    # Sulle collezioni in sola lettura per i device no.
    for name in ("f", "bookings", "scadenze"):
        assert server.proppatch("%s/%s/" % (P, name), h.PRINCIPAL, forged).status == 403, name
    props = json.loads((server.collection_dir("finta") / ".Radicale.props").read_text(encoding="utf-8"))
    assert props.get("{urn:calicchia:caldes}role") == "bookings"


def test_log_del_principal_di_servizio_a_debug(
    server: h.InProcessRadicale, caplog: pytest.LogCaptureFixture
) -> None:
    server.control.set_mode("shadow")
    caplog.set_level(logging.INFO, logger="radicale")
    caplog.clear()
    assert server.propfind("/", h.PROBE_USER).status == 207
    assert server.propfind(P + "/", h.SERVICE_USER).status == 207
    assert server.propfind("/iphone/", "iphone").status == 403
    messages = [r.getMessage() for r in caplog.records if r.levelno >= logging.INFO]
    assert not any("'/caldes-probe/'" in m or "'/caldes-svc/'" in m for m in messages), messages
    assert any("Access to principal path '/iphone/' denied" in m for m in messages), messages
