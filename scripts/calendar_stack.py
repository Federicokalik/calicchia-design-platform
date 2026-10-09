#!/usr/bin/env python3
"""
Funzioni condivise di backup-calendar-stack.sh e restore-calendar-stack.sh
(fase F1 del passaggio del calendario a Radicale, piano attività 9; design
§16.1 e §16.3; contratto docs/calendar-radicale/contracts/control-plane.md §4).

Solo libreria standard (Python 3.9+): gira sull'host del VPS, dove gli script
di backup girano come root da cron, senza dipendenze da installare.

Sottocomandi (output JSON su stdout, errori su stderr con exit 1):

  inventory-archive <tar.gz> [--principal P]
  inventory-dir <radice del volume> [--principal P]
      Inventario del volume di Radicale, dall'archivio o da una cartella, con
      le stesse regole di esclusione del tar (.Radicale.cache,
      .Radicale.tmp-*, collections/.Radicale.lock): così l'inventario
      dell'archivio scritto nel manifest e quello della cartella ripristinata
      si confrontano campo per campo. Contiene il marker d'identità del
      principal (volume-id ed epoch, contratto §4.1), le collezioni con
      numero di item e token di contenuto, e un hash dell'intero albero.

  marker-dir <radice del volume> [--principal P]
      Solo il marker d'identità letto da una cartella (stato del volume
      corrente prima di un ripristino).

  identity --state <json|null> --marker <json>
      Stato dell'identità con le regole di identityStatus() dell'API
      (contratto §4.3): not_applicable (DB senza calendar_backend_state, prima
      della 162), uninitialized (epoch 0 in PG), unverified (marker non
      leggibile), mismatch (marker assente, malformato o diverso), ok.

  write-manifest --dir <cartella del run>
      Scrive manifest.json (atomico, 0600) dai file del run e dalle variabili
      d'ambiente CS_* impostate da backup-calendar-stack.sh.

  verify --dir <cartella del run>
      Verifica un run: manifest leggibile e del formato atteso, file presenti
      con dimensione e sha256 del manifest, gzip integro, inventario
      dell'archivio identico a quello del manifest. Exit 1 al primo errore.

  compare-inventory --expected <json> --actual <json>
      Confronta due inventari (albero, collezioni, marker, proprietario):
      exit 1 con l'elenco delle differenze.

  get --file <json> --path a.b.c [--default X]
      Stampa un valore di un file JSON (stringhe senza virgolette, null come
      stringa vuota, oggetti e liste in JSON).

  url-info <postgres-url>
      dbname, user e URL di manutenzione (database `postgres`) di un URL.

  prune-ids --days N --keep K <id>...
      Id di run (YYYYMMDDTHHMMSSZ) più vecchi di N giorni da eliminare,
      tenendo sempre i K più recenti.

  s3-ls-ids
      Legge da stdin l'output di `aws s3 ls s3://bucket/prefisso/` e stampa
      gli id dei run (righe PRE <id>/).
"""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import hashlib
import json
import os
import re
import stat
import sys
import tarfile
import tempfile
from typing import Any, Dict, Iterable, Iterator, List, Optional, Tuple
from urllib.parse import unquote, urlsplit, urlunsplit

MANIFEST_NAME = "manifest.json"
MANIFEST_KIND = "caldes-calendar-stack-backup"
MANIFEST_SCHEMA = 1
DB_FILE = "caldes-db.sql.gz"
VOLUME_FILE = "radicale-collections.tar.gz"
#: Cartella delle collezioni nel volume (filesystem_folder = /data/collections).
COLLECTIONS = "collections"
COLLECTION_ROOT = COLLECTIONS + "/collection-root"
PROPS = ".Radicale.props"
NS = "{urn:calicchia:caldes}"
VOLUME_ID_KEY = NS + "volume-id"
EPOCH_KEY = NS + "epoch"
CALENDAR_ID_KEY = NS + "calendar-id"
ROLE_KEY = NS + "role"
UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
EPOCH_RE = re.compile(r"^[1-9][0-9]{0,9}$")
PRINCIPAL_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
RUN_ID_RE = re.compile(r"^(\d{8})T(\d{6})Z$")
MAX_INT32 = 2_147_483_647
PROPS_MAX_BYTES = 1_048_576


class ToolError(Exception):
    pass


# ─── Esclusioni (identiche alle --exclude del tar) ────────────


def excluded(relpath: str) -> bool:
    """True se il percorso (relativo alla radice del volume, con '/') non va nel backup."""
    parts = relpath.split("/")
    if any(p == ".Radicale.cache" for p in parts):
        return True
    if parts[-1].startswith(".Radicale.tmp-"):
        return True
    if relpath == COLLECTIONS + "/.Radicale.lock":
        return True
    return False


def is_item_name(name: str) -> bool:
    """Item di una collezione secondo Radicale (is_safe_filesystem_path_component)."""
    return bool(name) and not name.startswith(".") and not name.endswith("~")


# ─── Marker d'identità ────────────────────────────────────────


def parse_marker(raw: Optional[bytes], *, unreadable: Optional[str] = None) -> Dict[str, Any]:
    """Marker del principal dal contenuto di .Radicale.props (contratto §4.1)."""
    if unreadable is not None:
        return {"state": "unreadable", "volume_id": None, "epoch": None, "detail": unreadable}
    if raw is None:
        return {"state": "missing", "volume_id": None, "epoch": None, "detail": "file assente"}
    if len(raw) > PROPS_MAX_BYTES:
        return {"state": "invalid", "volume_id": None, "epoch": None, "detail": "file troppo grande"}
    try:
        doc = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return {"state": "invalid", "volume_id": None, "epoch": None, "detail": "non è JSON UTF-8"}
    if not isinstance(doc, dict):
        return {"state": "invalid", "volume_id": None, "epoch": None, "detail": "non è un oggetto JSON"}
    vid, epoch = doc.get(VOLUME_ID_KEY), doc.get(EPOCH_KEY)
    if vid is None and epoch is None:
        return {"state": "missing", "volume_id": None, "epoch": None, "detail": "dead prop assenti"}
    if not isinstance(vid, str) or not UUID_RE.match(vid):
        return {"state": "invalid", "volume_id": None, "epoch": None, "detail": "volume-id malformato"}
    if not isinstance(epoch, str) or not EPOCH_RE.match(epoch) or int(epoch) > MAX_INT32:
        return {"state": "invalid", "volume_id": None, "epoch": None, "detail": "epoch malformato"}
    return {"state": "ok", "volume_id": vid.lower(), "epoch": int(epoch), "detail": None}


def collection_props(raw: Optional[bytes]) -> Dict[str, Optional[str]]:
    """calendar-id e role dalle dead prop di una collezione (solo informativi)."""
    out: Dict[str, Optional[str]] = {"calendar_id": None, "role": None}
    if raw is None or len(raw) > PROPS_MAX_BYTES:
        return out
    try:
        doc = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return out
    if isinstance(doc, dict):
        cid, role = doc.get(CALENDAR_ID_KEY), doc.get(ROLE_KEY)
        out["calendar_id"] = cid.lower() if isinstance(cid, str) and UUID_RE.match(cid) else None
        out["role"] = role if isinstance(role, str) and len(role) <= 64 else None
    return out


def identity_status(state: Optional[Dict[str, Any]], marker: Dict[str, Any]) -> Tuple[str, str]:
    """(stato, spiegazione) con le regole di identityStatus() dell'API (contratto §4.3)."""
    if state is None:
        return "not_applicable", "calendar_backend_state assente (database precedente alla migrazione 162)"
    epoch = state.get("epoch")
    if not isinstance(epoch, int) or epoch == 0:
        return "uninitialized", "epoch 0 in PG: volume non ancora inizializzato (qualunque cosa ci sia sul volume)"
    if marker.get("state") == "unreadable":
        return "unverified", "marker non leggibile: %s" % (marker.get("detail") or "errore")
    if marker.get("state") != "ok":
        return "mismatch", "marker %s (%s) con epoch %d in PG" % (marker.get("state"), marker.get("detail"), epoch)
    vid = state.get("volume_id")
    if isinstance(vid, str) and vid.lower() == marker["volume_id"] and epoch == marker["epoch"]:
        return "ok", "volume-id ed epoch coincidono (epoch %d)" % epoch
    return "mismatch", "PG ha volume %s epoch %s, il volume ha %s epoch %s" % (
        vid, epoch, marker.get("volume_id"), marker.get("epoch"))


# ─── Inventario ───────────────────────────────────────────────


class _Inventory:
    """Accumula i file del volume e produce l'inventario (dict JSON)."""

    def __init__(self, principal: str) -> None:
        self.principal = principal
        self.files: Dict[str, str] = {}  # relpath → sha256
        self.sizes: Dict[str, int] = {}
        self.collections: Dict[str, Dict[str, Any]] = {}
        self.marker_raw: Optional[bytes] = None
        self.marker_error: Optional[str] = None
        self.owner: Optional[Dict[str, int]] = None
        self.symlinks = 0
        self.has_collections_dir = False

    def add_dir(self, relpath: str, uid: int, gid: int) -> None:
        if relpath == COLLECTIONS:
            self.has_collections_dir = True
            self.owner = {"uid": uid, "gid": gid}

    def add_file(self, relpath: str, content: bytes) -> None:
        digest = hashlib.sha256(content).hexdigest()
        self.files[relpath] = digest
        self.sizes[relpath] = len(content)
        if not relpath.startswith(COLLECTION_ROOT + "/"):
            return
        rest = relpath[len(COLLECTION_ROOT) + 1:].split("/")
        # rest = [principal, ...]: props del principal o file di una collezione.
        if len(rest) == 2 and rest[0] == self.principal and rest[1] == PROPS:
            self.marker_raw = content
            return
        if len(rest) < 3:
            return
        name = rest[0] + "/" + rest[1]
        coll = self.collections.setdefault(name, {"items": {}, "props": None, "props_raw": None})
        tail = "/".join(rest[2:])
        if tail == PROPS:
            coll["props"] = digest
            coll["props_raw"] = content
        elif len(rest) == 3 and is_item_name(rest[2]):
            coll["items"][rest[2]] = (digest, len(content))
        else:
            coll["other"] = coll.get("other", 0) + 1

    def result(self) -> Dict[str, Any]:
        tree = hashlib.sha256()
        for path in sorted(self.files):
            tree.update(("%s\t%s\t%d\n" % (path, self.files[path], self.sizes[path])).encode("utf-8"))
        collections = []
        items_total = 0
        for name in sorted(self.collections):
            coll = self.collections[name]
            token = hashlib.sha256()
            for href in sorted(coll["items"]):
                digest, size = coll["items"][href]
                token.update(("%s\t%s\t%d\n" % (href, digest, size)).encode("utf-8"))
            props = collection_props(coll["props_raw"])
            items = len(coll["items"])
            items_total += items
            collections.append({
                "name": name,
                "items": items,
                "bytes": sum(size for _, size in coll["items"].values()),
                "content_token": token.hexdigest(),
                "props_sha256": coll["props"],
                "calendar_id": props["calendar_id"],
                "role": props["role"],
                "other_files": coll.get("other", 0),
            })
        marker = parse_marker(self.marker_raw, unreadable=self.marker_error)
        return {
            "principal": self.principal,
            "layout_ok": self.has_collections_dir,
            "owner": self.owner,
            "files": len(self.files),
            "bytes": sum(self.sizes.values()),
            "tree_sha256": tree.hexdigest(),
            "items_total": items_total,
            "collections": collections,
            "marker": marker,
            "symlinks": self.symlinks,
        }


def _check_principal(principal: str) -> str:
    if not PRINCIPAL_RE.match(principal) or principal.startswith("caldes-"):
        raise ToolError("principal non valido: %r" % principal)
    return principal


def inventory_archive(path: str, principal: str) -> Dict[str, Any]:
    inv = _Inventory(_check_principal(principal))
    try:
        with tarfile.open(path, "r:gz") as tar:
            for member in tar:
                name = member.name
                while name.startswith("./"):
                    name = name[2:]
                name = name.rstrip("/")
                if not name or name.startswith("/") or ".." in name.split("/"):
                    raise ToolError("archivio con un percorso non sicuro: %r" % member.name)
                if name != COLLECTIONS and not name.startswith(COLLECTIONS + "/"):
                    raise ToolError("archivio con un membro fuori da %s/: %r" % (COLLECTIONS, member.name))
                if excluded(name):
                    raise ToolError("archivio con un membro che andava escluso: %r" % member.name)
                if member.isdir():
                    inv.add_dir(name, member.uid, member.gid)
                elif member.isreg():
                    handle = tar.extractfile(member)
                    if handle is None:
                        raise ToolError("membro illeggibile: %r" % member.name)
                    inv.add_file(name, handle.read())
                elif member.issym() or member.islnk():
                    inv.symlinks += 1
                else:
                    raise ToolError("archivio con un membro di tipo non ammesso: %r" % member.name)
    except (tarfile.TarError, OSError, EOFError) as exc:
        raise ToolError("archivio illeggibile (%s): %s" % (path, exc))
    return inv.result()


def _walk(root: str) -> Iterator[Tuple[str, os.stat_result]]:
    """(relpath, lstat) di tutto ciò che sta sotto root/collections, in ordine."""
    base = os.path.join(root, COLLECTIONS)
    st = os.lstat(base)
    yield COLLECTIONS, st
    stack = [COLLECTIONS]
    while stack:
        rel = stack.pop()
        with os.scandir(os.path.join(root, rel)) as entries:
            for entry in sorted(entries, key=lambda e: e.name):
                child = rel + "/" + entry.name
                if excluded(child):
                    continue
                est = entry.stat(follow_symlinks=False)
                yield child, est
                if stat.S_ISDIR(est.st_mode):
                    stack.append(child)


def inventory_dir(root: str, principal: str) -> Dict[str, Any]:
    inv = _Inventory(_check_principal(principal))
    if not os.path.isdir(os.path.join(root, COLLECTIONS)):
        return inv.result()
    marker_rel = COLLECTION_ROOT + "/" + principal + "/" + PROPS
    for rel, st in _walk(root):
        if stat.S_ISDIR(st.st_mode):
            inv.add_dir(rel, st.st_uid, st.st_gid)
        elif stat.S_ISREG(st.st_mode):
            try:
                with open(os.path.join(root, rel), "rb") as handle:
                    inv.add_file(rel, handle.read())
            except OSError as exc:
                if rel == marker_rel:
                    inv.marker_error = str(exc)
                    continue
                raise ToolError("file illeggibile %s: %s" % (rel, exc))
        elif stat.S_ISLNK(st.st_mode):
            inv.symlinks += 1
    return inv.result()


def marker_dir(root: str, principal: str) -> Dict[str, Any]:
    path = os.path.join(root, COLLECTION_ROOT, _check_principal(principal), PROPS)
    try:
        with open(path, "rb") as handle:
            return parse_marker(handle.read(PROPS_MAX_BYTES + 1))
    except FileNotFoundError:
        if not os.path.isdir(root):
            return parse_marker(None, unreadable="cartella del volume assente: %s" % root)
        return parse_marker(None)
    except OSError as exc:
        return parse_marker(None, unreadable=str(exc))


def compare_inventories(expected: Dict[str, Any], actual: Dict[str, Any], *, check_owner: bool = True) -> List[str]:
    diffs: List[str] = []
    for key in ("principal", "files", "bytes", "tree_sha256", "items_total", "symlinks"):
        if expected.get(key) != actual.get(key):
            diffs.append("%s: atteso %r, trovato %r" % (key, expected.get(key), actual.get(key)))
    exp_m, act_m = expected.get("marker") or {}, actual.get("marker") or {}
    for key in ("state", "volume_id", "epoch"):
        if exp_m.get(key) != act_m.get(key):
            diffs.append("marker.%s: atteso %r, trovato %r" % (key, exp_m.get(key), act_m.get(key)))
    exp_c = {c["name"]: c for c in expected.get("collections") or []}
    act_c = {c["name"]: c for c in actual.get("collections") or []}
    for name in sorted(set(exp_c) | set(act_c)):
        if name not in act_c:
            diffs.append("collezione %s assente" % name)
        elif name not in exp_c:
            diffs.append("collezione %s in più" % name)
        else:
            for key in ("items", "bytes", "content_token", "props_sha256"):
                if exp_c[name].get(key) != act_c[name].get(key):
                    diffs.append("collezione %s, %s: atteso %r, trovato %r" % (
                        name, key, exp_c[name].get(key), act_c[name].get(key)))
    if check_owner and expected.get("owner") != actual.get("owner"):
        diffs.append("proprietario di collections/: atteso %r, trovato %r" % (expected.get("owner"), actual.get("owner")))
    return diffs


# ─── File e manifest ──────────────────────────────────────────


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def gzip_ok(path: str) -> Optional[str]:
    try:
        with gzip.open(path, "rb") as handle:
            while handle.read(1 << 20):
                pass
    except (OSError, EOFError) as exc:
        return str(exc)
    return None


def write_json_atomic(path: str, doc: Any) -> None:
    directory = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(prefix=".%s." % os.path.basename(path), suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(doc, handle, ensure_ascii=False, indent=2, sort_keys=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _env(name: str, default: Optional[str] = None) -> Optional[str]:
    value = os.environ.get(name)
    return value if value not in (None, "") else default


def _env_json(name: str) -> Any:
    raw = _env(name)
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except ValueError as exc:
        raise ToolError("%s non è JSON valido: %s" % (name, exc))


def normalize_state(raw: Any) -> Optional[Dict[str, Any]]:
    """Riga di calendar_backend_state (row_to_json) ridotta ai campi del manifest."""
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ToolError("stato del backend non è un oggetto: %r" % (raw,))
    vid = raw.get("volume_id")
    return {
        "mode": raw.get("mode"),
        "write_freeze": raw.get("write_freeze"),
        "volume_id": vid.lower() if isinstance(vid, str) else None,
        "epoch": raw.get("epoch"),
        "credential_epoch": raw.get("credential_epoch"),
        "policy_version": raw.get("policy_version"),
        "restore_guard_until": raw.get("restore_guard_until"),
        "rebuild_required": raw.get("rebuild_required"),
        "updated_at": raw.get("updated_at"),
    }


def file_entry(run_dir: str, name: str) -> Dict[str, Any]:
    path = os.path.join(run_dir, name)
    return {"file": name, "bytes": os.path.getsize(path), "sha256": sha256_file(path)}


def write_manifest(run_dir: str) -> Dict[str, Any]:
    run_id = _env("CS_ID")
    if not run_id or not RUN_ID_RE.match(run_id):
        raise ToolError("CS_ID mancante o non valido")
    principal = _check_principal(_env("CS_PRINCIPAL", "federico") or "federico")
    state = normalize_state(_env_json("CS_DB_STATE"))
    db = file_entry(run_dir, DB_FILE)
    db.update({
        "format": "pg_dump plain, gzip",
        "started_at": _env("CS_DB_STARTED_AT"),
        "finished_at": _env("CS_DB_FINISHED_AT"),
        "source": _env("CS_DB_SOURCE"),
        "server_version": _env("CS_DB_SERVER_VERSION"),
        "pg_dump_version": _env("CS_PG_DUMP_VERSION"),
        "last_migration": _env("CS_DB_LAST_MIGRATION"),
        "backend_state": state,
    })
    radicale: Optional[Dict[str, Any]] = None
    if os.path.exists(os.path.join(run_dir, VOLUME_FILE)):
        inv = inventory_archive(os.path.join(run_dir, VOLUME_FILE), principal)
        radicale = file_entry(run_dir, VOLUME_FILE)
        radicale.update({
            "format": "tar gzip, radice = volume radicale_collections (/data di Radicale)",
            "source": _env("CS_VOLUME_SOURCE"),
            "lock": _env("CS_VOLUME_LOCK", "shared"),
            "lock_waited_ms": int(_env("CS_VOLUME_LOCK_WAITED_MS", "0") or 0),
            "started_at": _env("CS_VOLUME_STARTED_AT"),
            "finished_at": _env("CS_VOLUME_FINISHED_AT"),
            "excluded": [".Radicale.cache", ".Radicale.tmp-*", "collections/.Radicale.lock"],
            "inventory": inv,
        })
    if radicale is not None:
        identity, detail = identity_status(state, radicale["inventory"]["marker"])
    else:
        identity, detail = "not_captured", "volume di Radicale non incluso in questo backup"
    doc = {
        "schema": MANIFEST_SCHEMA,
        "kind": MANIFEST_KIND,
        "id": run_id,
        "created_at": _env("CS_CREATED_AT"),
        "completed_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "host": _env("CS_HOST"),
        "script": _env("CS_SCRIPT"),
        "principal": principal,
        "database": db,
        "radicale": radicale,
        "consistency": {
            "order": "dump del database, poi snapshot del volume: il volume non è mai più vecchio del dump",
            "identity": identity,
            "identity_detail": detail,
        },
    }
    write_json_atomic(os.path.join(run_dir, MANIFEST_NAME), doc)
    return doc


def load_manifest(run_dir: str) -> Dict[str, Any]:
    path = os.path.join(run_dir, MANIFEST_NAME)
    try:
        with open(path, "r", encoding="utf-8") as handle:
            doc = json.load(handle)
    except FileNotFoundError:
        raise ToolError("manifest assente: %s (run incompleto?)" % path)
    except (OSError, ValueError) as exc:
        raise ToolError("manifest illeggibile: %s" % exc)
    if not isinstance(doc, dict) or doc.get("kind") != MANIFEST_KIND:
        raise ToolError("non è un manifest di backup-calendar-stack: %s" % path)
    if doc.get("schema") != MANIFEST_SCHEMA:
        raise ToolError("schema del manifest non supportato: %r" % doc.get("schema"))
    if not isinstance(doc.get("id"), str) or not RUN_ID_RE.match(doc["id"]):
        raise ToolError("id del manifest non valido")
    if not isinstance(doc.get("database"), dict):
        raise ToolError("manifest senza database")
    return doc


def verify_run(run_dir: str) -> Dict[str, Any]:
    doc = load_manifest(run_dir)
    checked = []
    for section in ("database", "radicale"):
        entry = doc.get(section)
        if entry is None:
            continue
        name = entry.get("file")
        if name not in (DB_FILE, VOLUME_FILE):
            raise ToolError("%s: nome di file inatteso %r" % (section, name))
        path = os.path.join(run_dir, name)
        if not os.path.isfile(path):
            raise ToolError("%s: file assente %s" % (section, path))
        size = os.path.getsize(path)
        if size != entry.get("bytes"):
            raise ToolError("%s: dimensione %d, il manifest dice %r" % (name, size, entry.get("bytes")))
        digest = sha256_file(path)
        if digest != entry.get("sha256"):
            raise ToolError("%s: sha256 diverso da quello del manifest" % name)
        problem = gzip_ok(path)
        if problem:
            raise ToolError("%s: gzip non integro: %s" % (name, problem))
        checked.append(name)
    if doc.get("radicale") is not None:
        inv = inventory_archive(os.path.join(run_dir, VOLUME_FILE), doc.get("principal") or "federico")
        diffs = compare_inventories(doc["radicale"].get("inventory") or {}, inv)
        if diffs:
            raise ToolError("inventario dell'archivio diverso dal manifest: " + "; ".join(diffs))
    return {"id": doc["id"], "verified": checked, "identity": doc.get("consistency", {}).get("identity")}


# ─── Utilità per gli script ───────────────────────────────────


def get_path(doc: Any, path: str) -> Any:
    cur = doc
    for part in path.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            raise KeyError(path)
    return cur


def url_info(url: str) -> Dict[str, str]:
    parts = urlsplit(url)
    if parts.scheme not in ("postgres", "postgresql"):
        raise ToolError("URL del database non supportato (serve postgresql://)")
    dbname = unquote(parts.path.lstrip("/"))
    if not dbname or "/" in dbname:
        raise ToolError("URL del database senza nome del database")
    user = unquote(parts.username or "")
    maintenance = urlunsplit((parts.scheme, parts.netloc, "/postgres", parts.query, parts.fragment))
    return {"dbname": dbname, "user": user, "maintenance_url": maintenance}


def run_id_time(run_id: str) -> dt.datetime:
    m = RUN_ID_RE.match(run_id)
    if not m:
        raise ValueError(run_id)
    return dt.datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M%S").replace(tzinfo=dt.timezone.utc)


def prune_ids(ids: Iterable[str], days: int, keep: int, now: Optional[dt.datetime] = None) -> List[str]:
    valid = sorted({i for i in ids if RUN_ID_RE.match(i)}, reverse=True)
    now = now or dt.datetime.now(dt.timezone.utc)
    cutoff = now - dt.timedelta(days=days)
    out = []
    for index, run_id in enumerate(valid):
        if index < keep:
            continue
        try:
            if run_id_time(run_id) < cutoff:
                out.append(run_id)
        except ValueError:
            continue
    return out


def s3_ls_ids(lines: Iterable[str]) -> List[str]:
    ids = []
    for line in lines:
        m = re.match(r"^\s*PRE\s+(\S+)/\s*$", line)
        if m and RUN_ID_RE.match(m.group(1)):
            ids.append(m.group(1))
    return ids


def _print(doc: Any) -> None:
    json.dump(doc, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


def main(argv: List[str]) -> int:
    parser = argparse.ArgumentParser(prog="calendar_stack.py", description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    for name in ("inventory-archive", "inventory-dir", "marker-dir"):
        p = sub.add_parser(name)
        p.add_argument("path")
        p.add_argument("--principal", default=os.environ.get("RADICALE_PRINCIPAL") or "federico")
    p = sub.add_parser("identity")
    p.add_argument("--state", required=True)
    p.add_argument("--marker", required=True)
    for name in ("write-manifest", "verify"):
        p = sub.add_parser(name)
        p.add_argument("--dir", required=True)
    p = sub.add_parser("compare-inventory")
    p.add_argument("--expected", required=True)
    p.add_argument("--actual", required=True)
    p.add_argument("--ignore-owner", action="store_true")
    p = sub.add_parser("get")
    p.add_argument("--file", required=True)
    p.add_argument("--path", required=True)
    p.add_argument("--default")
    p = sub.add_parser("url-info")
    p.add_argument("url")
    p = sub.add_parser("prune-ids")
    p.add_argument("--days", type=int, required=True)
    p.add_argument("--keep", type=int, default=1)
    p.add_argument("ids", nargs="*")
    sub.add_parser("s3-ls-ids")
    args = parser.parse_args(argv)

    try:
        if args.cmd == "inventory-archive":
            _print(inventory_archive(args.path, args.principal))
        elif args.cmd == "inventory-dir":
            _print(inventory_dir(args.path, args.principal))
        elif args.cmd == "marker-dir":
            _print(marker_dir(args.path, args.principal))
        elif args.cmd == "identity":
            state = normalize_state(json.loads(args.state))
            status, detail = identity_status(state, json.loads(args.marker))
            _print({"status": status, "detail": detail})
        elif args.cmd == "write-manifest":
            doc = write_manifest(args.dir)
            _print({"id": doc["id"], "identity": doc["consistency"]["identity"]})
        elif args.cmd == "verify":
            _print(verify_run(args.dir))
        elif args.cmd == "compare-inventory":
            diffs = compare_inventories(json.loads(args.expected), json.loads(args.actual),
                                        check_owner=not args.ignore_owner)
            _print({"equal": not diffs, "differences": diffs})
            return 0 if not diffs else 1
        elif args.cmd == "get":
            try:
                with open(args.file, "r", encoding="utf-8") as handle:
                    doc = json.load(handle)
            except OSError as exc:
                raise ToolError("file illeggibile: %s" % exc)
            try:
                value = get_path(doc, args.path)
            except KeyError:
                if args.default is None:
                    raise ToolError("campo assente: %s" % args.path)
                value = args.default
            if value is None:
                print("")
            elif isinstance(value, (dict, list)):
                print(json.dumps(value, ensure_ascii=False))
            elif isinstance(value, bool):
                print("true" if value else "false")
            else:
                print(value)
        elif args.cmd == "url-info":
            _print(url_info(args.url))
        elif args.cmd == "prune-ids":
            for run_id in prune_ids(args.ids, args.days, args.keep):
                print(run_id)
        elif args.cmd == "s3-ls-ids":
            for run_id in s3_ls_ids(sys.stdin):
                print(run_id)
    except ToolError as exc:
        print("calendar_stack: %s" % exc, file=sys.stderr)
        return 1
    except ValueError as exc:
        print("calendar_stack: JSON non valido: %s" % exc, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
