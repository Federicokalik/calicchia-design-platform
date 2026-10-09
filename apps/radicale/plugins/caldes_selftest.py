"""
Self-test dell'immagine Radicale di Caldes, eseguito in build
(`RUN /venv/bin/python /app/plugins/caldes_selftest.py`, design §3.1): se
fallisce, la build fallisce e nessuna immagine rotta arriva in produzione.

Verifica, con l'interprete e le librerie dell'immagine:

1. versioni pinnate: Radicale 3.7.8 e vobject 0.9.9 (design §3.1);
2. sitecustomize attivo: la patch di fedeltà di vobject è già applicata
   all'avvio dell'interprete, prima di qualsiasi import esplicito (PYTHONPATH
   e sitecustomize funzionano come in Radicale), e il suo self-test passa;
3. config montata (/config/config): si carica con il parser di Radicale e ha
   i valori da cui dipendono sicurezza e semantica (plugin, limiti, storage);
4. plugin: caldes_auth implementa `_login_ext` senza ridefinire `login` (in
   3.7.8 è @final: ridefinirlo era il bug che rispondeva 500 a ogni richiesta)
   e si importa senza ambiente; caldes_rights si importa; healthcheck compila;
5. percorso reale: un'Application di Radicale in memoria, storage in una
   cartella temporanea, caldes_rights con policy, heartbeat e marker scritti
   qui: volume vuoto → device 403 e nessuna directory; inizializzazione come
   caldes-svc (MKCOL, PROPPATCH del marker, MKCALENDAR); shadow → sola
   lettura; live → PUT di un evento con virgole, URI, X-prop e VALARM e GET
   identico nei punti che vobject senza patch perderebbe; heartbeat scaduto →
   di nuovo sola lettura; DELETE di una collezione negata al device.

Uso: `python caldes_selftest.py [percorso del config]` (default /config/config,
oppure CALDES_SELFTEST_CONFIG). Exit 0 se tutto passa, 1 altrimenti.
Solo libreria standard + Radicale e vobject.
"""

from __future__ import annotations

import base64
import importlib
import inspect
import io
import json
import os
import sys
import tempfile
import time
import uuid
from typing import Any, Callable, Dict, List, Optional, Tuple

EXPECTED_RADICALE = "3.7.8"
EXPECTED_VOBJECT = "0.9.9"
PRINCIPAL = "federico"
PLUGINS_DIR = os.path.dirname(os.path.abspath(__file__))

#: Valori della config da cui dipendono sicurezza e semantica (design §3.2).
EXPECTED_CONFIG: Dict[Tuple[str, str], Any] = {
    ("server", "max_vevent_rrule_occurrence"): 50000,
    ("server", "delay_on_error"): 0.0,
    ("auth", "type"): "caldes_auth",
    ("rights", "type"): "caldes_rights",
    ("rights", "caldes_policy_file"): "/control/policy.json",
    ("rights", "caldes_heartbeat_file"): "/control/heartbeat.json",
    ("rights", "permit_delete_collection"): False,
    ("rights", "permit_overwrite_collection"): False,
    ("storage", "type"): "multifilesystem",
    ("storage", "filesystem_folder"): "/data/collections",
    ("storage", "skip_broken_item"): True,
    ("storage", "predefined_collections"): {},
    ("hook", "type"): "none",
    ("sharing", "type"): "none",
    ("web", "type"): "none",
    ("logging", "mask_passwords"): True,
}

FIDELITY_EVENT = "\r\n".join([
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Calicchia Design//caldes selftest//IT",
    "BEGIN:VEVENT",
    "UID:caldes-selftest-put@caldes.it",
    "DTSTAMP:20261001T000000Z",
    "DTSTART:20261010T090000Z",
    "DTEND:20261010T100000Z",
    "SUMMARY:Pranzo, cena",
    "LOCATION:Via Roma 1, Frosinone",
    "X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-TITLE=Studio:geo:41.639,13.342",
    "CONFERENCE;VALUE=URI;FEATURE=VIDEO:https://meet.caldes.test/stanza?a=1,2",
    "X-CALDES-SOURCE-ID:gruppo;voce",
    "X-FOO:a,b,c",
    "ATTENDEE;CN=\"Rossi, Mario\";PARTSTAT=ACCEPTED:mailto:mario@example.com",
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "DESCRIPTION:Promemoria, tra poco",
    "TRIGGER:-PT15M",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
])

FIDELITY_EXPECTED = (
    "SUMMARY:Pranzo\\, cena",
    "LOCATION:Via Roma 1\\, Frosinone",
    "X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-TITLE=Studio:geo:41.639,13.342",
    "CONFERENCE;FEATURE=VIDEO;VALUE=URI:https://meet.caldes.test/stanza?a=1,2",
    "X-CALDES-SOURCE-ID:gruppo;voce",
    "X-FOO:a,b,c",
    "ATTENDEE;CN=\"Rossi, Mario\";PARTSTAT=ACCEPTED:mailto:mario@example.com",
    "DESCRIPTION:Promemoria\\, tra poco",
)


class SelfTestFailure(Exception):
    """Un controllo del self-test è fallito."""


def _ensure(condition: bool, message: str) -> None:
    if not condition:
        raise SelfTestFailure(message)


def _unfold(text: str) -> List[str]:
    lines: List[str] = []
    for raw in text.replace("\r\n", "\n").split("\n"):
        if raw[:1] in (" ", "\t") and lines:
            lines[-1] += raw[1:]
        elif raw:
            lines.append(raw)
    return lines


# ─── 1-2. Versioni e patch ────────────────────────────────────


def check_versions() -> str:
    _ensure(sys.version_info >= (3, 9), "serve Python 3.9 o successivo (trovato %s)" % sys.version.split()[0])
    import radicale
    import vobject

    radicale_version = getattr(radicale, "VERSION", "")
    vobject_version = getattr(vobject, "VERSION", "")
    _ensure(radicale_version == EXPECTED_RADICALE, "Radicale %s invece di %s" % (radicale_version, EXPECTED_RADICALE))
    _ensure(vobject_version == EXPECTED_VOBJECT, "vobject %s invece di %s" % (vobject_version, EXPECTED_VOBJECT))
    return "Python %s, Radicale %s, vobject %s" % (sys.version.split()[0], radicale_version, vobject_version)


def check_vobject_patch() -> str:
    # Prima di qualsiasi import esplicito: deve averla applicata sitecustomize.
    _ensure("sitecustomize" in sys.modules, "sitecustomize non caricato (PYTHONPATH senza i plugin?)")
    _ensure(
        "caldes_vobject_fix" in sys.modules,
        "sitecustomize non ha applicato la patch di fedeltà (caldes_vobject_fix non importato all'avvio)",
    )
    import caldes_vobject_fix

    _ensure(caldes_vobject_fix.is_applied(), "patch di fedeltà non attiva")
    caldes_vobject_fix.self_test()
    return caldes_vobject_fix.describe() or "patch attiva"


# ─── 3. Config ────────────────────────────────────────────────


def check_config(path: str) -> str:
    from radicale import config

    _ensure(os.path.isfile(path), "config assente: %s" % path)
    configuration = config.load([(path, False)])
    for (section, option), expected in EXPECTED_CONFIG.items():
        try:
            actual = configuration.get(section, option)
        except KeyError:
            raise SelfTestFailure("config: [%s] %s assente" % (section, option)) from None
        _ensure(actual == expected, "config: [%s] %s = %r invece di %r" % (section, option, actual, expected))
    return "config %s: %d valori verificati" % (path, len(EXPECTED_CONFIG))


# ─── 4. Plugin ────────────────────────────────────────────────


def check_plugins() -> str:
    from radicale.auth import BaseAuth
    from radicale.rights import BaseRights

    auth_module = importlib.import_module("caldes_auth")
    auth_class = getattr(auth_module, "Auth", None)
    _ensure(inspect.isclass(auth_class) and issubclass(auth_class, BaseAuth), "caldes_auth.Auth non è un BaseAuth")
    _ensure("login" not in vars(auth_class), "caldes_auth.Auth ridefinisce login(), che in Radicale 3.7.8 è @final")
    _ensure(
        "_login_ext" in vars(auth_class) or "_login" in vars(auth_class),
        "caldes_auth.Auth non implementa _login_ext né _login",
    )
    rights_module = importlib.import_module("caldes_rights")
    rights_class = getattr(rights_module, "Rights", None)
    _ensure(
        inspect.isclass(rights_class) and issubclass(rights_class, BaseRights),
        "caldes_rights.Rights non è un BaseRights",
    )
    healthcheck = os.path.join(PLUGINS_DIR, "caldes_healthcheck.py")
    with open(healthcheck, "r", encoding="utf-8") as handle:
        compile(handle.read(), healthcheck, "exec")
    return "plugin caldes_auth, caldes_rights e healthcheck verificati"


# ─── 5. Percorso reale ────────────────────────────────────────


class _WsgiClient:
    """Client WSGI minimo per un'Application di Radicale in memoria."""

    def __init__(self, application: Callable[..., Any]) -> None:
        self._application = application

    def request(
        self,
        method: str,
        path: str,
        user: Optional[str] = None,
        body: str = "",
        headers: Optional[Dict[str, str]] = None,
        remote_addr: str = "127.0.0.1",
    ) -> Tuple[int, str]:
        data = body.encode("utf-8")
        environ: Dict[str, Any] = {
            "REQUEST_METHOD": method,
            "PATH_INFO": path,
            "SCRIPT_NAME": "",
            "SERVER_NAME": "localhost",
            "SERVER_PORT": "5232",
            "SERVER_PROTOCOL": "HTTP/1.1",
            "REMOTE_ADDR": remote_addr,
            "CONTENT_LENGTH": str(len(data)),
            "wsgi.input": io.BytesIO(data),
            "wsgi.errors": sys.stderr,
            "wsgi.url_scheme": "http",
            "wsgi.version": (1, 0),
            "wsgi.multithread": False,
            "wsgi.multiprocess": False,
            "wsgi.run_once": False,
        }
        if user is not None:
            token = base64.b64encode(("%s:selftest" % user).encode("utf-8")).decode("ascii")
            environ["HTTP_AUTHORIZATION"] = "Basic " + token
        for name, value in (headers or {}).items():
            key = name.upper().replace("-", "_")
            environ[key if key == "CONTENT_TYPE" else "HTTP_" + key] = value
        status: List[str] = []

        def start_response(line: str, response_headers: Any, exc_info: Any = None) -> None:
            status.append(line)

        chunks = self._application(environ, start_response)
        payload = b"".join(chunks)
        return int(status[0].split()[0]), payload.decode("utf-8", "replace")


def _write_json(path: str, value: Any) -> None:
    tmp = "%s.%d.tmp" % (path, os.getpid())
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(value, handle)
    os.replace(tmp, path)


def _iso_now(offset_s: float = 0.0) -> str:
    moment = time.time() + offset_s
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(moment)) + ".%03dZ" % int((moment % 1) * 1000)


def _policy(mode: str, backend_mode: str, volume_id: str, epoch: int) -> Dict[str, Any]:
    return {
        "schema": 1,
        "version": 1,
        "generated_at": _iso_now(),
        "backend_mode": backend_mode,
        "mode": mode,
        "reasons": [],
        "principal": PRINCIPAL,
        "volume_id": volume_id,
        "epoch": epoch,
        "credential_epoch": 0,
        "readonly": ["f"],
        "hidden": ["_canary"],
    }


def _heartbeat(backend_mode: str, epoch: int, offset_s: float = 0.0) -> Dict[str, Any]:
    return {"schema": 1, "api_version": "selftest", "mode": backend_mode, "epoch": epoch, "ts": _iso_now(offset_s)}


MKCALENDAR_BODY = (
    '<?xml version="1.0" encoding="utf-8"?>'
    '<C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">'
    "<D:set><D:prop><D:displayname>Selftest</D:displayname></D:prop></D:set></C:mkcalendar>"
)
PROPFIND_BODY = (
    '<?xml version="1.0" encoding="utf-8"?>'
    '<D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>'
)


def check_real_path() -> str:
    import radicale
    from radicale import config

    with tempfile.TemporaryDirectory(prefix="caldes-selftest-") as root:
        storage = os.path.join(root, "collections")
        control = os.path.join(root, "control")
        os.makedirs(control)
        policy_file = os.path.join(control, "policy.json")
        heartbeat_file = os.path.join(control, "heartbeat.json")
        configuration = config.load()
        configuration.update({
            "server": {"max_vevent_rrule_occurrence": "50000", "delay_on_error": "0"},
            "auth": {"type": "none", "delay": "0"},
            "rights": {
                "type": "caldes_rights",
                "caldes_policy_file": policy_file,
                "caldes_heartbeat_file": heartbeat_file,
                "caldes_reload_interval": "0",
                "permit_delete_collection": "False",
                "permit_overwrite_collection": "False",
            },
            "storage": {"filesystem_folder": storage, "predefined_collections": "{}"},
            "web": {"type": "none"},
        }, "caldes_selftest")
        previous_principal = os.environ.get("RADICALE_PRINCIPAL")
        os.environ["RADICALE_PRINCIPAL"] = PRINCIPAL
        try:
            client = _WsgiClient(radicale.Application(configuration))
            principal_dir = os.path.join(storage, "collection-root", PRINCIPAL)

            # Volume vuoto, nessuna policy: root 207, principal 403 senza auto-creazione.
            status, _ = client.request("PROPFIND", "/", "caldes-probe", PROPFIND_BODY, {"Depth": "0"})
            _ensure(status == 207, "PROPFIND / del probe: %d invece di 207" % status)
            status, _ = client.request("PROPFIND", "/%s/" % PRINCIPAL, PRINCIPAL, PROPFIND_BODY, {"Depth": "0"})
            _ensure(status == 403, "volume vuoto: PROPFIND del principal %d invece di 403" % status)
            _ensure(not os.path.exists(principal_dir), "volume vuoto: il principal è stato creato al login")

            # Inizializzazione come caldes-svc (contratto §4.4).
            volume_id = str(uuid.uuid4())
            status, _ = client.request("MKCOL", "/%s/" % PRINCIPAL, "caldes-svc")
            _ensure(status == 201, "MKCOL del principal come caldes-svc: %d" % status)
            marker = (
                '<?xml version="1.0" encoding="utf-8"?>'
                '<D:propertyupdate xmlns:D="DAV:" xmlns:K="urn:calicchia:caldes"><D:set><D:prop>'
                "<K:volume-id>%s</K:volume-id><K:epoch>1</K:epoch></D:prop></D:set></D:propertyupdate>" % volume_id
            )
            status, _ = client.request("PROPPATCH", "/%s/" % PRINCIPAL, "caldes-svc", marker)
            _ensure(status == 207, "PROPPATCH del marker: %d" % status)
            for name in ("c", "f"):
                status, _ = client.request("MKCALENDAR", "/%s/%s/" % (PRINCIPAL, name), "caldes-svc", MKCALENDAR_BODY)
                _ensure(status == 201, "MKCALENDAR %s come caldes-svc: %d" % (name, status))

            # Shadow: sola lettura.
            _write_json(policy_file, _policy("shadow", "postgres", volume_id, 1))
            _write_json(heartbeat_file, _heartbeat("postgres", 1))
            status, _ = client.request("PROPFIND", "/%s/" % PRINCIPAL, PRINCIPAL, PROPFIND_BODY, {"Depth": "1"})
            _ensure(status == 207, "shadow: PROPFIND del principal %d invece di 207" % status)
            status, _ = client.request("PUT", "/%s/c/selftest.ics" % PRINCIPAL, PRINCIPAL, FIDELITY_EVENT,
                                       {"Content-Type": "text/calendar"})
            _ensure(status == 403, "shadow: PUT %d invece di 403" % status)

            # Live: scrittura con fedeltà completa.
            _write_json(policy_file, _policy("live", "radicale", volume_id, 1))
            _write_json(heartbeat_file, _heartbeat("radicale", 1))
            status, _ = client.request("PUT", "/%s/c/selftest.ics" % PRINCIPAL, PRINCIPAL, FIDELITY_EVENT,
                                       {"Content-Type": "text/calendar"})
            _ensure(status == 201, "live: PUT %d invece di 201" % status)
            status, text = client.request("GET", "/%s/c/selftest.ics" % PRINCIPAL, PRINCIPAL)
            _ensure(status == 200, "live: GET %d invece di 200" % status)
            lines = _unfold(text)
            for expected in FIDELITY_EXPECTED:
                _ensure(expected in lines, "fedeltà: riga attesa assente dopo PUT/GET: %r" % expected)
            status, _ = client.request("PUT", "/%s/f/selftest.ics" % PRINCIPAL, PRINCIPAL, FIDELITY_EVENT,
                                       {"Content-Type": "text/calendar"})
            _ensure(status == 403, "live: PUT in una collezione readonly %d invece di 403" % status)
            status, _ = client.request("DELETE", "/%s/c/" % PRINCIPAL, PRINCIPAL)
            _ensure(status == 403, "live: DELETE di una collezione %d invece di 403" % status)

            # Heartbeat scaduto: frozen.
            _write_json(heartbeat_file, _heartbeat("radicale", 1, offset_s=-601))
            status, _ = client.request("PUT", "/%s/c/selftest-2.ics" % PRINCIPAL, PRINCIPAL,
                                       FIDELITY_EVENT.replace("caldes-selftest-put", "caldes-selftest-2"),
                                       {"Content-Type": "text/calendar"})
            _ensure(status == 403, "heartbeat scaduto: PUT %d invece di 403" % status)
        finally:
            if previous_principal is None:
                os.environ.pop("RADICALE_PRINCIPAL", None)
            else:
                os.environ["RADICALE_PRINCIPAL"] = previous_principal
    return "percorso reale: identità, shadow, live, fedeltà PUT/GET e heartbeat verificati"


def main(argv: List[str]) -> int:
    config_path = argv[1] if len(argv) > 1 else os.environ.get("CALDES_SELFTEST_CONFIG", "/config/config")
    checks: List[Tuple[str, Callable[[], str]]] = [
        ("versioni", check_versions),
        ("patch vobject", check_vobject_patch),
        ("config", lambda: check_config(config_path)),
        ("plugin", check_plugins),
        ("percorso reale", check_real_path),
    ]
    failed = False
    for name, run in checks:
        try:
            detail = run()
        except SelfTestFailure as exc:
            print("caldes_selftest: FALLITO %s: %s" % (name, exc))
            failed = True
        except Exception as exc:  # noqa: BLE001 - qualsiasi errore fa fallire la build
            print("caldes_selftest: ERRORE %s: %r" % (name, exc))
            failed = True
        else:
            print("caldes_selftest: ok %s: %s" % (name, detail))
    if failed:
        return 1
    print("caldes_selftest: tutto verificato")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
