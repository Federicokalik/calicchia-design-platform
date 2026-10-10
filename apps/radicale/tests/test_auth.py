"""
Test di caldes_auth (fase F1, piano "pytest auth"; contratto control-plane
§1.2, §5.3-§5.4, §9 e §10; design §3.3).

Due livelli, entrambi contro il mock di verify-credentials del harness F0
(apps/api/test/helpers/mock_verify.py) avviato come processo su loopback:

- unità: la classe Auth caricata con una Configuration reale di Radicale 3.7.8
  e chiamata tramite BaseAuth.login() (la stessa strada del server), con un
  contesto costruito dal test (peer TCP e X-Remote-Addr qualsiasi) e un
  orologio controllato per i TTL delle cache;
- integrazione: Radicale 3.7.8 reale avviato come processo con il plugin; i
  client si connettono da indirizzi di loopback diversi per simulare la rete
  interna caldav-int (127.0.0.2, l'unico indirizzo di CALDES_SVC_CIDR) e il
  gateway di app-net (127.0.0.3); 127.0.0.1 è il loopback del container
  (healthcheck del probe).

Esecuzione (dalla radice del repository):

    PYTHONPATH=apps/radicale/plugins <venv>/bin/pytest apps/radicale/tests/test_auth.py

Variabili facoltative: RADICALE_BIN (binario di Radicale; default `python -m
radicale` con lo stesso interprete di pytest), CALDES_MOCK_VERIFY (percorso del
mock), CALDES_TEST_LOG=1 (inoltra su stderr i log di Radicale e del mock).
Nessuna rete esterna: tutto gira su 127.0.0.0/8 e in directory temporanee.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import http.client
import json
import logging
import os
import socket
import stat
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Dict, Iterator, List, NamedTuple, Optional

import pytest

TESTS_DIR = Path(__file__).resolve().parent
PLUGINS_DIR = TESTS_DIR.parent / "plugins"
REPO_ROOT = TESTS_DIR.parents[2]
MOCK_VERIFY = Path(os.environ.get("CALDES_MOCK_VERIFY") or REPO_ROOT / "apps" / "api" / "test" / "helpers" / "mock_verify.py")
CONTRACTS_DIR = REPO_ROOT / "docs" / "calendar-radicale" / "contracts"

if str(PLUGINS_DIR) not in sys.path:
    sys.path.insert(0, str(PLUGINS_DIR))

import radicale  # noqa: E402
from radicale import config as radicale_config  # noqa: E402
from radicale.auth import AuthContext  # noqa: E402

import caldes_auth  # noqa: E402

if not MOCK_VERIFY.is_file():
    pytest.skip("mock di verify-credentials non trovato: %s (impostare CALDES_MOCK_VERIFY)" % MOCK_VERIFY, allow_module_level=True)

# ─── Valori fissi dei test (mai segreti reali) ───────────────────────────────

PRINCIPAL = "federico"
TOKEN = "test-only-caldav-service-token"
SVC_PASSWORD = "test-only-svc-password"
PROBE_PASSWORD = "test-only-probe-password"
AUTHCACHE_KEY = "test-only-authcache-key-0123456789abcdef"
IPHONE = ("iphone", "test-only-app-password-iphone")
GATEWAY_IP = "203.0.113.7"  # IP pubblico del device (X-Remote-Addr di CloudPanel)

#: Rete di servizio dei test unitari (come caldav-int in produzione) e peer d'esempio.
UNIT_CIDR = "172.31.250.0/29"
UNIT_INTERNAL_PEER = "172.31.250.3"
UNIT_GATEWAY_PEER = "172.18.0.1"

#: Integrazione: 127.0.0.2 = caldav-int, 127.0.0.3 = gateway di app-net, 127.0.0.1 = loopback del container.
INTERNAL_SRC = "127.0.0.2"
GATEWAY_SRC = "127.0.0.3"
E2E_CIDR = "127.0.0.2/32"

ENV_NAMES = (
    "RADICALE_PRINCIPAL",
    "CALDAV_BACKEND_URL",
    "CALDAV_SERVICE_TOKEN",
    "CALDES_SVC_CIDR",
    "CALDES_SVC_PASSWORD_SHA256",
    "CALDES_PROBE_PASSWORD_SHA256",
    "CALDES_AUTHCACHE_KEY",
    "CALDES_AUTHCACHE_DIR",
    "CALDES_POLICY_FILE",
    "CALDES_XRA_PEER_CIDR",
)

SECRETS = (TOKEN, SVC_PASSWORD, PROBE_PASSWORD, AUTHCACHE_KEY, IPHONE[1])


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def iso(ts: float) -> str:
    """Secondi Unix → timestamp del contratto (forma di Date.prototype.toISOString)."""
    moment = datetime.fromtimestamp(ts, tz=timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (moment.microsecond // 1000)


def expected_cache_key(epoch: int, login: str, password: str) -> str:
    """Chiave del contratto §9.5 calcolata indipendentemente dal plugin."""
    message = ("caldes-authcache/v1\0%d\0%s\0%s" % (epoch, login, password)).encode("utf-8")
    return hmac.new(AUTHCACHE_KEY.encode("utf-8"), message, hashlib.sha256).hexdigest()


def expected_key_id(key: str = AUTHCACHE_KEY) -> str:
    return hmac.new(key.encode("utf-8"), b"caldes-authcache/key-id", hashlib.sha256).hexdigest()[:16]


def write_atomic(path: Path, data: bytes) -> None:
    """Scrittura con rename, come il writer dell'API (cambia inode: il plugin la vede subito)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(".%s.%d.tmp" % (path.name, os.getpid()))
    tmp.write_bytes(data)
    os.replace(tmp, path)


def policy_doc(credential_epoch: int = 0, **overrides: Any) -> Dict[str, Any]:
    doc: Dict[str, Any] = {
        "schema": 1,
        "version": 1,
        "generated_at": iso(time.time()),
        "backend_mode": "postgres",
        "mode": "shadow",
        "reasons": [],
        "principal": PRINCIPAL,
        "volume_id": None,
        "epoch": 0,
        "credential_epoch": credential_epoch,
        "readonly": ["bookings", "scadenze"],
        "hidden": ["_canary"],
    }
    doc.update(overrides)
    return doc


def write_policy(path: Path, credential_epoch: int = 0, **overrides: Any) -> None:
    write_atomic(path, (json.dumps(policy_doc(credential_epoch, **overrides), indent=2) + "\n").encode("utf-8"))


def read_authcache(directory: Path) -> Dict[str, Any]:
    return json.loads((directory / "authcache.json").read_text(encoding="utf-8"))


def validate_authcache(doc: Dict[str, Any]) -> None:
    """Conformità ad authcache.schema.json (validatore minimo, senza dipendenze)."""
    schema = json.loads((CONTRACTS_DIR / "authcache.schema.json").read_text(encoding="utf-8"))
    assert set(doc) == set(schema["required"]), "chiavi di primo livello"
    assert doc["schema"] == 1
    assert isinstance(doc["key_id"], str) and len(doc["key_id"]) == 16 and all(c in "0123456789abcdef" for c in doc["key_id"])
    assert isinstance(doc["credential_epoch"], int) and 0 <= doc["credential_epoch"] <= 2147483647
    entries = doc["entries"]
    assert isinstance(entries, dict) and len(entries) <= schema["properties"]["entries"]["maxProperties"]
    for key, value in entries.items():
        assert len(key) == 64 and all(c in "0123456789abcdef" for c in key)
        assert set(value) == {"exp", "refreshed"}
        assert isinstance(value["exp"], int) and value["exp"] >= 0
        assert isinstance(value["refreshed"], int) and value["refreshed"] >= 0


def caldes_events(text: str, name: Optional[str] = None) -> List[Dict[str, Any]]:
    """Eventi `caldes_event {json}` di caldes_auth in un testo di log."""
    events = []
    for line in text.splitlines():
        marker = line.find("caldes_event ")
        if marker < 0:
            continue
        try:
            payload = json.loads(line[marker + len("caldes_event "):])
        except ValueError:
            continue
        if payload.get("plugin") == "caldes_auth" and (name is None or payload.get("event") == name):
            events.append(payload)
    return events


def closed_port() -> int:
    """Porta TCP su 127.0.0.1 su cui nessuno ascolta (connessione rifiutata)."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def can_bind(address: str) -> bool:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind((address, 0))
        return True
    except OSError:
        return False


# ─── Processi figli: mock e Radicale ───────────────────────────────


def child_env(extra: Dict[str, str], pythonpath: Optional[List[Path]] = None) -> Dict[str, str]:
    """Ambiente minimo dei processi figli: niente proxy, RADICALE_CONFIG o PYTHONPATH della shell."""
    keep = ("PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "SYSTEMROOT", "PYTEST_VERSION")
    env = {k: v for k, v in os.environ.items() if k in keep}
    env.update({"TZ": "UTC", "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8"})
    if pythonpath:
        env["PYTHONPATH"] = os.pathsep.join(str(p) for p in pythonpath)
    env.update(extra)
    return env


class OutputCollector:
    """Raccoglie le righe di stdout+stderr di un figlio in un thread."""

    def __init__(self, stream: Any, tag: str) -> None:
        self._lines: List[str] = []
        self._cond = threading.Condition()
        self._closed = False
        self._tag = tag
        self._thread = threading.Thread(target=self._run, args=(stream,), daemon=True)
        self._thread.start()

    def _run(self, stream: Any) -> None:
        for raw in iter(stream.readline, b""):
            line = raw.decode("utf-8", "replace").rstrip("\r\n")
            if os.environ.get("CALDES_TEST_LOG"):
                sys.stderr.write("[%s] %s\n" % (self._tag, line))
            with self._cond:
                self._lines.append(line)
                self._cond.notify_all()
        stream.close()
        with self._cond:
            self._closed = True
            self._cond.notify_all()

    def wait_for(self, predicate: Callable[[str], bool], timeout: float) -> Optional[str]:
        deadline = time.monotonic() + timeout
        seen = 0
        with self._cond:
            while True:
                for line in self._lines[seen:]:
                    if predicate(line):
                        return line
                seen = len(self._lines)
                remaining = deadline - time.monotonic()
                if self._closed or remaining <= 0:
                    return None
                self._cond.wait(remaining)

    def wait_closed(self, timeout: float) -> None:
        self._thread.join(timeout)

    def mark(self) -> int:
        with self._cond:
            return len(self._lines)

    def text(self, start: int = 0) -> str:
        with self._cond:
            return "\n".join(self._lines[start:])


def stop_process(proc: subprocess.Popen, grace: float = 5.0) -> None:
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(grace)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(grace)


class HttpResponse(NamedTuple):
    status: int
    headers: Dict[str, str]
    body: bytes
    elapsed: float


def http_request(
    port: int,
    method: str,
    path: str,
    *,
    source: Optional[str] = None,
    headers: Optional[Dict[str, str]] = None,
    body: Optional[bytes] = None,
    timeout: float = 20.0,
) -> HttpResponse:
    """Richiesta HTTP su 127.0.0.1 da un indirizzo sorgente scelto (http.client: nessun proxy)."""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout, source_address=(source, 0) if source else None)
    started = time.monotonic()
    try:
        conn.request(method, path, body=body, headers=headers or {})
        response = conn.getresponse()
        data = response.read()
        return HttpResponse(response.status, {k.lower(): v for k, v in response.getheaders()}, data, time.monotonic() - started)
    finally:
        conn.close()


class MockVerify:
    """helpers/mock_verify.py su 127.0.0.1, porta scelta dal sistema."""

    DEFAULT_STATE: Dict[str, Any] = {
        "mode": "ok",
        "delay_ms": 0,
        "token": TOKEN,
        "principal": PRINCIPAL,
        "principal_mode": "canonical",
        "reject_reserved": True,
        "users": [],
    }

    def __init__(self) -> None:
        self.proc = subprocess.Popen(
            [sys.executable, "-I", str(MOCK_VERIFY), "--host", "127.0.0.1", "--port", "0", "--state", json.dumps(self.DEFAULT_STATE)],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            env=child_env({}),
        )
        self.output = OutputCollector(self.proc.stdout, "mock-verify")
        ready = self.output.wait_for(lambda line: line.startswith("{") and '"ready"' in line, 15.0)
        if ready is None:
            stop_process(self.proc)
            raise RuntimeError("mock di verify-credentials non avviato:\n%s" % self.output.text())
        self.port = int(json.loads(ready)["port"])
        self.backend_url = "http://127.0.0.1:%d/api/caldav-backend" % self.port

    def _control(self, method: str, path: str, body: Any = None) -> Any:
        payload = None if body is None else json.dumps(body).encode("utf-8")
        response = http_request(self.port, method, path, body=payload, headers={"Content-Type": "application/json"}, timeout=5.0)
        if response.status >= 400:
            raise RuntimeError("mock %s %s: HTTP %d %r" % (method, path, response.status, response.body))
        return json.loads(response.body) if response.body else None

    def set(self, **patch: Any) -> Dict[str, Any]:
        return self._control("POST", "/__mock/state", patch)

    def calls(self) -> List[Dict[str, Any]]:
        return self._control("GET", "/__mock/calls")

    def clear(self) -> None:
        self._control("DELETE", "/__mock/calls")

    def wait_for_calls(self, predicate: Callable[[List[Dict[str, Any]]], bool], timeout: float = 5.0) -> List[Dict[str, Any]]:
        """
        Attende che il registro soddisfi `predicate`. Serve dopo la modalità
        'slow': il mock registra la chiamata solo dopo il ritardo, quindi senza
        attesa finirebbe nel registro del test successivo.
        """
        deadline = time.monotonic() + timeout
        while True:
            calls = self.calls()
            if predicate(calls) or time.monotonic() >= deadline:
                return calls
            time.sleep(0.05)

    def reset(self) -> None:
        self.set(**self.DEFAULT_STATE)
        self.clear()

    def stop(self) -> None:
        stop_process(self.proc)
        self.output.wait_closed(5.0)


def radicale_command() -> List[str]:
    explicit = os.environ.get("RADICALE_BIN", "").strip()
    return [explicit] if explicit else [sys.executable, "-m", "radicale"]


PROPFIND_PRINCIPAL = (
    b'<?xml version="1.0" encoding="utf-8"?>'
    b'<D:propfind xmlns:D="DAV:"><D:prop><D:current-user-principal/><D:resourcetype/></D:prop></D:propfind>'
)


class RadicaleServer:
    """Radicale 3.7.8 reale con caldes_auth, rights owner_only e storage in una directory temporanea."""

    def __init__(self, root: Path, env: Dict[str, str], *, auth_delay: float = 0.0, label: str = "radicale") -> None:
        self.root = root
        self.env = env
        self.auth_delay = auth_delay
        self.label = label
        self.port = 0
        self.proc: Optional[subprocess.Popen] = None
        self.output: Optional[OutputCollector] = None
        root.mkdir(parents=True, exist_ok=True)
        self.config_path = root / "config"

    def _config(self) -> str:
        return "\n".join(
            [
                "# Generata da apps/radicale/tests/test_auth.py",
                "[server]",
                "hosts = 127.0.0.1:0",
                "max_connections = 16",
                "timeout = 30",
                # delay_on_error resta al default (1 s): il 500 del plugin non deve subirlo.
                "[auth]",
                "type = caldes_auth",
                "delay = %s" % self.auth_delay,
                "[rights]",
                "type = owner_only",
                "permit_delete_collection = False",
                "permit_overwrite_collection = False",
                "[storage]",
                "type = multifilesystem",
                "filesystem_folder = %s" % (self.root / "collections"),
                "[hook]",
                "type = none",
                "[sharing]",
                "type = none",
                "[web]",
                "type = none",
                "[logging]",
                "level = info",
                "mask_passwords = True",
                "",
            ]
        )

    def launch(self) -> None:
        self.config_path.write_text(self._config(), encoding="utf-8")
        self.proc = subprocess.Popen(
            radicale_command() + ["--config", str(self.config_path)],
            cwd=str(self.root),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            env=child_env(self.env, [PLUGINS_DIR]),
        )
        self.output = OutputCollector(self.proc.stdout, self.label)

    def start(self, timeout: float = 30.0) -> "RadicaleServer":
        self.launch()
        assert self.output is not None
        listening = self.output.wait_for(lambda line: "Listening on" in line, timeout)
        ready = listening and self.output.wait_for(lambda line: "Radicale server ready" in line, timeout)
        if not listening or not ready:
            logs = self.output.text()
            self.stop()
            raise RuntimeError("Radicale non avviato:\n%s" % logs[-6000:])
        self.port = int(listening.rsplit(":", 1)[1].strip("'\" "))
        return self

    def wait_exit(self, timeout: float) -> Optional[int]:
        assert self.proc is not None
        try:
            return self.proc.wait(timeout)
        except subprocess.TimeoutExpired:
            return None

    def request(
        self,
        method: str,
        path: str,
        *,
        user: Optional[str] = None,
        password: Optional[str] = None,
        source: str = "127.0.0.1",
        headers: Optional[Dict[str, str]] = None,
        body: Optional[bytes] = None,
    ) -> HttpResponse:
        all_headers = dict(headers or {})
        if user is not None:
            token = base64.b64encode(("%s:%s" % (user, password or "")).encode("utf-8")).decode("ascii")
            all_headers["Authorization"] = "Basic " + token
        return http_request(self.port, method, path, source=source, headers=all_headers, body=body)

    def propfind(self, path: str, **kwargs: Any) -> HttpResponse:
        headers = {"Depth": "0", "Content-Type": "application/xml; charset=utf-8"}
        headers.update(kwargs.pop("headers", None) or {})
        return self.request("PROPFIND", path, headers=headers, body=PROPFIND_PRINCIPAL, **kwargs)

    def mark(self) -> int:
        assert self.output is not None
        return self.output.mark()

    def logs(self, start: int = 0) -> str:
        assert self.output is not None
        return self.output.text(start)

    def stop(self) -> None:
        if self.proc is not None:
            stop_process(self.proc)
        if self.output is not None:
            self.output.wait_closed(5.0)


# ─── Fixture ───────────────────────────────


@pytest.fixture(scope="module")
def mock() -> Iterator[MockVerify]:
    server = MockVerify()
    try:
        yield server
    finally:
        server.stop()


@pytest.fixture
def backend(mock: MockVerify) -> MockVerify:
    """Mock riportato allo stato di default, senza chiamate registrate."""
    mock.reset()
    return mock


class FakeClock:
    """Orologio dei test unitari: muro e monotono avanzano insieme solo con advance()."""

    def __init__(self, wall: float = 1_800_000_000.0) -> None:
        self.wall = wall
        self.mono = 10_000.0

    def advance(self, seconds: float) -> None:
        self.wall += seconds
        self.mono += seconds


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> FakeClock:
    fake = FakeClock()
    monkeypatch.setattr(caldes_auth, "_wall_time", lambda: fake.wall)
    monkeypatch.setattr(caldes_auth, "_monotonic", lambda: fake.mono)
    return fake


def plugin_env(*, backend_url: str, policy_file: Path, authcache_dir: Path, cidr: str) -> Dict[str, str]:
    return {
        "RADICALE_PRINCIPAL": PRINCIPAL,
        "CALDAV_BACKEND_URL": backend_url,
        "CALDAV_SERVICE_TOKEN": TOKEN,
        "CALDES_SVC_CIDR": cidr,
        "CALDES_SVC_PASSWORD_SHA256": sha256_hex(SVC_PASSWORD),
        "CALDES_PROBE_PASSWORD_SHA256": sha256_hex(PROBE_PASSWORD),
        "CALDES_AUTHCACHE_KEY": AUTHCACHE_KEY,
        "CALDES_AUTHCACHE_DIR": str(authcache_dir),
        "CALDES_POLICY_FILE": str(policy_file),
    }


def make_configuration(rights: Optional[Dict[str, str]] = None) -> Any:
    configuration = radicale_config.load()
    values: Dict[str, Dict[str, str]] = {"auth": {"type": "caldes_auth", "delay": "0"}}
    if rights:
        values["rights"] = rights
    configuration.update(values, "test_auth", privileged=True)
    return configuration


def context(peer: Optional[str] = UNIT_GATEWAY_PEER, xra: Optional[str] = GATEWAY_IP) -> AuthContext:
    ctx = AuthContext()
    ctx.remote_addr = peer
    ctx.x_remote_addr = xra
    return ctx


@pytest.fixture
def unit(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, backend: MockVerify, caplog: pytest.LogCaptureFixture) -> SimpleNamespace:
    """Ambiente del plugin per i test unitari: policy valida (credential_epoch 0) e cartella della cache."""
    caplog.set_level(logging.DEBUG, logger="radicale")
    policy = tmp_path / "control" / "policy.json"
    authcache = tmp_path / "authcache"
    write_policy(policy, 0)
    env = plugin_env(backend_url=backend.backend_url, policy_file=policy, authcache_dir=authcache, cidr=UNIT_CIDR)
    for name in ENV_NAMES:
        monkeypatch.delenv(name, raising=False)
    for name, value in env.items():
        monkeypatch.setenv(name, value)

    def make(rights: Optional[Dict[str, str]] = None) -> caldes_auth.Auth:
        return caldes_auth.Auth(make_configuration(rights))

    def login(auth: caldes_auth.Auth, user: str, password: str, peer: Optional[str] = UNIT_GATEWAY_PEER, xra: Optional[str] = GATEWAY_IP) -> str:
        return auth.login(user, password, context(peer, xra))[0]

    return SimpleNamespace(policy=policy, authcache=authcache, env=env, backend=backend, make=make, login=login, caplog=caplog)


# ═══ Unità: configurazione ═══════════════════════════════


def test_versione_di_radicale_fissata_dal_design() -> None:
    assert radicale.VERSION == "3.7.8"
    # BaseAuth.login è @final: il plugin implementa _login_ext e non sovrascrive login.
    assert "login" not in caldes_auth.Auth.__dict__
    assert "_login_ext" in caldes_auth.Auth.__dict__


def test_configurazione_valida_e_riepilogo_senza_segreti(unit: SimpleNamespace) -> None:
    auth = unit.make()
    text = unit.caplog.text
    assert "caldes_auth: principal 'federico'" in text
    assert "172.31.250.0/29" in text
    for secret in SECRETS + (sha256_hex(SVC_PASSWORD), sha256_hex(PROBE_PASSWORD)):
        assert secret not in text
    assert auth._policy.path == str(unit.policy)
    # La cartella della cache nasce 0700 se manca.
    assert stat.S_IMODE(os.stat(unit.authcache).st_mode) & 0o077 == 0


MALFORMED_ENV = [
    ("RADICALE_PRINCIPAL", None),
    ("RADICALE_PRINCIPAL", "caldes-federico"),
    ("RADICALE_PRINCIPAL", "Federico"),
    ("CALDAV_BACKEND_URL", None),
    ("CALDAV_BACKEND_URL", "ftp://api-int/api/caldav-backend"),
    ("CALDAV_BACKEND_URL", "http://utente:segreto@api-int:3001/api/caldav-backend"),
    ("CALDAV_BACKEND_URL", "http://api-int:3001/api/caldav-backend?x=1"),
    ("CALDAV_BACKEND_URL", "http://api-int:99999/api/caldav-backend"),
    ("CALDAV_BACKEND_URL", "http:///api/caldav-backend"),
    ("CALDAV_SERVICE_TOKEN", None),
    ("CALDAV_SERVICE_TOKEN", "token con spazio"),
    ("CALDES_SVC_CIDR", None),
    ("CALDES_SVC_CIDR", "172.31.250.1/29"),
    ("CALDES_SVC_CIDR", "0.0.0.0/0"),
    ("CALDES_SVC_CIDR", "127.0.0.0/8"),
    ("CALDES_SVC_CIDR", "::/0"),
    ("CALDES_SVC_CIDR", "172.31.250.0/29,"),
    ("CALDES_SVC_CIDR", "caldav-int"),
    ("CALDES_SVC_PASSWORD_SHA256", None),
    ("CALDES_SVC_PASSWORD_SHA256", sha256_hex(SVC_PASSWORD).upper()),
    ("CALDES_SVC_PASSWORD_SHA256", "abc123"),
    ("CALDES_PROBE_PASSWORD_SHA256", None),
    ("CALDES_AUTHCACHE_KEY", None),
    ("CALDES_AUTHCACHE_KEY", "chiave-corta"),
    ("CALDES_AUTHCACHE_DIR", "relativa/caldes-auth"),
    ("CALDES_POLICY_FILE", "policy.json"),
    ("CALDES_XRA_PEER_CIDR", "dav-pub"),
    ("CALDES_XRA_PEER_CIDR", "0.0.0.0/0"),
    ("CALDES_XRA_PEER_CIDR", "172.31.251.1/29"),
    ("CALDES_XRA_PEER_CIDR", "172.31.251.0/29,"),
]


@pytest.mark.parametrize("name,value", MALFORMED_ENV, ids=["%s=%s" % (n, "assente" if v is None else v) for n, v in MALFORMED_ENV])
def test_variabile_assente_o_malformata_impedisce_il_caricamento(
    unit: SimpleNamespace, monkeypatch: pytest.MonkeyPatch, name: str, value: Optional[str]
) -> None:
    if value is None:
        monkeypatch.delenv(name)
    else:
        monkeypatch.setenv(name, value)
    with pytest.raises(RuntimeError) as info:
        unit.make()
    message = str(info.value)
    assert name in message
    events = caldes_events(unit.caplog.text, "config_error")
    assert events and events[-1]["option"] == name
    assert any(r.levelno == logging.ERROR and "config_error" in r.getMessage() for r in unit.caplog.records)
    for secret in SECRETS:
        assert secret not in message and secret not in unit.caplog.text


def test_auth_e_rights_devono_leggere_la_stessa_policy(unit: SimpleNamespace, monkeypatch: pytest.MonkeyPatch) -> None:
    same = {"type": "caldes_rights", "caldes_policy_file": str(unit.policy)}
    assert unit.make(same)._policy.path == str(unit.policy)

    with pytest.raises(RuntimeError, match="CALDES_POLICY_FILE"):
        unit.make({"type": "caldes_rights", "caldes_policy_file": "/altro/policy.json"})
    # caldes_rights senza opzione legge il default /control/policy.json.
    with pytest.raises(RuntimeError, match="CALDES_POLICY_FILE"):
        unit.make({"type": "caldes_rights"})

    # Senza CALDES_POLICY_FILE vale l'opzione dei rights (Configuration.get senza fallback=).
    monkeypatch.delenv("CALDES_POLICY_FILE")
    assert unit.make(same)._policy.path == str(unit.policy)
    assert unit.make()._policy.path == caldes_auth.DEFAULT_POLICY_FILE


def test_cartella_della_cache_non_utilizzabile_non_blocca_il_login(unit: SimpleNamespace, monkeypatch: pytest.MonkeyPatch, clock: FakeClock, tmp_path: Path) -> None:
    blocker = tmp_path / "file-normale"
    blocker.write_text("x")
    monkeypatch.setenv("CALDES_AUTHCACHE_DIR", str(blocker / "authcache"))
    unit.backend.set(users=[{"username": IPHONE[0], "password": IPHONE[1]}])
    auth = unit.make()
    events = caldes_events(unit.caplog.text, "config_error")
    assert events and events[0]["option"] == "CALDES_AUTHCACHE_DIR"
    assert unit.login(auth, *IPHONE) == PRINCIPAL
    # La copia in memoria della cache persistita vale comunque per il processo.
    clock.advance(61)
    unit.backend.set(mode="unavailable")
    assert unit.login(auth, *IPHONE) == PRINCIPAL
    assert caldes_events(unit.caplog.text, "stale_if_error")


# ═══ Unità: utenti di servizio ═══════════════════════════════

RESERVED_CASES = [
    # (login, password, peer, atteso)
    ("caldes-svc", SVC_PASSWORD, UNIT_INTERNAL_PEER, "caldes-svc"),
    ("caldes-svc", SVC_PASSWORD, "::ffff:" + UNIT_INTERNAL_PEER, "caldes-svc"),
    ("caldes-svc", SVC_PASSWORD, UNIT_GATEWAY_PEER, ""),
    ("caldes-svc", SVC_PASSWORD, "127.0.0.1", ""),
    ("caldes-svc", SVC_PASSWORD, None, ""),
    ("caldes-svc", SVC_PASSWORD, "non-un-ip", ""),
    ("caldes-svc", "sbagliata", UNIT_INTERNAL_PEER, ""),
    ("caldes-svc", PROBE_PASSWORD, UNIT_INTERNAL_PEER, ""),
    ("caldes-probe", PROBE_PASSWORD, "127.0.0.1", "caldes-probe"),
    ("caldes-probe", PROBE_PASSWORD, "::ffff:127.0.0.1", "caldes-probe"),
    ("caldes-probe", PROBE_PASSWORD, "172.31.250.4", "caldes-probe"),
    ("caldes-probe", PROBE_PASSWORD, "127.0.0.2", ""),
    ("caldes-probe", PROBE_PASSWORD, UNIT_GATEWAY_PEER, ""),
    ("caldes-probe", SVC_PASSWORD, "127.0.0.1", ""),
    ("CALDES-SVC", SVC_PASSWORD, UNIT_INTERNAL_PEER, ""),
    ("caldes-admin", SVC_PASSWORD, UNIT_INTERNAL_PEER, ""),
]


def test_utenti_di_servizio_riconosciuti_solo_dal_peer_ammesso(unit: SimpleNamespace, clock: FakeClock) -> None:
    auth = unit.make()
    for login, password, peer, expected in RESERVED_CASES:
        # X-Remote-Addr con un IP interno non conta: il peer si legge solo dal socket.
        assert unit.login(auth, login, password, peer=peer, xra=UNIT_INTERNAL_PEER) == expected, (login, peer)
        # Un minuto fra i casi: ogni rifiuto compare nei log (limite degli eventi).
        clock.advance(61)
    assert unit.backend.calls() == [], "un login riservato non chiama mai verify-credentials"
    denied = caldes_events(unit.caplog.text, "reserved_denied")
    assert len(denied) == sum(1 for case in RESERVED_CASES if not case[3])
    gateway = [e for e in denied if e["login"] == "caldes-svc" and e["peer"] == UNIT_GATEWAY_PEER]
    assert gateway and gateway[0]["reason"] == "peer"
    assert any(e["login"] == "caldes-svc" and e["reason"] == "password" for e in denied)
    assert any(e["login"] == "caldes-admin" and e["reason"] == "unknown_user" for e in denied)


def test_eventi_provocabili_da_un_client_hanno_un_limite_per_minuto(unit: SimpleNamespace, clock: FakeClock) -> None:
    """
    reserved_denied, backend_error, stale_if_error e rate_limited: al massimo
    EVENT_BURST righe al minuto per nome; le altre si contano e il primo
    evento successivo le riporta in `suppressed` (un attaccante non allaga
    log e alert con richieste fatte apposta per fallire).
    """
    auth = unit.make()
    burst = caldes_auth.EVENT_BURST
    for i in range(burst + 25):
        assert unit.login(auth, "caldes-svc", "sbagliata-%d" % i, peer=UNIT_GATEWAY_PEER) == ""
    denied = caldes_events(unit.caplog.text, "reserved_denied")
    assert len(denied) == burst
    assert all("suppressed" not in e for e in denied)

    # Nella stessa finestra un altro nome ha il proprio limite.
    unit.backend.set(mode="unavailable")
    for _ in range(3):
        with pytest.raises(caldes_auth.BackendUnavailableError):
            unit.login(auth, *IPHONE)
    assert len(caldes_events(unit.caplog.text, "backend_error")) == 3

    clock.advance(61)
    assert unit.login(auth, "caldes-svc", "sbagliata", peer=UNIT_GATEWAY_PEER) == ""
    denied = caldes_events(unit.caplog.text, "reserved_denied")
    assert len(denied) == burst + 1
    assert denied[-1]["suppressed"] == 25
    # Il conteggio riparte: la riga successiva non lo ripete.
    assert unit.login(auth, "caldes-svc", "sbagliata", peer=UNIT_GATEWAY_PEER) == ""
    assert "suppressed" not in caldes_events(unit.caplog.text, "reserved_denied")[-1]


def test_username_riservati_non_entrano_mai_nel_ramo_device(unit: SimpleNamespace) -> None:
    # Anche se il backend li accettasse (route difettosa) e anche col backend giù.
    stolen = [
        {"username": "caldes-svc", "password": "app-password-rubata"},
        {"username": "CALDES-SVC", "password": "app-password-rubata"},
        {"username": "Caldes-Probe", "password": "app-password-rubata"},
        {"username": "caldes-mario", "password": "app-password-rubata"},
    ]
    unit.backend.set(reject_reserved=False, users=stolen)
    auth = unit.make()
    for mode in ("ok", "unavailable", "drop"):
        unit.backend.set(mode=mode)
        for user in stolen:
            assert unit.login(auth, user["username"], user["password"]) == "", (mode, user["username"])
    assert unit.backend.calls() == []


# ═══ Unità: device ═══════════════════════════════


def test_qualsiasi_app_password_valida_diventa_il_principal_canonico(unit: SimpleNamespace) -> None:
    unit.backend.set(users=[{"username": IPHONE[0], "password": IPHONE[1]}, {"username": "mac", "password": "test-only-mac"}])
    auth = unit.make()
    assert unit.login(auth, *IPHONE) == PRINCIPAL
    assert unit.login(auth, "mac", "test-only-mac") == PRINCIPAL
    assert unit.login(auth, IPHONE[0], "sbagliata") == ""

    calls = unit.backend.calls()
    assert [c["username"] for c in calls] == ["iphone", "mac", "iphone"]
    assert all(c["authorization_valid"] and c["x_forwarded_for"] == GATEWAY_IP for c in calls)
    assert all(c["content_type"] == "application/json" and c["user_agent"] == "caldes-auth/1" for c in calls)
    assert calls[0]["password_sha256"] == sha256_hex(IPHONE[1])
    assert calls[0]["path"] == "/api/caldav-backend/verify-credentials"

    # Il principal del backend è solo informativo: una differenza si registra, l'esito resta federico.
    unit.backend.set(principal_mode="username", users=[{"username": "ipad", "password": "test-only-ipad"}])
    assert unit.login(auth, "ipad", "test-only-ipad") == PRINCIPAL
    mismatch = caldes_events(unit.caplog.text, "principal_mismatch")
    assert mismatch == [{"event": "principal_mismatch", "plugin": "caldes_auth", "login": "ipad", "backend_principal": "ipad"}]


def test_x_forwarded_for_solo_da_un_x_remote_addr_valido(unit: SimpleNamespace, clock: FakeClock) -> None:
    users = [{"username": "dev%d" % i, "password": "test-only-dev%d" % i} for i in range(5)]
    unit.backend.set(users=users)
    auth = unit.make()
    assert unit.login(auth, "dev0", "test-only-dev0", xra="2001:DB8::7") == PRINCIPAL
    assert unit.login(auth, "dev1", "test-only-dev1", xra=None) == PRINCIPAL
    assert unit.login(auth, "dev2", "test-only-dev2", xra="203.0.113.7, 10.0.0.1") == PRINCIPAL
    clock.advance(61)
    assert unit.login(auth, "dev3", "test-only-dev3", xra="") == PRINCIPAL
    assert [c["x_forwarded_for"] for c in unit.backend.calls()] == ["2001:db8::7", None, None, None]
    # Al massimo un evento al minuto.
    events = caldes_events(unit.caplog.text, "missing_x_remote_addr")
    assert [(e["peer"], e["reason"]) for e in events] == [(UNIT_GATEWAY_PEER, "absent"), (UNIT_GATEWAY_PEER, "absent")]


def test_x_remote_addr_solo_dal_peer_della_porta_pubblicata(unit: SimpleNamespace, monkeypatch: pytest.MonkeyPatch, clock: FakeClock) -> None:
    """
    Con CALDES_XRA_PEER_CIDR (il gateway della rete dav-pub) un altro
    container che raggiunge Radicale direttamente non sceglie l'IP con cui
    l'API conta il rate limit e registra last_used_ip: il suo X-Remote-Addr
    vale come assente.
    """
    monkeypatch.setenv("CALDES_XRA_PEER_CIDR", "172.18.0.0/29")
    unit.backend.set(users=[{"username": IPHONE[0], "password": IPHONE[1]}])
    auth = unit.make()
    assert "X-Remote-Addr da 172.18.0.0/29" in unit.caplog.text
    assert unit.login(auth, *IPHONE, peer=UNIT_GATEWAY_PEER, xra="203.0.113.7") == PRINCIPAL
    clock.advance(61)
    assert unit.login(auth, *IPHONE, peer="172.18.0.9", xra="198.51.100.7") == PRINCIPAL
    clock.advance(61)
    assert unit.login(auth, *IPHONE, peer="::ffff:172.18.0.1", xra="203.0.113.8") == PRINCIPAL
    assert [c["x_forwarded_for"] for c in unit.backend.calls()] == ["203.0.113.7", None, "203.0.113.8"]
    events = caldes_events(unit.caplog.text, "missing_x_remote_addr")
    assert [(e["peer"], e["reason"]) for e in events] == [("172.18.0.9", "untrusted_peer")]


@pytest.mark.parametrize(
    "login,password",
    [
        ("i" * 256, IPHONE[1]),
        ("è" * 128, IPHONE[1]),
        ("iph\x00one", IPHONE[1]),
        ("iph\tone", IPHONE[1]),
        ("iph\x7fone", IPHONE[1]),
        ("iph\x85one", IPHONE[1]),
        ("iphone", ""),
        ("iphone", "p" * 1025),
    ],
    ids=["256-byte", "256-byte-utf8", "nul", "tab", "del", "c1", "password-vuota", "password-1025"],
)
def test_login_non_inoltrabili_rifiutati_senza_chiamare_il_backend(unit: SimpleNamespace, login: str, password: str) -> None:
    auth = unit.make()
    assert unit.login(auth, login, password) == ""
    assert unit.backend.calls() == []


def test_login_di_255_byte_inoltrato(unit: SimpleNamespace) -> None:
    login = "è" * 127 + "x"  # 255 byte UTF-8
    unit.backend.set(users=[{"username": login, "password": "test-only-lungo"}])
    auth = unit.make()
    assert unit.login(auth, login, "test-only-lungo") == PRINCIPAL
    assert [c["username"] for c in unit.backend.calls()] == [login]


def test_cache_in_memoria_di_60_secondi_e_401_esplicito(unit: SimpleNamespace, clock: FakeClock) -> None:
    unit.backend.set(users=[{"username": IPHONE[0], "password": IPHONE[1]}])
    auth = unit.make()
    count = lambda: len(unit.backend.calls())  # noqa: E731
    assert unit.login(auth, *IPHONE) == PRINCIPAL and count() == 1
    clock.advance(30)
    assert unit.login(auth, *IPHONE) == PRINCIPAL and count() == 1, "entro 60 s nessuna chiamata"
    assert unit.login(auth, IPHONE[0], "altra-password") == "" and count() == 2, "un'altra password non usa la cache"
    clock.advance(30.5)
    assert unit.login(auth, *IPHONE) == PRINCIPAL and count() == 3, "dopo 60 s si riconferma col backend"

    # 401 {ok:false}: la voce esce dalla cache in memoria (e da quella persistita).
    unit.backend.set(mode="deny")
    clock.advance(61)
    assert unit.login(auth, *IPHONE) == "" and count() == 4
    unit.backend.set(mode="unavailable")
    with pytest.raises(caldes_auth.BackendUnavailableError):
        unit.login(auth, *IPHONE)
    unit.backend.set(mode="ok")
    assert unit.login(auth, *IPHONE) == PRINCIPAL and count() == 6


FAILURES = [
    ("unavailable", {"mode": "unavailable"}, {"status": 503}),
    ("error", {"mode": "error"}, {"status": 500}),
    ("garbage", {"mode": "garbage"}, {"status": 200, "error": "out_of_contract"}),
    ("drop", {"mode": "drop"}, {"error": "connection_closed"}),
    ("slow", {"mode": "slow", "delay_ms": 1500}, {"error": "timeout"}),
    ("bearer", {"token": "un-altro-token"}, {"status": 401, "error": "bearer_rejected"}),
    ("refused", None, {"error": "connection_refused"}),
]


@pytest.mark.parametrize("label,patch,expected", FAILURES, ids=[f[0] for f in FAILURES])
def test_backend_in_errore_senza_cache_solleva_eccezione(
    unit: SimpleNamespace, monkeypatch: pytest.MonkeyPatch, label: str, patch: Optional[Dict[str, Any]], expected: Dict[str, Any]
) -> None:
    unit.backend.set(users=[{"username": IPHONE[0], "password": IPHONE[1]}])
    if patch is None:
        monkeypatch.setenv("CALDAV_BACKEND_URL", "http://127.0.0.1:%d/api/caldav-backend" % closed_port())
    else:
        unit.backend.set(**patch)
    auth = unit.make()
    started = time.monotonic()
    with pytest.raises(caldes_auth.BackendUnavailableError) as info:
        unit.login(auth, *IPHONE)
    elapsed = time.monotonic() - started
    assert elapsed < 1.6, "timeout complessivo di 1 s"
    if label == "slow":
        assert elapsed >= 0.95
        unit.backend.wait_for_calls(lambda calls: any(c["mode"] == "slow" for c in calls))
    assert IPHONE[1] not in str(info.value)
    events = caldes_events(unit.caplog.text, "backend_error")
    assert len(events) == 1
    for field, value in expected.items():
        assert events[0][field] == value, (field, events[0])
    assert events[0]["login"] == "iphone"
    assert any(r.levelno == logging.ERROR and "backend_error" in r.getMessage() for r in unit.caplog.records)


def test_429_e_una_negazione_temporanea_mai_stale_if_error(unit: SimpleNamespace, clock: FakeClock) -> None:
    """
    L'API conta solo i tentativi falliti e verifica sempre la password prima
    del limite: un 429 vuol dire "password sbagliata, troppe volte". Il
    plugin risponde "" (Radicale: 401 dopo il delay) senza consultare la
    cache persistita: esaurire il proprio bucket non dà un confronto senza
    ritardo contro credenziali che il database non ha più.
    """
    unit.backend.set(users=[{"username": IPHONE[0], "password": IPHONE[1]}])
    auth = unit.make()
    assert unit.login(auth, *IPHONE) == PRINCIPAL
    key = expected_cache_key(0, *IPHONE)
    assert key in read_authcache(unit.authcache)["entries"]

    # La riga sparisce dal database (ripristino) e qualcuno esaurisce il bucket.
    clock.advance(61)
    unit.backend.set(mode="rate_limited")
    assert unit.login(auth, *IPHONE) == "", "la cache persistita non si consulta con un 429"
    assert unit.login(auth, IPHONE[0], "sbagliata") == ""
    assert caldes_events(unit.caplog.text, "stale_if_error") == []
    assert caldes_events(unit.caplog.text, "backend_error") == []
    limited = caldes_events(unit.caplog.text, "rate_limited")
    assert [(e["login"], e["status"]) for e in limited] == [("iphone", 429), ("iphone", 429)]
    # Le cache restano: il 429 non è la negazione esplicita del contratto.
    assert key in read_authcache(unit.authcache)["entries"]

    # Con un errore vero del backend la cache persistita torna a valere.
    unit.backend.set(mode="unavailable")
    assert unit.login(auth, *IPHONE) == PRINCIPAL
    assert caldes_events(unit.caplog.text, "stale_if_error")


def test_timeout_complessivo_anche_sulla_risoluzione_dns(unit: SimpleNamespace, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CALDAV_BACKEND_URL", "http://api-int.caldes.test:3001/api/caldav-backend")
    auth = unit.make()
    release = threading.Event()

    def stuck_getaddrinfo(host: str, *args: Any, **kwargs: Any) -> Any:
        # Resolver bloccato: si sblocca solo a fine test, senza mai interrogare un DNS reale.
        release.wait(10)
        raise socket.gaierror(socket.EAI_AGAIN, "resolver bloccato (test)")

    monkeypatch.setattr(socket, "getaddrinfo", stuck_getaddrinfo)
    started = time.monotonic()
    try:
        with pytest.raises(caldes_auth.BackendUnavailableError):
            unit.login(auth, *IPHONE)
        assert time.monotonic() - started < 1.6
    finally:
        release.set()
    assert caldes_events(unit.caplog.text, "backend_error")[0]["error"] == "timeout"


def test_backend_raggiunto_per_nome_host(unit: SimpleNamespace, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CALDAV_BACKEND_URL", unit.backend.backend_url.replace("127.0.0.1", "localhost"))
    unit.backend.set(users=[{"username": IPHONE[0], "password": IPHONE[1]}])
    assert unit.login(unit.make(), *IPHONE) == PRINCIPAL


@pytest.mark.parametrize(
    "framing",
    ["content-length-close", "content-length-keep-alive", "chunked-close", "until-eof"],
)
def test_lettura_della_risposta_con_ogni_framing_http(framing: str) -> None:
    """
    La risposta della vera API Node (@hono/node-server) a una richiesta con
    "Connection: close" porta "Connection: close" e Content-Length: http.client
    passa allora il socket alla risposta, che lo chiude dopo l'ultimo byte. Il
    ciclo di lettura non deve più toccare il socket (prima: OSError EBADF, cioè
    500 a ogni login di un device contro l'API reale).
    """
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    payload = b'{"ok": true, "principal": "federico", "expires_at": null}'
    received: List[Dict[str, Any]] = []

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            pass

        def do_POST(self) -> None:  # noqa: N802
            length = int(self.headers.get("Content-Length") or 0)
            received.append({"path": self.path, "connection": self.headers.get("Connection"), "body": self.rfile.read(length)})
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            if framing == "content-length-close":
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(payload)
            elif framing == "content-length-keep-alive":
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Connection", "keep-alive")
                self.end_headers()
                self.wfile.write(payload)
            elif framing == "chunked-close":
                self.send_header("Transfer-Encoding", "chunked")
                self.send_header("Connection", "close")
                self.end_headers()
                half = len(payload) // 2
                for piece in (payload[:half], payload[half:]):
                    self.wfile.write(b"%x\r\n%s\r\n" % (len(piece), piece))
                self.wfile.write(b"0\r\n\r\n")
            else:  # nessuna lunghezza: il corpo finisce con la chiusura della connessione
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(payload)
                self.close_connection = True

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        endpoint = caldes_auth.BackendEndpoint("http", "127.0.0.1", server.server_address[1], "/api/caldav-backend/verify-credentials")
        status, body = caldes_auth.post_verify_credentials(
            endpoint, b'{"username": "iphone", "password": "x"}', {"Content-Type": "application/json", "Connection": "close"}
        )
    finally:
        server.shutdown()
        server.server_close()
    assert status == 200
    assert body == payload
    assert caldes_auth.classify_response(status, body).kind == "ok"
    assert received[0]["path"] == "/api/caldav-backend/verify-credentials"
    assert received[0]["connection"] == "close"


@pytest.mark.parametrize(
    "status,body,kind,extra",
    [
        (200, b'{"ok": true, "principal": "federico", "expires_at": null}', "ok", {"expires_at": None, "expires_known": True}),
        (200, b'{"ok": true, "principal": "federico", "expires_at": "2027-01-15T08:00:00.000Z"}', "ok", {"expires_at": 1800000000.0}),
        (200, b'{"ok": true, "principal": "federico", "expires_at": "domani"}', "ok", {"expires_known": False}),
        (200, b'{"ok": 1, "principal": "federico"}', "error", {"error": "out_of_contract"}),
        (200, b'{"ok": false}', "error", {"error": "out_of_contract"}),
        (200, b"[true]", "error", {"error": "out_of_contract"}),
        (200, b'{"ok": true, "x": NaN}', "error", {}),
        (401, b'{"ok": false}', "denied", {}),
        (401, b'{"error": "Unauthorized"}', "error", {"error": "bearer_rejected"}),
        (401, b"", "error", {"error": "bearer_rejected"}),
        (401, b'{"ok": "false"}', "error", {}),
        (403, b'{"ok": false}', "error", {"status": 403}),
        (429, b'{"error": "Troppi tentativi"}', "rate_limited", {"status": 429}),
        (429, b"", "rate_limited", {"status": 429}),
        (302, b"", "error", {"status": 302}),
        (503, b"<html>", "error", {"status": 503}),
    ],
)
def test_classificazione_delle_risposte_di_verify_credentials(status: int, body: bytes, kind: str, extra: Dict[str, Any]) -> None:
    outcome = caldes_auth.classify_response(status, body)
    assert outcome.kind == kind
    for field, value in extra.items():
        assert getattr(outcome, field) == value, field


# ═══ Unità: cache persistita ═══════════════════════════════


def test_cache_persistita_usata_solo_dopo_un_errore_del_backend(unit: SimpleNamespace, clock: FakeClock) -> None:
    unit.backend.set(users=[{"username": IPHONE[0], "password": IPHONE[1]}])
    count = lambda: len(unit.backend.calls())  # noqa: E731
    auth = unit.make()
    assert unit.login(auth, *IPHONE) == PRINCIPAL and count() == 1

    # File conforme allo schema, 0600, chiave HMAC del contratto, niente in chiaro.
    path = unit.authcache / "authcache.json"
    doc = read_authcache(unit.authcache)
    validate_authcache(doc)
    key = expected_cache_key(0, *IPHONE)
    now = int(clock.wall)
    assert doc == {"schema": 1, "key_id": expected_key_id(), "credential_epoch": 0, "entries": {key: {"exp": now + 86400, "refreshed": now}}}
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    raw = path.read_text(encoding="utf-8")
    assert IPHONE[0] not in raw and IPHONE[1] not in raw
    assert not [p for p in unit.authcache.iterdir() if p.name != "authcache.json"], "nessun temporaneo residuo"

    # Riavvio (cache in memoria vuota) col backend su: si chiama il backend, non la cache persistita.
    auth = unit.make()
    assert unit.login(auth, *IPHONE) == PRINCIPAL and count() == 2

    # Riavvio col backend giù: stale-if-error; l'esito stale non alimenta la cache in memoria.
    auth = unit.make()
    unit.backend.set(mode="unavailable")
    assert unit.login(auth, *IPHONE) == PRINCIPAL and count() == 3
    assert unit.login(auth, *IPHONE) == PRINCIPAL and count() == 4
    assert [e["login"] for e in caldes_events(unit.caplog.text, "stale_if_error")] == ["iphone", "iphone"]

    # 401 esplicito: mai la cache, e la voce sparisce dal file.
    unit.backend.set(mode="deny")
    assert unit.login(auth, *IPHONE) == ""
    assert read_authcache(unit.authcache)["entries"] == {}
    unit.backend.set(mode="unavailable")
    with pytest.raises(caldes_auth.BackendUnavailableError):
        unit.login(auth, *IPHONE)


def test_ttl_della_cache_persistita_e_scadenza_dell_app_password(unit: SimpleNamespace, clock: FakeClock) -> None:
    t0 = clock.wall
    unit.backend.set(
        users=[
            {"username": IPHONE[0], "password": IPHONE[1]},
            {"username": "mac", "password": "test-only-mac", "expires_at": iso(t0 + 600)},
            {"username": "ipad", "password": "test-only-ipad", "expires_at": iso(t0 + 30)},
            {"username": "vecchio", "password": "test-only-vecchio", "expires_at": iso(t0 - 1)},
            {"username": "strano", "password": "test-only-strano", "expires_at": "domani"},
            {"username": "nullo", "password": "test-only-nullo", "expires_at": None},
        ]
    )
    auth = unit.make()
    for user, password in [IPHONE, ("mac", "test-only-mac"), ("ipad", "test-only-ipad"), ("vecchio", "test-only-vecchio"), ("strano", "test-only-strano"), ("nullo", "test-only-nullo")]:
        assert unit.login(auth, user, password) == PRINCIPAL, user
    entries = read_authcache(unit.authcache)["entries"]
    now = int(t0)
    assert entries == {
        expected_cache_key(0, *IPHONE): {"exp": now + 86400, "refreshed": now},
        expected_cache_key(0, "mac", "test-only-mac"): {"exp": now + 600, "refreshed": now},
        expected_cache_key(0, "ipad", "test-only-ipad"): {"exp": now + 30, "refreshed": now},
        expected_cache_key(0, "nullo", "test-only-nullo"): {"exp": now + 86400, "refreshed": now},
    }, "scadenza passata o non valida → nessuna voce persistita"

    # La cache in memoria rispetta expires_at: ipad scade dopo 30 s, non 60.
    calls_before = len(unit.backend.calls())
    clock.advance(31)
    assert unit.login(auth, "ipad", "test-only-ipad") == PRINCIPAL
    assert len(unit.backend.calls()) == calls_before + 1
    # Le voci senza cache in memoria (scadenza passata o non valida) chiamano sempre il backend.
    assert unit.login(auth, "strano", "test-only-strano") == PRINCIPAL
    assert len(unit.backend.calls()) == calls_before + 2

    unit.backend.set(mode="unavailable")
    clock.advance(600 - 31)  # t0 + 600: mac appena scaduto
    auth = unit.make()
    with pytest.raises(caldes_auth.BackendUnavailableError):
        unit.login(auth, "mac", "test-only-mac")
    clock.advance(86400 - 600 - 1)  # t0 + 86399: iphone ancora valido
    assert unit.login(auth, *IPHONE) == PRINCIPAL
    clock.advance(1)  # t0 + 86400: scaduto
    with pytest.raises(caldes_auth.BackendUnavailableError):
        unit.login(auth, *IPHONE)


def test_voce_persistita_riscritta_solo_se_confermata_da_piu_di_un_ora(unit: SimpleNamespace, clock: FakeClock) -> None:
    unit.backend.set(users=[{"username": IPHONE[0], "password": IPHONE[1]}])
    auth = unit.make()
    key = expected_cache_key(0, *IPHONE)
    t0 = int(clock.wall)
    assert unit.login(auth, *IPHONE) == PRINCIPAL
    inode = (unit.authcache / "authcache.json").stat().st_ino
    clock.advance(1800)
    assert unit.login(auth, *IPHONE) == PRINCIPAL
    assert (unit.authcache / "authcache.json").stat().st_ino == inode, "nessuna riscrittura entro un'ora"
    assert read_authcache(unit.authcache)["entries"][key] == {"exp": t0 + 86400, "refreshed": t0}
    clock.advance(1801)
    assert unit.login(auth, *IPHONE) == PRINCIPAL
    assert read_authcache(unit.authcache)["entries"][key] == {"exp": t0 + 3601 + 86400, "refreshed": t0 + 3601}


def test_limiti_delle_due_cache(unit: SimpleNamespace, clock: FakeClock) -> None:
    auth = unit.make()
    epoch = auth._sync_credential_epoch()
    assert epoch == 0
    keys = [hashlib.sha256(b"voce-%d" % i).hexdigest() for i in range(1100)]
    for key in keys:
        clock.advance(1)
        auth._remember(key, epoch, caldes_auth.VerifyOutcome(caldes_auth.OK))
    # In memoria al massimo 1024 voci (LRU), persistite al massimo 256 (le confermate più di recente).
    assert len(auth._memory) == 1024 and list(auth._memory)[-1] == keys[-1] and keys[0] not in auth._memory
    entries = read_authcache(unit.authcache)["entries"]
    assert set(entries) == set(keys[-256:])


def test_file_della_cache_illeggibile_di_altro_schema_o_di_altra_chiave(unit: SimpleNamespace, clock: FakeClock) -> None:
    unit.backend.set(users=[{"username": IPHONE[0], "password": IPHONE[1]}])
    key = expected_cache_key(0, *IPHONE)
    valid_entry = {key: {"exp": int(clock.wall) + 1000, "refreshed": int(clock.wall)}}
    many = {hashlib.sha256(b"%d" % i).hexdigest(): {"exp": int(clock.wall) + 1000, "refreshed": 1} for i in range(256)}
    many[key] = valid_entry[key]
    variants = [
        b"{non json",
        b"\xff\xfe",
        json.dumps({"schema": 2, "key_id": expected_key_id(), "credential_epoch": 0, "entries": valid_entry}).encode(),
        json.dumps({"schema": 1, "key_id": expected_key_id("un'altra-chiave-0123456789abcdef"), "credential_epoch": 0, "entries": valid_entry}).encode(),
        json.dumps({"schema": 1, "key_id": expected_key_id(), "credential_epoch": -1, "entries": valid_entry}).encode(),
        json.dumps({"schema": 1, "key_id": expected_key_id(), "credential_epoch": 0, "entries": many}).encode(),
        json.dumps({"schema": 1, "key_id": expected_key_id(), "credential_epoch": 0, "entries": {key: {"exp": "domani", "refreshed": 1}}}).encode(),
    ]
    unit.authcache.mkdir(parents=True, exist_ok=True)
    for data in variants:
        write_atomic(unit.authcache / "authcache.json", data)
        auth = unit.make()
        unit.backend.set(mode="unavailable")
        with pytest.raises(caldes_auth.BackendUnavailableError):
            unit.login(auth, *IPHONE)
    # Al primo successo il file torna valido con la chiave corrente.
    unit.backend.set(mode="ok")
    assert unit.login(auth, *IPHONE) == PRINCIPAL
    doc = read_authcache(unit.authcache)
    validate_authcache(doc)
    assert doc["key_id"] == expected_key_id() and list(doc["entries"]) == [key]

    # Controprova: lo stesso file valido viene usato come stale-if-error.
    auth = unit.make()
    unit.backend.set(mode="unavailable")
    assert unit.login(auth, *IPHONE) == PRINCIPAL


# ═══ Unità: revoca e policy ═══════════════════════════════


def test_revoca_tramite_credential_epoch_svuota_entrambe_le_cache(unit: SimpleNamespace, clock: FakeClock) -> None:
    unit.backend.set(users=[{"username": IPHONE[0], "password": IPHONE[1]}])
    auth = unit.make()
    assert unit.login(auth, *IPHONE) == PRINCIPAL
    assert len(read_authcache(unit.authcache)["entries"]) == 1

    # Revoca: l'API incrementa credential_epoch e riscrive la policy.
    write_policy(unit.policy, 1)
    clock.advance(1.1)
    unit.backend.set(mode="deny")
    assert unit.login(auth, *IPHONE) == "", "la cache in memoria (validata 1 s fa) non vale dopo la revoca"
    assert read_authcache(unit.authcache) == {"schema": 1, "key_id": expected_key_id(), "credential_epoch": 1, "entries": {}}
    unit.backend.set(mode="unavailable")
    with pytest.raises(caldes_auth.BackendUnavailableError):
        unit.login(auth, *IPHONE)
    assert caldes_events(unit.caplog.text, "credential_epoch_changed") == [
        {"event": "credential_epoch_changed", "plugin": "caldes_auth", "old": 0, "new": 1}
    ]

    # Nuova conferma all'epoch 1, poi un cambio all'indietro: svuota di nuovo.
    unit.backend.set(mode="ok")
    assert unit.login(auth, *IPHONE) == PRINCIPAL
    assert list(read_authcache(unit.authcache)["entries"]) == [expected_cache_key(1, *IPHONE)]
    write_policy(unit.policy, 0)
    clock.advance(1.1)
    unit.backend.set(mode="unavailable")
    with pytest.raises(caldes_auth.BackendUnavailableError):
        unit.login(auth, *IPHONE)
    assert read_authcache(unit.authcache)["credential_epoch"] == 0
    assert read_authcache(unit.authcache)["entries"] == {}

    # All'avvio un file di un epoch vecchio viene svuotato subito.
    unit.backend.set(mode="ok")
    assert unit.login(auth, *IPHONE) == PRINCIPAL
    write_policy(unit.policy, 7)
    unit.make()
    assert read_authcache(unit.authcache) == {"schema": 1, "key_id": expected_key_id(), "credential_epoch": 7, "entries": {}}


def test_policy_assente_o_invalida_rende_inutilizzabili_le_cache_senza_cancellarle(unit: SimpleNamespace, clock: FakeClock) -> None:
    unit.backend.set(users=[{"username": IPHONE[0], "password": IPHONE[1]}])
    count = lambda: len(unit.backend.calls())  # noqa: E731
    auth = unit.make()
    assert unit.login(auth, *IPHONE) == PRINCIPAL and count() == 1
    before = read_authcache(unit.authcache)

    write_atomic(unit.policy, b'{"schema": 1, "mode": "li')
    clock.advance(1.1)
    assert unit.login(auth, *IPHONE) == PRINCIPAL and count() == 2, "epoch sconosciuto: niente cache in memoria"
    unit.backend.set(mode="unavailable")
    with pytest.raises(caldes_auth.BackendUnavailableError):
        unit.login(auth, *IPHONE)
    unit.policy.unlink()
    clock.advance(1.1)
    with pytest.raises(caldes_auth.BackendUnavailableError):
        unit.login(auth, *IPHONE)
    assert read_authcache(unit.authcache) == before, "le cache non si toccano"
    invalid = caldes_events(unit.caplog.text, "policy_invalid")
    assert len(invalid) == 1 and invalid[0]["reason"] == "JSON non valido", "un solo evento per passaggio"

    # La policy torna con lo stesso epoch: le voci tornano utilizzabili.
    write_policy(unit.policy, 0)
    clock.advance(1.1)
    assert unit.login(auth, *IPHONE) == PRINCIPAL, "cache in memoria ancora valida"
    clock.advance(61)
    assert unit.login(auth, *IPHONE) == PRINCIPAL, "stale-if-error dalla cache persistita"
    assert len(caldes_events(unit.caplog.text, "policy_valid")) == 1


def test_401_esplicito_con_policy_illeggibile_toglie_la_voce_dell_ultimo_epoch(unit: SimpleNamespace, clock: FakeClock) -> None:
    unit.backend.set(users=[{"username": IPHONE[0], "password": IPHONE[1]}])
    auth = unit.make()
    assert unit.login(auth, *IPHONE) == PRINCIPAL
    write_atomic(unit.policy, b"non json")
    clock.advance(1.1)
    unit.backend.set(mode="deny")
    assert unit.login(auth, *IPHONE) == ""
    assert read_authcache(unit.authcache)["entries"] == {}
    # La policy rientra con lo stesso epoch: la credenziale negata non torna utilizzabile.
    write_policy(unit.policy, 0)
    clock.advance(1.1)
    unit.backend.set(mode="unavailable")
    with pytest.raises(caldes_auth.BackendUnavailableError):
        unit.login(auth, *IPHONE)


def test_policy_di_un_altro_principal_vale_come_invalida(unit: SimpleNamespace, clock: FakeClock) -> None:
    write_policy(unit.policy, 0, principal="mario")
    auth = unit.make()
    assert auth._policy.credential_epoch() is None
    assert caldes_events(unit.caplog.text, "policy_invalid")[0]["reason"] == "principal diverso da quello configurato"


def test_policy_ricontrollata_al_massimo_una_volta_al_secondo(tmp_path: Path, clock: FakeClock) -> None:
    path = tmp_path / "policy.json"
    write_policy(path, 3)
    watcher = caldes_auth.PolicyWatcher(str(path), PRINCIPAL)
    assert watcher.credential_epoch() == 3
    write_policy(path, 4)
    clock.advance(0.5)
    assert watcher.credential_epoch() == 3
    clock.advance(0.5)
    assert watcher.credential_epoch() == 4
    # Contenuto invariato (stessa firma del file): nessuna rilettura.
    clock.advance(1)
    assert watcher.credential_epoch() == 4


def _effective_mode_cases() -> List[Dict[str, Any]]:
    data = json.loads((CONTRACTS_DIR / "fixtures" / "effective-mode.cases.json").read_text(encoding="utf-8"))
    return [dict(case, principal=data["principal"]) for case in data["cases"]]


@pytest.mark.parametrize("case", _effective_mode_cases(), ids=lambda c: c["name"])
def test_policy_conforme_ai_casi_condivisi(tmp_path: Path, clock: FakeClock, case: Dict[str, Any]) -> None:
    """Stessa validità della policy di parsePolicy/effectiveDeviceMode (fixtures/effective-mode.cases.json)."""
    path = tmp_path / "policy.json"
    if case.get("policy_text") is not None:
        write_atomic(path, case["policy_text"].encode("utf-8"))
    elif case.get("policy") is not None:
        write_atomic(path, json.dumps(case["policy"]).encode("utf-8"))
    epoch = caldes_auth.PolicyWatcher(str(path), case["principal"]).credential_epoch()
    reasons = set(case["expected"]["reasons"])
    if reasons & {"policy_invalid", "policy_missing"}:
        assert epoch is None
    else:
        assert epoch == case["policy"]["credential_epoch"]


def _valid_policy() -> Dict[str, Any]:
    return policy_doc(2, volume_id="3f2b8c1e-7d4a-4e9b-9c2a-1b2c3d4e5f60", epoch=1)


POLICY_VARIANTS = [
    # (descrizione, modifica, valida)
    ("base", {}, True),
    ("generated_at con offset", {"generated_at": "2026-10-09T20:00:00+02:00"}, True),
    ("generated_at con 9 decimali", {"generated_at": "2026-10-09T18:00:00.123456789Z"}, True),
    ("generated_at senza fuso", {"generated_at": "2026-10-09T18:00:00"}, False),
    ("generated_at 30 febbraio", {"generated_at": "2026-02-30T18:00:00Z"}, False),
    ("generated_at secondi 60", {"generated_at": "2026-10-09T18:00:60Z"}, False),
    ("generated_at offset +24:00", {"generated_at": "2026-10-09T18:00:00+24:00"}, False),
    ("generated_at con a capo", {"generated_at": "2026-10-09T18:00:00Z\n"}, False),
    ("generated_at con cifre non ASCII", {"generated_at": "2026-10-09T18:00:0٠Z"}, False),
    ("version 0", {"version": 0}, False),
    ("version float integrale", {"version": 1.0}, True),
    ("version booleana", {"version": True}, False),
    ("schema 1.0", {"schema": 1.0}, True),
    ("credential_epoch negativo", {"credential_epoch": -1}, False),
    ("credential_epoch oltre int32", {"credential_epoch": 2147483648}, False),
    ("credential_epoch massimo", {"credential_epoch": 2147483647}, True),
    ("credential_epoch frazionario", {"credential_epoch": 2.5}, False),
    ("credential_epoch stringa", {"credential_epoch": "2"}, False),
    ("credential_epoch assente", {"credential_epoch": None}, False),
    ("reasons sconosciuti", {"reasons": ["nuovo_motivo"]}, True),
    ("reasons non stringa", {"reasons": [1]}, False),
    ("backend_mode sconosciuto", {"backend_mode": "ibrido"}, False),
    ("principal riservato", {"principal": "caldes-svc"}, False),
    ("volume_id maiuscolo", {"volume_id": "3F2B8C1E-7D4A-4E9B-9C2A-1B2C3D4E5F60"}, True),
    ("volume_id non UUID", {"volume_id": "volume-1"}, False),
    ("volume senza epoch", {"epoch": 0}, False),
    ("live senza volume", {"mode": "live", "backend_mode": "radicale", "volume_id": None, "epoch": 0}, False),
    ("readonly con punto iniziale", {"readonly": [".nascosta"]}, False),
    ("readonly con backslash", {"readonly": ["a\\b"]}, False),
    ("readonly 256 byte", {"readonly": ["è" * 128]}, False),
    ("readonly 254 byte", {"readonly": ["è" * 127]}, True),
    ("hidden con prefisso _", {"hidden": ["_canary", "_altro"]}, True),
    ("hidden non lista", {"hidden": "_canary"}, False),
    ("campo sconosciuto", {"futuro": {"a": 1}}, True),
]


@pytest.mark.parametrize("label,change,valid", POLICY_VARIANTS, ids=[v[0] for v in POLICY_VARIANTS])
def test_validazione_della_policy(label: str, change: Dict[str, Any], valid: bool) -> None:
    doc = _valid_policy()
    for field, value in change.items():
        if value is None and field == "credential_epoch":
            del doc[field]
        else:
            doc[field] = value
    data = json.dumps(doc, ensure_ascii=False).encode("utf-8")
    if valid:
        assert caldes_auth.parse_policy_bytes(data, PRINCIPAL) == doc["credential_epoch"]
    else:
        with pytest.raises(caldes_auth.PolicyError):
            caldes_auth.parse_policy_bytes(data, PRINCIPAL)


def test_validazione_della_policy_a_livello_di_byte() -> None:
    base = json.dumps(_valid_policy()).encode("utf-8")
    invalid = {
        "BOM": b"\xef\xbb\xbf" + base,
        "latin-1": base.replace(b'"shadow"', '"shàdow"'.encode("latin-1")),
        "NaN": base.replace(b'"credential_epoch": 2', b'"credential_epoch": NaN'),
        "Infinity": base.replace(b'"credential_epoch": 2', b'"credential_epoch": Infinity'),
        "oltre 64 KiB": base + b" " * (65536 - len(base) + 1),
        "annidamento profondo": b"[" * 200000,
        "array": b"[]",
    }
    for label, data in invalid.items():
        with pytest.raises(caldes_auth.PolicyError):
            caldes_auth.parse_policy_bytes(data, PRINCIPAL)
        assert label
    exact = base + b" " * (65536 - len(base))
    assert len(exact) == 65536
    assert caldes_auth.parse_policy_bytes(exact, PRINCIPAL) == 2


def test_nessun_segreto_nei_log(unit: SimpleNamespace, clock: FakeClock) -> None:
    unit.backend.set(users=[{"username": IPHONE[0], "password": IPHONE[1]}])
    auth = unit.make()
    unit.login(auth, *IPHONE)
    unit.login(auth, IPHONE[0], "password-sbagliata-segreta")
    unit.login(auth, "caldes-svc", SVC_PASSWORD, peer=UNIT_GATEWAY_PEER)
    clock.advance(61)
    unit.backend.set(mode="unavailable")
    unit.login(auth, *IPHONE)
    with pytest.raises(caldes_auth.BackendUnavailableError):
        unit.login(auth, IPHONE[0], "password-sbagliata-segreta")
    text = unit.caplog.text
    for secret in SECRETS + ("password-sbagliata-segreta", expected_cache_key(0, *IPHONE)):
        assert secret not in text


# ═══ Integrazione: Radicale 3.7.8 reale ═══════════════════════════════

needs_loopback_aliases = pytest.mark.skipif(
    not (can_bind(INTERNAL_SRC) and can_bind(GATEWAY_SRC)),
    reason="127.0.0.2/127.0.0.3 non utilizzabili come indirizzi sorgente su questo sistema",
)


def e2e_dirs(root: Path, backend: MockVerify, credential_epoch: int = 0) -> SimpleNamespace:
    policy = root / "control" / "policy.json"
    authcache = root / "authcache"
    write_policy(policy, credential_epoch)
    env = plugin_env(backend_url=backend.backend_url, policy_file=policy, authcache_dir=authcache, cidr=E2E_CIDR)
    return SimpleNamespace(root=root, policy=policy, authcache=authcache, env=env)


@pytest.fixture(scope="module")
def shared_server(tmp_path_factory: pytest.TempPathFactory, mock: MockVerify) -> Iterator[RadicaleServer]:
    """Un Radicale per i casi che non toccano policy né cache persistita (utenti diversi per test)."""
    dirs = e2e_dirs(tmp_path_factory.mktemp("radicale-condiviso"), mock)
    server = RadicaleServer(dirs.root / "server", dirs.env, label="radicale-condiviso").start()
    try:
        yield server
    finally:
        server.stop()


def test_radicale_reale_carica_il_plugin_e_l_healthcheck_del_probe_risponde(shared_server: RadicaleServer, backend: MockVerify) -> None:
    assert "caldes_auth: principal 'federico'" in shared_server.logs()
    # Healthcheck: PROPFIND Depth:0 sulla root come caldes-probe da 127.0.0.1 (anche su un volume vuoto).
    response = shared_server.propfind("/", user="caldes-probe", password=PROBE_PASSWORD, source="127.0.0.1")
    assert response.status == 207
    assert shared_server.propfind("/", source="127.0.0.1").status == 401, "senza credenziali"
    assert backend.calls() == []


@needs_loopback_aliases
def test_svc_dal_peer_interno_accettato_dal_gateway_rifiutato(shared_server: RadicaleServer, backend: MockVerify) -> None:
    mark = shared_server.mark()
    svc = {"user": "caldes-svc", "password": SVC_PASSWORD}
    probe = {"user": "caldes-probe", "password": PROBE_PASSWORD}
    assert shared_server.propfind("/", source=INTERNAL_SRC, **svc).status == 207
    assert shared_server.propfind("/", source=GATEWAY_SRC, **svc).status == 401
    assert shared_server.propfind("/", source="127.0.0.1", **svc).status == 401, "127.0.0.1 vale solo per il probe"
    # Un header non sposta il peer: X-Remote-Addr interno dal gateway resta rifiutato.
    assert shared_server.propfind("/", source=GATEWAY_SRC, headers={"X-Remote-Addr": INTERNAL_SRC}, **svc).status == 401
    assert shared_server.propfind("/", source=INTERNAL_SRC, user="caldes-svc", password="sbagliata").status == 401
    assert shared_server.propfind("/", source=INTERNAL_SRC, **probe).status == 207
    assert shared_server.propfind("/", source=GATEWAY_SRC, **probe).status == 401
    assert backend.calls() == [], "nessun login riservato arriva a verify-credentials"
    denied = caldes_events(shared_server.logs(mark), "reserved_denied")
    assert {(e["login"], e["peer"], e["reason"]) for e in denied} == {
        ("caldes-svc", GATEWAY_SRC, "peer"),
        ("caldes-svc", "127.0.0.1", "peer"),
        ("caldes-svc", INTERNAL_SRC, "password"),
        ("caldes-probe", GATEWAY_SRC, "peer"),
    }


@needs_loopback_aliases
def test_caldes_svc_come_app_password_dal_gateway_401_mai_ramo_device(shared_server: RadicaleServer, backend: MockVerify) -> None:
    backend.set(reject_reserved=False, users=[{"username": "caldes-svc", "password": "app-password-rubata"}, {"username": "caldes-mario", "password": "app-password-rubata"}])
    headers = {"X-Remote-Addr": GATEWAY_IP}
    for mode in ("ok", "unavailable"):
        backend.set(mode=mode)
        for user in ("caldes-svc", "caldes-mario"):
            response = shared_server.propfind("/%s/" % PRINCIPAL, user=user, password="app-password-rubata", source=GATEWAY_SRC, headers=headers)
            assert response.status == 401, (mode, user, "mai 500 né il ramo device")
    assert backend.calls() == []


@needs_loopback_aliases
def test_app_password_iphone_diventa_l_utente_federico(shared_server: RadicaleServer, backend: MockVerify) -> None:
    user, password = "iphone-e2e", "test-only-app-password-iphone-e2e"
    backend.set(users=[{"username": user, "password": password}])
    mark = shared_server.mark()
    headers = {"X-Remote-Addr": GATEWAY_IP}
    root = shared_server.propfind("/", user=user, password=password, source=GATEWAY_SRC, headers=headers)
    assert root.status == 207
    assert b"<href>/federico/</href>" in root.body.replace(b"D:", b"").replace(b"d:", b""), root.body
    assert shared_server.propfind("/federico/", user=user, password=password, source=GATEWAY_SRC, headers=headers).status == 207
    assert shared_server.propfind("/%s/" % user, user=user, password=password, source=GATEWAY_SRC, headers=headers).status == 403
    assert "Successful login: %r -> 'federico'" % user in shared_server.logs(mark)
    calls = [c for c in backend.calls() if c["username"] == user]
    assert len(calls) == 1, "le richieste successive usano la cache di 60 s"
    assert calls[0]["username"] == user and calls[0]["x_forwarded_for"] == GATEWAY_IP and calls[0]["authorization_valid"]


def test_backend_giu_senza_cache_500_senza_delay(tmp_path: Path, backend: MockVerify) -> None:
    user, password = "iphone-delay", "test-only-app-password-delay"
    backend.set(users=[{"username": user, "password": password}])
    dirs = e2e_dirs(tmp_path, backend)
    # delay = 1 come la config di produzione (design §3.2); delay_on_error al default di Radicale (1 s).
    server = RadicaleServer(tmp_path / "server", dirs.env, auth_delay=1.0, label="radicale-delay").start()
    try:
        denied = server.propfind("/federico/", user=user, password="sbagliata")
        assert denied.status == 401 and denied.elapsed >= 0.9, "credenziali rifiutate: 401 dopo il delay"

        for mode in ("unavailable", "error", "garbage", "drop"):
            backend.set(mode=mode)
            response = server.propfind("/federico/", user=user, password=password)
            assert response.status == 500, mode
            assert response.elapsed < 0.6, "%s: 500 senza delay (%.3f s)" % (mode, response.elapsed)
        # 429 (troppi tentativi falliti): negazione temporanea, 401 dopo il delay.
        backend.set(mode="rate_limited")
        limited = server.propfind("/federico/", user=user, password=password)
        assert limited.status == 401 and limited.elapsed >= 0.9, "429: 401 dopo il delay (%.3f s)" % limited.elapsed
        backend.set(mode="slow", delay_ms=1500)
        response = server.propfind("/federico/", user=user, password=password)
        assert response.status == 500 and 0.9 <= response.elapsed < 1.7, "timeout di 1 s (%.3f s)" % response.elapsed
        backend.wait_for_calls(lambda calls: any(c["mode"] == "slow" for c in calls))
        backend.set(mode="ok", delay_ms=0, token="un-altro-token")
        response = server.propfind("/federico/", user=user, password=password)
        assert response.status == 500 and response.elapsed < 0.6, "Bearer rifiutato: errore di configurazione, mai 401"

        backend.set(token=TOKEN)
        assert server.propfind("/federico/", user=user, password=password).status == 207
        logs = server.logs()
        assert "verify-credentials non disponibile" in logs
        assert len(caldes_events(logs, "backend_error")) == 6
        assert len(caldes_events(logs, "rate_limited")) == 1
        assert password not in logs
    finally:
        server.stop()


def test_cache_persistita_usata_solo_su_errore_attraverso_i_riavvii(tmp_path: Path, backend: MockVerify) -> None:
    user, password = "iphone-riavvio", "test-only-app-password-riavvio"
    backend.set(users=[{"username": user, "password": password}])
    dirs = e2e_dirs(tmp_path, backend)
    count = lambda: len([c for c in backend.calls() if c["username"] == user])  # noqa: E731

    first = RadicaleServer(tmp_path / "server", dirs.env, label="radicale-riavvio-1").start()
    try:
        assert first.propfind("/federico/", user=user, password=password).status == 207
        assert count() == 1
        # Senza X-Remote-Addr: nessun X-Forwarded-For e un evento di allarme.
        assert [c["x_forwarded_for"] for c in backend.calls() if c["username"] == user] == [None]
        assert caldes_events(first.logs(), "missing_x_remote_addr")
    finally:
        first.stop()
    doc = read_authcache(dirs.authcache)
    validate_authcache(doc)
    assert list(doc["entries"]) == [expected_cache_key(0, user, password)]
    assert stat.S_IMODE((dirs.authcache / "authcache.json").stat().st_mode) == 0o600
    assert stat.S_IMODE(dirs.authcache.stat().st_mode) == 0o700

    second = RadicaleServer(tmp_path / "server", dirs.env, label="radicale-riavvio-2").start()
    try:
        assert second.propfind("/federico/", user=user, password=password).status == 207
        assert count() == 2, "col backend su si chiama il backend, non la cache persistita"
    finally:
        second.stop()

    third = RadicaleServer(tmp_path / "server", dirs.env, label="radicale-riavvio-3").start()
    try:
        backend.set(mode="unavailable")
        assert third.propfind("/federico/", user=user, password=password).status == 207
        assert [e["login"] for e in caldes_events(third.logs(), "stale_if_error")] == [user]
        backend.set(mode="deny")
        assert third.propfind("/federico/", user=user, password=password).status == 401, "401 esplicito: mai la cache"
        assert read_authcache(dirs.authcache)["entries"] == {}
        backend.set(mode="unavailable")
        assert third.propfind("/federico/", user=user, password=password).status == 500
    finally:
        third.stop()


def test_revoca_tramite_credential_epoch_con_radicale_reale(tmp_path: Path, backend: MockVerify) -> None:
    user, password = "iphone-revoca", "test-only-app-password-revoca"
    backend.set(users=[{"username": user, "password": password}])
    dirs = e2e_dirs(tmp_path, backend)
    server = RadicaleServer(tmp_path / "server", dirs.env, label="radicale-revoca").start()
    try:
        assert server.propfind("/federico/", user=user, password=password).status == 207
        write_policy(dirs.policy, 1)
        time.sleep(1.2)  # la policy si ricontrolla al massimo una volta al secondo
        backend.set(mode="unavailable")
        assert server.propfind("/federico/", user=user, password=password).status == 500
        assert read_authcache(dirs.authcache) == {"schema": 1, "key_id": expected_key_id(), "credential_epoch": 1, "entries": {}}
        assert caldes_events(server.logs(), "credential_epoch_changed")[0]["new"] == 1
        backend.set(mode="ok")
        assert server.propfind("/federico/", user=user, password=password).status == 207
    finally:
        server.stop()


def test_variabile_obbligatoria_assente_radicale_non_parte(tmp_path: Path, backend: MockVerify) -> None:
    dirs = e2e_dirs(tmp_path, backend)
    env = dict(dirs.env)
    del env["CALDES_SVC_CIDR"]
    server = RadicaleServer(tmp_path / "server", env, label="radicale-config-errata")
    server.launch()
    try:
        code = server.wait_exit(30)
        assert code is not None and code != 0, "Radicale non deve partire a metà"
        server.output.wait_closed(5)  # type: ignore[union-attr]
        logs = server.logs()
        assert "Listening on" not in logs
        events = caldes_events(logs, "config_error")
        assert events and events[0]["option"] == "CALDES_SVC_CIDR"
        for secret in SECRETS:
            assert secret not in logs
    finally:
        server.stop()
