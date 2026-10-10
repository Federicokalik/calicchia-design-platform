"""
Criterio di uscita di F1 sullo stack reale dei plugin (piano F1: "Un device
reale si autentica con un'app-password esistente, anche con username diverso
da federico, e vede /federico/ in sola lettura dopo l'inizializzazione. Su un
volume vuoto riceve 403 e non si crea nulla. Il login del servizio da internet
dà 401").

Radicale 3.7.8 in un processo separato con il config di produzione e i plugin
veri (caldes_auth, caldes_rights, patch di vobject via sitecustomize), il mock
di verify-credentials del harness F0 al posto dell'API, la rete interna
caldav-int simulata sul loopback (127.0.0.2 in CALDES_SVC_CIDR; il traffico
pubblicato arriva da un altro indirizzo, qui 127.0.0.3) e l'healthcheck del
probe da 127.0.0.1. I dettagli di ciascun plugin sono in test_auth.py e
test_rights.py: qui conta che i pezzi funzionino insieme.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from typing import Iterator, Tuple

import pytest

import caldes_harness as h

P = "/%s" % h.PRINCIPAL
IPHONE = {"username": "iphone", "password": "test-only-app-password-iphone"}
HEALTHCHECK = h.PLUGINS_DIR / "caldes_healthcheck.py"


@pytest.fixture
def stack(tmp_path: Path) -> Iterator[Tuple[h.RadicaleProcess, h.MockVerifyProcess]]:
    mock = h.MockVerifyProcess([IPHONE])
    control = h.ControlFiles(tmp_path / "control")
    env = h.caldes_auth_env(mock.backend_url, control, tmp_path / "authcache")
    rad = None
    try:
        rad = h.RadicaleProcess(tmp_path, auth="caldes_auth", env=env, user_sources={h.SERVICE_USER: h.SVC_PEER})
        rad.passwords[IPHONE["username"]] = IPHONE["password"]
        yield rad, mock
    finally:
        if rad is not None:
            rad.stop()
        mock.stop()


def _device(rad: h.RadicaleProcess, method: str, path: str, body: str = "", depth: str = "0") -> h.Response:
    # Traffico pubblicato: dal gateway di app-net, con l'IP del device in X-Remote-Addr.
    headers = {"Depth": depth, "X-Remote-Addr": "203.0.113.7", "Content-Type": "application/xml"}
    if method == "PUT":
        headers["Content-Type"] = "text/calendar; charset=utf-8"
    return rad.request(method, path, IPHONE["username"], body or (h.PROPFIND_ALLPROP if method == "PROPFIND" else ""),
                       headers, source=h.GATEWAY_PEER)


def _healthcheck(rad: h.RadicaleProcess) -> subprocess.CompletedProcess:
    env = {"CALDES_PROBE_PASSWORD": h.PASSWORDS[h.PROBE_USER], "CALDES_HEALTHCHECK_URL": rad.url,
           "PYTHONDONTWRITEBYTECODE": "1"}
    return subprocess.run([sys.executable, "-I", str(HEALTHCHECK)], env=env, capture_output=True, text=True,
                          timeout=30)


def test_criterio_di_uscita_f1(stack: Tuple[h.RadicaleProcess, h.MockVerifyProcess]) -> None:
    rad, mock = stack
    root = rad.storage / "collection-root"

    # Volume vuoto: healthcheck sano, device 403, nessuna directory.
    assert _healthcheck(rad).returncode == 0
    assert _device(rad, "PROPFIND", "/").status == 207
    assert _device(rad, "PROPFIND", P + "/").status == 403
    assert _device(rad, "PROPFIND", "/iphone/").status == 403
    assert list(root.iterdir()) == []
    assert any(call["username"] == "iphone" and call["status"] == 200 for call in mock.calls())

    # Il servizio da internet (gateway) o da loopback: 401, mai il ramo device.
    for source in (h.GATEWAY_PEER, "127.0.0.1"):
        res = rad.request("PROPFIND", "/", h.SERVICE_USER, h.PROPFIND_ALLPROP, {"Depth": "0"}, source=source)
        assert res.status == 401, source
    assert not any(call["username"].startswith("caldes-") for call in mock.calls())

    # Inizializzazione dalla rete interna (contratto §4.4), poi policy shadow.
    rad.initialize(collections=("c", "f"))
    assert _device(rad, "PROPFIND", P + "/").status == 403, "policy non ancora scritta dall'API"
    rad.control.set_mode("shadow", readonly=["f"], hidden=["_canary"])
    listing = _device(rad, "PROPFIND", P + "/", depth="1")
    assert listing.status == 207
    assert set(listing.multistatus()) == {P + "/", P + "/c/", P + "/f/"}
    event = h.event_ics("criterio@caldes.test", ["SUMMARY:Pranzo, cena", "X-FOO:a,b,c"])
    assert _device(rad, "PUT", P + "/c/criterio.ics", event).status == 403
    assert sorted(p.name for p in root.iterdir()) == [h.PRINCIPAL]

    # Live (dopo il cutover, F4-F5): scrittura con fedeltà, collezioni protette.
    rad.control.set_mode("live", readonly=["f"], hidden=["_canary"])
    assert _device(rad, "PUT", P + "/c/criterio.ics", event).status == 201
    assert _device(rad, "PUT", P + "/f/criterio.ics", event).status == 403
    body = _device(rad, "GET", P + "/c/criterio.ics").text
    assert "SUMMARY:Pranzo\\, cena" in h.unfold(body) and "X-FOO:a,b,c" in h.unfold(body)
    assert _healthcheck(rad).returncode == 0
