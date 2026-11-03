"""
Harness dei test pytest dell'immagine Radicale (fase F1 del passaggio del
calendario a Radicale; design §15, contratto control-plane).

Contiene:
- percorsi del repository (plugin, config, contratti e casi condivisi);
- costruttori di policy.json, heartbeat.json e del marker d'identità, con
  scrittura atomica come quella dell'API (temporaneo + rename);
- `InProcessRadicale`: un'Application di Radicale 3.7.8 in memoria, con il
  config di produzione (apps/radicale/config/config) e sopra solo percorsi
  temporanei e autenticazione htpasswd di prova (gli utenti di servizio e i
  device li riconosce caldes_auth, che ha i suoi test: qui conta cosa fanno
  rights, storage e vobject con l'utente già autenticato);
- `RadicaleProcess`: un Radicale reale in un processo separato, con
  PYTHONPATH sui plugin come nell'immagine (quindi sitecustomize e la patch di
  vobject si attivano da soli), per i test che devono passare dall'avvio vero
  dell'interprete o da un altro processo (lock, healthcheck); con
  `auth="caldes_auth"`, `caldes_auth_env()` e `MockVerifyProcess` (il mock di
  verify-credentials del harness F0) gira lo stack completo dei plugin, con i
  peer TCP simulati da indirizzi di loopback diversi;
- utilità iCalendar: unfold, parsing delle content line e forma canonica per
  confrontare un oggetto prima e dopo PUT/GET senza dipendere da ordine di
  proprietà e parametri o dal folding.

I test si eseguono con il Radicale 3.7.8 del venv, per esempio:
    PYTHONPATH=apps/radicale/plugins <venv>/bin/pytest apps/radicale/tests
Il PYTHONPATH è comodo ma non indispensabile: questo modulo aggiunge da sé la
cartella dei plugin a sys.path.
"""

from __future__ import annotations

import base64
import configparser
import contextlib
import http.client
import io
import json
import os
import re
import subprocess
import sys
import threading
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, Iterator, List, Mapping, Optional, Sequence, Tuple, Union

TESTS_DIR = Path(__file__).resolve().parent
RADICALE_APP_DIR = TESTS_DIR.parent
PLUGINS_DIR = RADICALE_APP_DIR / "plugins"
CONFIG_FILE = RADICALE_APP_DIR / "config" / "config"
REPO_ROOT = RADICALE_APP_DIR.parents[1]
CONTRACTS_DIR = REPO_ROOT / "docs" / "calendar-radicale" / "contracts"
FIXTURES_DIR = CONTRACTS_DIR / "fixtures"

if str(PLUGINS_DIR) not in sys.path:
    sys.path.insert(0, str(PLUGINS_DIR))

# Nel processo dei test la patch si applica all'import (nell'immagine lo fa
# sitecustomize; caldes_rights la verifica comunque nel costruttore).
import caldes_vobject_fix  # noqa: E402,F401
import caldes_rights  # noqa: E402
import radicale  # noqa: E402
from radicale import config as radicale_config  # noqa: E402

PRINCIPAL = "federico"
VOLUME_ID = "3f2b8c1e-7d4a-4e9b-9c2a-1b2c3d4e5f60"
OTHER_VOLUME_ID = "0d9e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f6a"
SERVICE_USER = caldes_rights.SERVICE_USER
PROBE_USER = caldes_rights.PROBE_USER

#: Utenti htpasswd di prova: il principal canonico, un'app-password con un
#: altro username (con caldes_auth non arriverebbe mai così ai rights, ma i
#: rights devono negarle tutto comunque) e i due utenti di servizio.
PASSWORDS: Dict[str, str] = {
    PRINCIPAL: "test-only-federico",
    "iphone": "test-only-iphone",
    SERVICE_USER: "test-only-svc",
    PROBE_USER: "test-only-probe",
}

#: Collezioni create dall'inizializzazione di prova (come il wizard: c, f,
#: bookings, scadenze; più iscrizioni, canary e una collezione di sistema).
DEFAULT_COLLECTIONS: Tuple[str, ...] = ("c", "f", "bookings", "scadenze", "sub-abc", "sub-new", "_canary", "_altro")
DEFAULT_READONLY: Tuple[str, ...] = ("bookings", "f", "scadenze", "sub-abc")
DEFAULT_HIDDEN: Tuple[str, ...] = ("_canary", "sub-new")

BACKEND_FOR_MODE = {"shadow": "postgres", "live": "radicale", "frozen": "cutover"}


def load_fixture(name: str) -> Dict[str, Any]:
    """Casi condivisi del contratto (docs/calendar-radicale/contracts/fixtures)."""
    with open(FIXTURES_DIR / name, "r", encoding="utf-8") as handle:
        return json.load(handle)


def load_contract_schema(name: str) -> Dict[str, Any]:
    with open(CONTRACTS_DIR / name, "r", encoding="utf-8") as handle:
        return json.load(handle)


# ─── Tempo ────────────────────────────────────────────────────


def now_ms() -> int:
    return time.time_ns() // 1_000_000


def iso_from_ms(ms: int) -> str:
    """Forma di Date.prototype.toISOString() (millisecondi e Z), come scrive l'API."""
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(ms // 1000)) + ".%03dZ" % (ms % 1000)


def iso_now(offset_s: float = 0.0) -> str:
    return iso_from_ms(now_ms() + int(round(offset_s * 1000)))


# ─── File del control-plane ───────────────────────────────────


def policy_doc(
    mode: str = "shadow",
    *,
    backend_mode: Optional[str] = None,
    volume_id: Optional[str] = VOLUME_ID,
    epoch: int = 1,
    readonly: Sequence[str] = DEFAULT_READONLY,
    hidden: Sequence[str] = DEFAULT_HIDDEN,
    credential_epoch: int = 0,
    version: int = 1,
    reasons: Sequence[str] = (),
    principal: str = PRINCIPAL,
) -> Dict[str, Any]:
    """policy.json come la scrive l'API (contratto §5.1)."""
    return {
        "schema": 1,
        "version": version,
        "generated_at": iso_now(),
        "backend_mode": backend_mode or BACKEND_FOR_MODE[mode],
        "mode": mode,
        "reasons": list(reasons),
        "principal": principal,
        "volume_id": volume_id,
        "epoch": epoch if volume_id is not None else 0,
        "credential_epoch": credential_epoch,
        "readonly": sorted(readonly),
        "hidden": sorted(set(hidden) | {"_canary"}),
    }


def heartbeat_doc(
    backend_mode: str = "postgres", *, epoch: int = 1, offset_s: float = 0.0, api_version: str = "sha-test"
) -> Dict[str, Any]:
    """heartbeat.json come lo scrive l'API (contratto §7.1), con ts spostato di offset_s."""
    return {"schema": 1, "api_version": api_version, "mode": backend_mode, "epoch": epoch, "ts": iso_now(offset_s)}


FileContent = Union[None, str, bytes, Mapping[str, Any]]


def write_atomic(path: Path, content: FileContent) -> None:
    """
    Scrive `content` come l'API: temporaneo nella stessa cartella e rename
    (inode nuovo a ogni scrittura). None cancella il file; un dict diventa
    JSON indentato; str e bytes vanno scritti così come sono.
    """
    path = Path(path)
    if content is None:
        with contextlib.suppress(FileNotFoundError):
            path.unlink()
        return
    if isinstance(content, Mapping):
        data = (json.dumps(content, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    elif isinstance(content, str):
        data = content.encode("utf-8")
    else:
        data = bytes(content)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.parent / (".%s.%d.%d.tmp" % (path.name, os.getpid(), time.monotonic_ns()))
    with open(tmp, "wb") as handle:
        handle.write(data)
    os.replace(tmp, path)


class ControlFiles:
    """policy.json e heartbeat.json in una cartella (il volume caldes_control)."""

    def __init__(self, directory: Path) -> None:
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.policy = self.directory / "policy.json"
        self.heartbeat = self.directory / "heartbeat.json"

    def write_policy(self, content: FileContent) -> None:
        write_atomic(self.policy, content)

    def write_heartbeat(self, content: FileContent) -> None:
        write_atomic(self.heartbeat, content)

    def set_mode(
        self,
        mode: str,
        *,
        epoch: int = 1,
        volume_id: Optional[str] = VOLUME_ID,
        heartbeat_offset_s: float = 0.0,
        heartbeat_epoch: Optional[int] = None,
        heartbeat_mode: Optional[str] = None,
        **policy_kwargs: Any,
    ) -> None:
        """Policy e heartbeat coerenti per `mode` (shadow, live, frozen)."""
        backend = policy_kwargs.pop("backend_mode", None) or BACKEND_FOR_MODE[mode]
        effective_epoch = epoch if volume_id is not None else 0
        self.write_policy(policy_doc(mode, backend_mode=backend, volume_id=volume_id, epoch=effective_epoch,
                                     **policy_kwargs))
        self.write_heartbeat(heartbeat_doc(
            heartbeat_mode or backend,
            epoch=effective_epoch if heartbeat_epoch is None else heartbeat_epoch,
            offset_s=heartbeat_offset_s,
        ))


def principal_props_path(storage_dir: Path, principal: str = PRINCIPAL) -> Path:
    return Path(storage_dir) / "collection-root" / principal / ".Radicale.props"


def write_marker_file(
    storage_dir: Path,
    volume_id: Optional[str] = VOLUME_ID,
    epoch: Union[int, str, None] = 1,
    *,
    principal: str = PRINCIPAL,
    extra: Optional[Mapping[str, Any]] = None,
) -> Path:
    """
    Scrive direttamente il `.Radicale.props` del principal (solo per i test
    unitari: in produzione lo scrive Radicale su PROPPATCH di caldes-svc).
    """
    props: Dict[str, Any] = dict(extra or {})
    if volume_id is not None:
        props[caldes_rights.DEAD_PROP_VOLUME_ID] = volume_id
    if epoch is not None:
        props[caldes_rights.DEAD_PROP_EPOCH] = str(epoch)
    path = principal_props_path(storage_dir, principal)
    write_atomic(path, json.dumps(props))
    return path


def marker_proppatch_body(volume_id: str, epoch: Union[int, str]) -> str:
    """Corpo della PROPPATCH del marker (come volumeMarkerProppatchBody() in TS)."""
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<D:propertyupdate xmlns:D="DAV:" xmlns:K="urn:calicchia:caldes">'
        "<D:set><D:prop><K:volume-id>%s</K:volume-id><K:epoch>%s</K:epoch></D:prop></D:set>"
        "</D:propertyupdate>" % (volume_id, epoch)
    )


def mkcalendar_body(displayname: str, *, calendar_id: Optional[str] = None, role: Optional[str] = None,
                    color: Optional[str] = None) -> str:
    """MKCALENDAR con displayname e, se dati, le dead prop calendar-id e role (contratto §4.5)."""
    props = ["<D:displayname>%s</D:displayname>" % displayname]
    if color:
        props.append("<I:calendar-color>%s</I:calendar-color>" % color)
    if calendar_id:
        props.append("<K:calendar-id>%s</K:calendar-id>" % calendar_id)
    if role:
        props.append("<K:role>%s</K:role>" % role)
    return (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" '
        'xmlns:I="http://apple.com/ns/ical/" xmlns:K="urn:calicchia:caldes">'
        "<D:set><D:prop>%s</D:prop></D:set></C:mkcalendar>" % "".join(props)
    )


PROPFIND_ALLPROP = (
    '<?xml version="1.0" encoding="utf-8"?>'
    '<D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/><D:displayname/><D:getetag/></D:prop></D:propfind>'
)


def sync_collection_body(token: str = "") -> str:
    return (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<D:sync-collection xmlns:D="DAV:"><D:sync-token>%s</D:sync-token>'
        "<D:sync-level>1</D:sync-level><D:prop><D:getetag/></D:prop></D:sync-collection>" % token
    )


def multiget_body(hrefs: Iterable[str]) -> str:
    return (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<C:calendar-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">'
        "<D:prop><D:getetag/><C:calendar-data/></D:prop>%s</C:calendar-multiget>"
        % "".join("<D:href>%s</D:href>" % href for href in hrefs)
    )


def calendar_query_expand_body(start: str, end: str) -> str:
    """calendar-query con <C:expand>: Radicale duplica i VEVENT di ogni occorrenza."""
    return (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">'
        '<D:prop><D:getetag/><C:calendar-data><C:expand start="%s" end="%s"/></C:calendar-data></D:prop>'
        '<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">'
        '<C:time-range start="%s" end="%s"/></C:comp-filter></C:comp-filter></C:filter>'
        "</C:calendar-query>" % (start, end, start, end)
    )


# ─── Risposte ─────────────────────────────────────────────────


@dataclass
class Response:
    status: int
    headers: Dict[str, str]
    body: bytes

    @property
    def text(self) -> str:
        return self.body.decode("utf-8", "replace")

    def header(self, name: str) -> Optional[str]:
        for key, value in self.headers.items():
            if key.lower() == name.lower():
                return value
        return None

    def multistatus(self) -> Dict[str, Dict[str, Any]]:
        """href → {"status": int|None, "props": {clark: testo}, "propstat": [(status, {clark: testo})]}."""
        root = ET.fromstring(self.body)
        result: Dict[str, Dict[str, Any]] = {}
        for response in root.findall("{DAV:}response"):
            href = response.findtext("{DAV:}href") or ""
            status_text = response.findtext("{DAV:}status")
            entry: Dict[str, Any] = {"status": _status_code(status_text), "props": {}, "propstat": []}
            for propstat in response.findall("{DAV:}propstat"):
                code = _status_code(propstat.findtext("{DAV:}status"))
                props = {}
                for prop in propstat.findall("{DAV:}prop/*"):
                    props[prop.tag] = "".join(prop.itertext())
                    if code == 200:
                        entry["props"][prop.tag] = props[prop.tag]
                entry["propstat"].append((code, props))
            result[href] = entry
        return result

    def describe(self) -> str:
        return "HTTP %d %s" % (self.status, self.text[:500])


def _status_code(text: Optional[str]) -> Optional[int]:
    if not text:
        return None
    match = re.search(r"\s(\d{3})\s", text + " ")
    return int(match.group(1)) if match else None


def _basic(user: str, password: str) -> str:
    return "Basic " + base64.b64encode(("%s:%s" % (user, password)).encode("utf-8")).decode("ascii")


class _CalDavMethods:
    """Scorciatoie CalDAV comuni a InProcessRadicale e RadicaleProcess."""

    def request(self, method: str, path: str, user: Optional[str] = None, body: Union[str, bytes] = b"",
                headers: Optional[Mapping[str, str]] = None, password: Optional[str] = None) -> Response:
        raise NotImplementedError

    def propfind(self, path: str, user: Optional[str], depth: str = "0", body: str = PROPFIND_ALLPROP) -> Response:
        return self.request("PROPFIND", path, user, body, {"Depth": depth, "Content-Type": "application/xml"})

    def proppatch(self, path: str, user: Optional[str], body: str) -> Response:
        return self.request("PROPPATCH", path, user, body, {"Content-Type": "application/xml"})

    def mkcol(self, path: str, user: Optional[str]) -> Response:
        return self.request("MKCOL", path, user)

    def mkcalendar(self, path: str, user: Optional[str], body: Optional[str] = None) -> Response:
        name = path.rstrip("/").rsplit("/", 1)[-1]
        return self.request("MKCALENDAR", path, user, body or mkcalendar_body(name),
                            {"Content-Type": "application/xml"})

    def put(self, path: str, user: Optional[str], ics: str, *, if_match: Optional[str] = None,
            if_none_match: Optional[str] = None) -> Response:
        headers = {"Content-Type": "text/calendar; charset=utf-8"}
        if if_match:
            headers["If-Match"] = if_match
        if if_none_match:
            headers["If-None-Match"] = if_none_match
        return self.request("PUT", path, user, ics, headers)

    def get(self, path: str, user: Optional[str]) -> Response:
        return self.request("GET", path, user)

    def delete(self, path: str, user: Optional[str]) -> Response:
        return self.request("DELETE", path, user)

    def move(self, path: str, destination: str, user: Optional[str]) -> Response:
        return self.request("MOVE", path, user, b"", {"Destination": destination})

    def report(self, path: str, user: Optional[str], body: str, depth: str = "1") -> Response:
        return self.request("REPORT", path, user, body, {"Depth": depth, "Content-Type": "application/xml"})

    # Inizializzazione come il wizard (contratto §4.4), eseguita da caldes-svc.
    def initialize(self, volume_id: str = VOLUME_ID, epoch: int = 1,
                   collections: Sequence[str] = DEFAULT_COLLECTIONS) -> None:
        res = self.mkcol("/%s/" % PRINCIPAL, SERVICE_USER)
        assert res.status == 201, "MKCOL del principal: " + res.describe()
        res = self.proppatch("/%s/" % PRINCIPAL, SERVICE_USER, marker_proppatch_body(volume_id, epoch))
        assert res.status == 207, "PROPPATCH del marker: " + res.describe()
        for name in collections:
            res = self.mkcalendar("/%s/%s/" % (PRINCIPAL, name), SERVICE_USER)
            assert res.status == 201, "MKCALENDAR %s: %s" % (name, res.describe())


# ─── Radicale in memoria ──────────────────────────────────────


@contextlib.contextmanager
def _env(values: Mapping[str, Optional[str]]) -> Iterator[None]:
    previous = {key: os.environ.get(key) for key in values}
    try:
        for key, value in values.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        yield
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def write_htpasswd(path: Path, passwords: Mapping[str, str]) -> None:
    path.write_text("".join("%s:%s\n" % item for item in passwords.items()), encoding="utf-8")


class InProcessRadicale(_CalDavMethods):
    """
    Application di Radicale in memoria con il config di produzione e sopra:
    storage e control-plane in `root`, htpasswd in chiaro, nessun ritardo sui
    login falliti, policy e heartbeat ricontrollati a ogni richiesta.
    """

    def __init__(
        self,
        root: Path,
        *,
        passwords: Mapping[str, str] = PASSWORDS,
        principal: str = PRINCIPAL,
        reload_interval: str = "0",
        overrides: Optional[Mapping[str, Mapping[str, str]]] = None,
    ) -> None:
        self.root = Path(root)
        self.storage = self.root / "collections"
        self.control = ControlFiles(self.root / "control")
        self.passwords = dict(passwords)
        self.principal = principal
        htpasswd = self.root / "users"
        write_htpasswd(htpasswd, self.passwords)
        configuration = radicale_config.load([(str(CONFIG_FILE), False)])
        update: Dict[str, Dict[str, str]] = {
            "auth": {
                "type": "htpasswd",
                "htpasswd_filename": str(htpasswd),
                "htpasswd_encryption": "plain",
                "delay": "0",
            },
            "rights": {
                "caldes_policy_file": str(self.control.policy),
                "caldes_heartbeat_file": str(self.control.heartbeat),
                "caldes_reload_interval": reload_interval,
            },
            "storage": {"filesystem_folder": str(self.storage)},
        }
        for section, values in (overrides or {}).items():
            update.setdefault(section, {}).update(values)
        configuration.update(update, "caldes_harness")
        self.configuration = configuration
        with _env({"RADICALE_PRINCIPAL": principal}):
            self.app = radicale.Application(configuration)

    @property
    def rights(self) -> "caldes_rights.Rights":
        return self.app._rights  # type: ignore[attr-defined]

    def principal_dir(self) -> Path:
        return self.storage / "collection-root" / self.principal

    def collection_dir(self, name: str) -> Path:
        return self.principal_dir() / name

    def request(self, method: str, path: str, user: Optional[str] = None, body: Union[str, bytes] = b"",
                headers: Optional[Mapping[str, str]] = None, password: Optional[str] = None,
                remote_addr: str = "127.0.0.1") -> Response:
        data = body.encode("utf-8") if isinstance(body, str) else body
        environ: Dict[str, Any] = {
            "REQUEST_METHOD": method,
            "PATH_INFO": path,
            "SCRIPT_NAME": "",
            "SERVER_NAME": "127.0.0.1",
            "SERVER_PORT": "5232",
            "HTTP_HOST": "127.0.0.1:5232",
            "SERVER_PROTOCOL": "HTTP/1.1",
            "REMOTE_ADDR": remote_addr,
            "CONTENT_LENGTH": str(len(data)),
            "wsgi.input": io.BytesIO(data),
            "wsgi.errors": io.StringIO(),
            "wsgi.url_scheme": "http",
            "wsgi.version": (1, 0),
            "wsgi.multithread": True,
            "wsgi.multiprocess": False,
            "wsgi.run_once": False,
        }
        if user is not None:
            environ["HTTP_AUTHORIZATION"] = _basic(user, password if password is not None else self.passwords[user])
        for name, value in (headers or {}).items():
            key = name.upper().replace("-", "_")
            environ[key if key in ("CONTENT_TYPE", "CONTENT_LENGTH") else "HTTP_" + key] = value
        captured: Dict[str, Any] = {}

        def start_response(status: str, response_headers: List[Tuple[str, str]], exc_info: Any = None) -> None:
            captured["status"] = int(status.split()[0])
            captured["headers"] = dict(response_headers)

        payload = b"".join(self.app(environ, start_response))
        return Response(captured["status"], captured["headers"], payload)


# ─── Radicale in un processo separato ─────────────────────────


def production_config_parser() -> configparser.RawConfigParser:
    parser = configparser.RawConfigParser()
    with open(CONFIG_FILE, "r", encoding="utf-8") as handle:
        parser.read_file(handle)
    return parser


class RadicaleProcess(_CalDavMethods):
    """
    Radicale reale (`python -m radicale`, stesso interprete dei test) su una
    porta scelta dal sistema, con il config di produzione modificato solo nei
    percorsi e nell'autenticazione. Con `plugins=True` il PYTHONPATH punta ai
    plugin come nell'immagine: sitecustomize applica la patch all'avvio.
    """

    def __init__(
        self,
        root: Path,
        *,
        plugins: bool = True,
        rights: str = "caldes_rights",
        auth: str = "htpasswd",
        passwords: Mapping[str, str] = PASSWORDS,
        principal: str = PRINCIPAL,
        env: Optional[Mapping[str, str]] = None,
        user_sources: Optional[Mapping[str, str]] = None,
        start_timeout_s: float = 30.0,
    ) -> None:
        self.root = Path(root)
        self.storage = self.root / "collections"
        self.control = ControlFiles(self.root / "control")
        self.passwords = dict(passwords)
        self.principal = principal
        #: Indirizzo di loopback da cui si connette ciascun utente se `source` non è dato.
        self.user_sources: Dict[str, str] = dict(user_sources or {})
        self.lines: List[str] = []
        self._lines_lock = threading.Lock()
        self.port: Optional[int] = None

        htpasswd = self.root / "users"
        write_htpasswd(htpasswd, self.passwords)
        parser = production_config_parser()
        parser.set("server", "hosts", "127.0.0.1:0")
        if auth == "caldes_auth":
            # Il plugin di produzione, configurato solo da env (vedi caldes_auth_env).
            parser.set("auth", "delay", "0")
        else:
            parser.remove_section("auth")
            parser.add_section("auth")
            for key, value in (("type", "htpasswd"), ("htpasswd_filename", str(htpasswd)),
                               ("htpasswd_encryption", "plain"), ("delay", "0")):
                parser.set("auth", key, value)
        if rights == "caldes_rights":
            parser.set("rights", "caldes_policy_file", str(self.control.policy))
            parser.set("rights", "caldes_heartbeat_file", str(self.control.heartbeat))
            parser.set("rights", "caldes_reload_interval", "0")
        else:
            parser.remove_section("rights")
            parser.add_section("rights")
            parser.set("rights", "type", rights)
            parser.set("rights", "permit_delete_collection", "False")
            parser.set("rights", "permit_overwrite_collection", "False")
        parser.set("storage", "filesystem_folder", str(self.storage))
        self.config_path = self.root / "config"
        with open(self.config_path, "w", encoding="utf-8") as handle:
            parser.write(handle)

        process_env = {k: v for k, v in os.environ.items() if k not in ("PYTHONPATH", "PYTHONHOME", "RADICALE_CONFIG")}
        process_env.update({
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONUNBUFFERED": "1",
            "PYTHONIOENCODING": "utf-8",
            "TZ": "UTC",
            "RADICALE_PRINCIPAL": principal,
        })
        if plugins:
            process_env["PYTHONPATH"] = str(PLUGINS_DIR)
        process_env.update(env or {})
        self.process = subprocess.Popen(
            [sys.executable, "-m", "radicale", "--config", str(self.config_path)],
            cwd=str(self.root),
            env=process_env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        self._reader = threading.Thread(target=self._read_output, daemon=True)
        self._reader.start()
        self._wait_ready(start_timeout_s)

    def _read_output(self) -> None:
        assert self.process.stdout is not None
        for raw in self.process.stdout:
            line = raw.decode("utf-8", "replace").rstrip("\n")
            with self._lines_lock:
                self.lines.append(line)

    def logs(self) -> str:
        with self._lines_lock:
            return "\n".join(self.lines)

    def _wait_ready(self, timeout_s: float) -> None:
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            text = self.logs()
            match = re.search(r"Listening on '127\.0\.0\.1:(\d+)'", text)
            if match and "Radicale server ready" in text:
                self.port = int(match.group(1))
                return
            if self.process.poll() is not None:
                self._reader.join(timeout=2)
                raise RuntimeError("Radicale è uscito durante l'avvio (code %s):\n%s"
                                   % (self.process.returncode, self.logs()[-4000:]))
            time.sleep(0.05)
        self.stop()
        raise RuntimeError("Radicale non pronto entro %s s:\n%s" % (timeout_s, self.logs()[-4000:]))

    @property
    def url(self) -> str:
        return "http://127.0.0.1:%d/" % self.port

    def principal_dir(self) -> Path:
        return self.storage / "collection-root" / self.principal

    def collection_dir(self, name: str) -> Path:
        return self.principal_dir() / name

    def request(self, method: str, path: str, user: Optional[str] = None, body: Union[str, bytes] = b"",
                headers: Optional[Mapping[str, str]] = None, password: Optional[str] = None,
                timeout: float = 30.0, source: Optional[str] = None) -> Response:
        """`source`: indirizzo di loopback da cui connettersi (peer TCP visto da Radicale)."""
        data = body.encode("utf-8") if isinstance(body, str) else body
        all_headers = dict(headers or {})
        if user is not None:
            all_headers["Authorization"] = _basic(user, password if password is not None else self.passwords[user])
        source = source or (self.user_sources.get(user) if user is not None else None)
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=timeout,
                                                source_address=(source, 0) if source else None)
        try:
            connection.request(method, path, body=data, headers=all_headers)
            response = connection.getresponse()
            return Response(response.status, dict(response.getheaders()), response.read())
        finally:
            connection.close()

    def stop(self) -> None:
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=10)
        if self.process.stdout is not None:
            with contextlib.suppress(Exception):
                self._reader.join(timeout=5)
                self.process.stdout.close()

    def __enter__(self) -> "RadicaleProcess":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.stop()


# ─── caldes_auth e mock di verify-credentials ─────────────────

MOCK_VERIFY_SCRIPT = REPO_ROOT / "apps" / "api" / "test" / "helpers" / "mock_verify.py"
SERVICE_TOKEN = "test-only-caldav-service-token"
#: Rete interna caldav-int simulata sul loopback: solo 127.0.0.2 (127.0.0.1 è
#: il loopback del container, ammesso solo per il probe).
SVC_PEER = "127.0.0.2"
GATEWAY_PEER = "127.0.0.3"


def caldes_auth_env(backend_url: str, control: ControlFiles, authcache_dir: Path,
                    passwords: Mapping[str, str] = PASSWORDS) -> Dict[str, str]:
    """Ambiente di caldes_auth (contratto §1.2) per un RadicaleProcess."""
    import hashlib

    authcache_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    return {
        "CALDAV_BACKEND_URL": backend_url,
        "CALDAV_SERVICE_TOKEN": SERVICE_TOKEN,
        "CALDES_SVC_CIDR": SVC_PEER + "/32",
        "CALDES_SVC_PASSWORD_SHA256": hashlib.sha256(passwords[SERVICE_USER].encode("utf-8")).hexdigest(),
        "CALDES_PROBE_PASSWORD_SHA256": hashlib.sha256(passwords[PROBE_USER].encode("utf-8")).hexdigest(),
        "CALDES_AUTHCACHE_KEY": "test-only-authcache-key-0123456789abcdef",
        "CALDES_AUTHCACHE_DIR": str(authcache_dir),
        "CALDES_POLICY_FILE": str(control.policy),
    }


class MockVerifyProcess:
    """apps/api/test/helpers/mock_verify.py su 127.0.0.1 (porta scelta dal sistema)."""

    def __init__(self, users: Sequence[Mapping[str, str]], *, principal: str = PRINCIPAL) -> None:
        state = {"mode": "ok", "delay_ms": 0, "token": SERVICE_TOKEN, "principal": principal,
                 "principal_mode": "canonical", "reject_reserved": True, "users": list(users)}
        self.process = subprocess.Popen(
            [sys.executable, "-I", str(MOCK_VERIFY_SCRIPT), "--host", "127.0.0.1", "--port", "0",
             "--state", json.dumps(state)],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        )
        assert self.process.stdout is not None
        deadline = time.monotonic() + 15
        self.port = 0
        while time.monotonic() < deadline:
            line = self.process.stdout.readline().decode("utf-8", "replace").strip()
            if line.startswith("{") and '"ready"' in line:
                self.port = int(json.loads(line)["port"])
                break
            if not line and self.process.poll() is not None:
                break
        if not self.port:
            self.stop()
            raise RuntimeError("mock di verify-credentials non avviato")
        self.backend_url = "http://127.0.0.1:%d/api/caldav-backend" % self.port
        # Il mock continua a scrivere su stdout: svuotare la pipe per non bloccarlo.
        self._drain = threading.Thread(target=self._drain_output, daemon=True)
        self._drain.start()

    def _drain_output(self) -> None:
        assert self.process.stdout is not None
        with contextlib.suppress(ValueError, OSError):
            for _ in self.process.stdout:
                pass

    def calls(self) -> List[Dict[str, Any]]:
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            connection.request("GET", "/__mock/calls")
            return json.loads(connection.getresponse().read() or b"[]")
        finally:
            connection.close()

    def stop(self) -> None:
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=10)
        if self.process.stdout is not None:
            with contextlib.suppress(Exception):
                self._drain.join(timeout=5)
                self.process.stdout.close()


# ─── iCalendar ────────────────────────────────────────────────


def unfold(text: str) -> List[str]:
    """Righe logiche (unfold RFC 5545 §3.1), senza righe vuote."""
    lines: List[str] = []
    for raw in text.replace("\r\n", "\n").split("\n"):
        if raw[:1] in (" ", "\t") and lines:
            lines[-1] += raw[1:]
        elif raw:
            lines.append(raw)
    return lines


def ics(lines: Sequence[str]) -> str:
    return "\r\n".join(list(lines) + [""])


def event_ics(uid: str, lines: Sequence[str], *, dtstart: str = "DTSTART:20270201T080000Z") -> str:
    body = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Calicchia Design//caldes test//IT", "BEGIN:VEVENT",
            "UID:" + uid, "DTSTAMP:20261001T000000Z"]
    if not any(line.startswith("DTSTART") for line in lines):
        body.append(dtstart)
    body.extend(lines)
    body.extend(["END:VEVENT", "END:VCALENDAR"])
    return ics(body)


ContentLine = Tuple[str, Tuple[Tuple[str, Tuple[str, ...]], ...], str]


def parse_content_line(line: str) -> ContentLine:
    """
    `NOME;P1=a,"b,c";P2=x:valore` → ("NOME", (("P1", ("a", "b,c")), ("P2", ("x",))), "valore").
    Nome e nomi dei parametri in maiuscolo, parametri ordinati, virgolette tolte.
    """
    in_quotes = False
    split_at = None
    for index, char in enumerate(line):
        if char == '"':
            in_quotes = not in_quotes
        elif char == ":" and not in_quotes:
            split_at = index
            break
    if split_at is None:
        raise ValueError("content line senza ':': %r" % line)
    head, value = line[:split_at], line[split_at + 1:]
    parts: List[str] = []
    current: List[str] = []
    in_quotes = False
    for char in head:
        if char == '"':
            in_quotes = not in_quotes
            current.append(char)
        elif char == ";" and not in_quotes:
            parts.append("".join(current))
            current = []
        else:
            current.append(char)
    parts.append("".join(current))
    name = parts[0].upper()
    params: List[Tuple[str, Tuple[str, ...]]] = []
    for part in parts[1:]:
        key, _, raw = part.partition("=")
        values: List[str] = []
        buf: List[str] = []
        in_quotes = False
        for char in raw:
            if char == '"':
                in_quotes = not in_quotes
            elif char == "," and not in_quotes:
                values.append("".join(buf))
                buf = []
            else:
                buf.append(char)
        values.append("".join(buf))
        params.append((key.upper(), tuple(values)))
    return name, tuple(sorted(params)), value


#: Proprietà TEXT note a vobject 0.9.9 (textList di vobject.icalendar): l'unica
#: differenza ammessa dopo PUT/GET è la forma canonica degli escape TEXT (una
#: virgola o un ';' non escapati diventano '\,' e '\;').
TEXT_PROPERTIES = frozenset({
    "CALSCALE", "METHOD", "PRODID", "CLASS", "COMMENT", "DESCRIPTION", "LOCATION", "STATUS", "SUMMARY",
    "TRANSP", "CONTACT", "RELATED-TO", "UID", "ACTION", "BUSYTYPE",
})


def canonical_text(value: str) -> str:
    """Forma canonica di un valore TEXT RFC 5545: unescape poi escape di \\ ; , e a capo."""
    out: List[str] = []
    index = 0
    while index < len(value):
        char = value[index]
        if char == "\\" and index + 1 < len(value):
            nxt = value[index + 1]
            if nxt in "\\;,":
                out.append(nxt)
            elif nxt in "nN":
                out.append("\n")
            else:
                out.append("\\" + nxt)
            index += 2
            continue
        out.append(char)
        index += 1
    text = "".join(out)
    return text.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def canonical_ics(text: str) -> List[Tuple[str, ContentLine]]:
    """
    Forma canonica di un iCalendar: lista ordinata di (percorso del
    componente, content line) con parametri ordinati e valori TEXT
    normalizzati; ordine delle proprietà e folding non contano.
    """
    stack: List[str] = []
    result: List[Tuple[str, ContentLine]] = []
    for line in unfold(text):
        upper = line.upper()
        if upper.startswith("BEGIN:"):
            stack.append(line[6:].upper())
            continue
        if upper.startswith("END:"):
            stack.pop()
            continue
        name, params, value = parse_content_line(line)
        param_map = dict(params)
        verbatim = param_map.get("VALUE", ("",))[0].upper() == "URI" or param_map.get("ENCODING", ("",))[0].upper() == "BASE64"
        if name in TEXT_PROPERTIES and not verbatim:
            value = canonical_text(value)
        result.append(("/".join(stack), (name, params, value)))
    return sorted(result)


def first_property(text: str, name: str, component: Optional[str] = None) -> Optional[str]:
    """Valore (raw) della prima proprietà `name`, opzionalmente dentro `component`."""
    stack: List[str] = []
    for line in unfold(text):
        upper = line.upper()
        if upper.startswith("BEGIN:"):
            stack.append(line[6:].upper())
            continue
        if upper.startswith("END:"):
            stack.pop()
            continue
        prop, _, value = parse_content_line(line)
        if prop == name.upper() and (component is None or (stack and stack[-1] == component.upper())):
            return value
    return None


def wait_for_mtime_tick() -> None:
    """Pausa sufficiente a distinguere due mtime anche su filesystem con risoluzione grossolana."""
    time.sleep(0.02)


@dataclass
class DirWatch:
    """Snapshot delle mtime (ns) di un insieme di directory."""

    paths: Dict[str, Path]
    before: Dict[str, Optional[int]] = field(default_factory=dict)

    def snapshot(self) -> Dict[str, Optional[int]]:
        out: Dict[str, Optional[int]] = {}
        for name, path in self.paths.items():
            try:
                out[name] = os.stat(path).st_mtime_ns
            except FileNotFoundError:
                out[name] = None
        return out

    def changed_by(self, action: Any) -> Tuple[Any, List[str]]:
        before = self.snapshot()
        wait_for_mtime_tick()
        result = action()
        wait_for_mtime_tick()
        after = self.snapshot()
        return result, sorted(name for name in self.paths if before[name] != after[name])
