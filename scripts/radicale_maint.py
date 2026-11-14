#!/usr/bin/env python3
"""
Funzioni di scripts/radicale-maint.sh (fase F3 del passaggio del calendario a
Radicale, piano attività 6; contratto docs/calendar-radicale/contracts/
f3-modules.md §12 e §14.1; design §16.1 e §16.4).

Solo libreria standard (Python 3.9+), come calendar_stack.py, di cui riusa le
regole del marker d'identità, delle proprietà delle collezioni e del confronto
con calendar_backend_state: gira sull'host del VPS come root, senza
dipendenze da installare. Non scrive mai nel volume di Radicale, tranne
purge-cache e compact-cache, che toccano solo le cartelle .Radicale.cache e
vanno eseguiti con il lock ESCLUSIVO di Radicale (lo prende lo script bash).
Non scrive mai nel volume della Fase 0.

Nessun dato personale nei report: nomi di collezioni e di item, conteggi,
dimensioni e codici; mai il contenuto degli eventi.

Sottocomandi (report JSON su stdout, errori su stderr con exit 1; con --human
anche un riepilogo leggibile su stderr):

  limits
      Limiti usati dallo script (allineati a MIGRATION_LIMITS dell'API e al
      config di Radicale): dimensione e item dell'archivio della Fase 0,
      dimensione massima di un item, soglia delle collezioni grandi.

  ensure-lock <radice del volume>
      Crea collections/.Radicale.lock se manca, con il proprietario di
      collections/ (un file di root lo renderebbe inapribile per Radicale).

  scan <radice> [--principal P] [--fs-type T]
  du <radice> [--principal P]
      Stato del volume: layout, lock, marker d'identità del principal,
      collezioni con item, byte, cache e temporanei; du ordina per dimensione
      e segnala le collezioni oltre 5000 item.

  verify <radice> [--principal P] [--max-resource-size N] [--tmp-age-hours H]
      Verifica strutturale (sola lettura): layout, marker, proprietà delle
      collezioni, item iCalendar (UTF-8, BEGIN/END bilanciati, un solo UID,
      UID duplicati nella collezione, dimensione), link simbolici, temporanei
      rimasti da un crash, proprietari diversi da quello di collections/.
      Exit 1 con almeno un errore (gli avvisi non cambiano l'exit).

  identity <radice> --state <json|null> [--principal P]
      Marker del volume contro lo stato del backend (regole di
      identityStatus() dell'API, come calendar_stack.py identity). Exit 1 se
      l'identità non è utilizzabile: mismatch, unverified, not_applicable, o
      database non inizializzato con un marker già sul volume.

  purge-cache <radice> [--dry-run]
      Rimuove tutte le cartelle .Radicale.cache sotto collections/ (mai link
      simbolici, mai altri file). Da eseguire sotto il lock esclusivo.

  compact-cache <radice> [--dry-run]
      Rimuove dalla cache degli item (.Radicale.cache/item) le voci degli item
      che non esistono più nella collezione, con la stessa regola di
      Radicale (_clean_item_cache). Da eseguire sotto il lock esclusivo.

  phase0-scan <cartella> [--source S] [--mounted-by NOMI]
      Contenuto del volume della Fase 0: file, byte, item .ics esportabili con
      i nomi che userà phase0-export, collezioni e principal.

  phase0-manifest --archive F --name N --source S --out F
      Manifest (atomico, 0600) del tar.gz di phase0-backup: sha256, byte,
      membri, item .ics esportabili.

  phase0-export --out F (--dir D | --tar T) [--source S] [--max-bytes N] [--max-items N]
      archivio-fase0.zip (atomico, 0600): un'entry <collezione>__<item>.ics
      per item, con gli stessi nomi che readTarIcsEntries() dell'API dà agli
      item del tar di phase0-backup (lo stesso item ha la stessa chiave del
      ledger qualunque sia il file caricato), più manifest.json. Deflate,
      niente zip64: è il formato che legge readZipIcsEntries().
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import tarfile
import tempfile
import time
import zipfile
from typing import Any, Callable, Dict, Iterable, Iterator, List, Optional, Set, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import calendar_stack as cs  # noqa: E402  (stessa cartella: regole condivise con il backup)

#: MIGRATION_LIMITS.archiveMaxBytes e archiveMaxItems dell'API (types.ts): oltre, il wizard rifiuta il file.
ARCHIVE_MAX_BYTES = 20 * 1024 * 1024
ARCHIVE_MAX_ITEMS = 20_000
#: Dimensione massima decompressa di un item accettata da readZipIcsEntries()/readTarIcsEntries().
ARCHIVE_MAX_ENTRY_BYTES = 10 * 1024 * 1024
#: [server] max_resource_size di apps/radicale/config/config.
MAX_RESOURCE_SIZE = 10_000_000
#: Soglia d'allarme per collezione (design §16.5; Radicale è O(n) per collezione).
LARGE_COLLECTION_ITEMS = 5_000
CACHE_DIR = ".Radicale.cache"
TMP_PREFIX = ".Radicale.tmp-"
LOCK_NAME = ".Radicale.lock"
EXPORT_KIND = "caldes-phase0-export"
BACKUP_KIND = "caldes-phase0-backup"
#: Data fissa delle entry dello zip: export ripetibili dello stesso volume danno lo stesso contenuto.
ZIP_DATE = (1980, 1, 1, 0, 0, 0)
PROPERTY_RE = re.compile(r"^([A-Za-z0-9-]+)[;:]")


class ToolError(Exception):
    pass


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _print(doc: Any) -> None:
    json.dump(doc, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


def _human(lines: Iterable[str]) -> None:
    for line in lines:
        print(line, file=sys.stderr)


def fmt_bytes(n: int) -> str:
    value = float(n)
    for unit in ("B", "KiB", "MiB", "GiB"):
        if value < 1024 or unit == "GiB":
            return ("%d %s" % (value, unit)) if unit == "B" else ("%.1f %s" % (value, unit))
        value /= 1024
    return "%d B" % n


def safe_component(name: str) -> bool:
    """Nome di file o cartella sicuro secondo Radicale (is_safe_filesystem_path_component)."""
    return bool(name) and name not in (".", "..") and "/" not in name and not name.startswith(".") and not name.endswith("~")


def tree_size(path: str) -> Tuple[int, int]:
    """(byte, file) di un albero, senza seguire i link simbolici."""
    total = files = 0
    for dirpath, dirnames, filenames in os.walk(path, followlinks=False):
        for name in filenames:
            try:
                st = os.lstat(os.path.join(dirpath, name))
            except OSError:
                continue
            if stat.S_ISREG(st.st_mode):
                total += st.st_size
                files += 1
    return total, files


def write_json_atomic(path: str, doc: Any) -> None:
    cs.write_json_atomic(path, doc)


# ─── Volume di Radicale: scansione ────────────────────────────


def _volume_paths(root: str) -> Tuple[str, str]:
    base = os.path.join(root, cs.COLLECTIONS)
    return base, os.path.join(root, cs.COLLECTION_ROOT)


def _read_props(path: str) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """(.Radicale.props come dict, errore) di una collezione; (None, None) se il file manca."""
    try:
        with open(path, "rb") as handle:
            raw = handle.read(cs.PROPS_MAX_BYTES + 1)
    except FileNotFoundError:
        return None, None
    except OSError as exc:
        return None, "illeggibile: %s" % exc.strerror
    if len(raw) > cs.PROPS_MAX_BYTES:
        return None, "file troppo grande"
    try:
        doc = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None, "non è JSON UTF-8"
    if not isinstance(doc, dict):
        return None, "non è un oggetto JSON"
    return doc, None


def scan_volume(root: str, principal: str, *, tmp_age_s: float = 3600.0) -> Dict[str, Any]:
    """Stato del volume senza leggere il contenuto degli item."""
    cs._check_principal(principal)
    base, croot = _volume_paths(root)
    out: Dict[str, Any] = {
        "volume_root": os.path.abspath(root),
        "layout_ok": os.path.isdir(base) and not os.path.islink(base),
        "collection_root": os.path.isdir(croot),
        "owner": None,
        "lock": {"present": False},
        "principal": principal,
        "principals": [],
        "marker": cs.marker_dir(root, principal),
        "collections": [],
        "items_total": 0,
        "bytes_total": 0,
        "cache_bytes_total": 0,
        "temp_leftovers": 0,
        "symlinks": 0,
        "large_collections": [],
    }
    if not out["layout_ok"]:
        return out
    st = os.lstat(base)
    out["owner"] = {"uid": st.st_uid, "gid": st.st_gid}
    lock = os.path.join(base, LOCK_NAME)
    try:
        lst = os.lstat(lock)
        out["lock"] = {"present": True, "regular": stat.S_ISREG(lst.st_mode), "uid": lst.st_uid, "gid": lst.st_gid}
    except FileNotFoundError:
        pass
    if not out["collection_root"]:
        return out
    now = time.time()
    with os.scandir(croot) as entries:
        principals = sorted(e.name for e in entries if e.is_dir(follow_symlinks=False))
    out["principals"] = principals
    for p in principals:
        pdir = os.path.join(croot, p)
        with os.scandir(pdir) as entries:
            names = sorted(entries, key=lambda e: e.name)
        for entry in names:
            if entry.is_symlink():
                out["symlinks"] += 1
                continue
            if not entry.is_dir(follow_symlinks=False) or entry.name.startswith("."):
                continue
            coll = _scan_collection(os.path.join(pdir, entry.name), "%s/%s" % (p, entry.name), now, tmp_age_s)
            out["collections"].append(coll)
            out["items_total"] += coll["items"]
            out["bytes_total"] += coll["bytes"]
            out["cache_bytes_total"] += coll["cache_bytes"]
            out["temp_leftovers"] += coll["temp_leftovers"]
            out["symlinks"] += coll["symlinks"]
            if coll["items"] > LARGE_COLLECTION_ITEMS:
                out["large_collections"].append(coll["name"])
    return out


def _scan_collection(path: str, name: str, now: float, tmp_age_s: float) -> Dict[str, Any]:
    props, props_error = _read_props(os.path.join(path, cs.PROPS))
    info = cs.collection_props(json.dumps(props).encode("utf-8") if props is not None else None)
    coll: Dict[str, Any] = {
        "name": name,
        "items": 0,
        "bytes": 0,
        "cache_bytes": 0,
        "tag": props.get("tag") if props and isinstance(props.get("tag"), str) else None,
        "role": info["role"],
        "calendar_id": info["calendar_id"],
        "props": "ok" if props is not None else ("missing" if props_error is None else "invalid"),
        "temp_leftovers": 0,
        "subdirs": 0,
        "other_files": 0,
        "symlinks": 0,
    }
    with os.scandir(path) as entries:
        for entry in entries:
            if entry.is_symlink():
                coll["symlinks"] += 1
                continue
            if entry.name == CACHE_DIR and entry.is_dir(follow_symlinks=False):
                coll["cache_bytes"] += tree_size(entry.path)[0]
                continue
            if entry.name.startswith(TMP_PREFIX):
                try:
                    if now - entry.stat(follow_symlinks=False).st_mtime > tmp_age_s:
                        coll["temp_leftovers"] += 1
                except OSError:
                    pass
                continue
            if entry.is_dir(follow_symlinks=False):
                coll["subdirs"] += 1
                continue
            if entry.name == cs.PROPS:
                continue
            if entry.is_file(follow_symlinks=False) and cs.is_item_name(entry.name):
                coll["items"] += 1
                coll["bytes"] += entry.stat(follow_symlinks=False).st_size
            else:
                coll["other_files"] += 1
    return coll


def human_scan(doc: Dict[str, Any], *, title: str) -> List[str]:
    marker = doc["marker"]
    lines = [
        "%s: %s" % (title, doc["volume_root"]),
        "  layout: %s, lock di Radicale: %s" % (
            "ok" if doc["layout_ok"] and doc["collection_root"] else "INCOMPLETO",
            "presente" if doc["lock"].get("present") else "assente"),
        "  marker di %s: %s%s" % (
            doc["principal"], marker.get("state"),
            (" (volume %s, epoch %s)" % (marker.get("volume_id"), marker.get("epoch"))) if marker.get("state") == "ok" else
            (" (%s)" % marker.get("detail") if marker.get("detail") else "")),
        "  collezioni: %d, item: %d, dati: %s, cache: %s" % (
            len(doc["collections"]), doc["items_total"], fmt_bytes(doc["bytes_total"]), fmt_bytes(doc["cache_bytes_total"])),
    ]
    if doc.get("fs_type"):
        lines.append("  filesystem: %s" % doc["fs_type"])
    if doc["temp_leftovers"]:
        lines.append("  ATTENZIONE: %d temporanei rimasti da scritture interrotte" % doc["temp_leftovers"])
    if doc["large_collections"]:
        lines.append("  ATTENZIONE: collezioni oltre %d item: %s" % (LARGE_COLLECTION_ITEMS, ", ".join(doc["large_collections"])))
    return lines


def du_report(doc: Dict[str, Any]) -> Dict[str, Any]:
    rows = sorted(doc["collections"], key=lambda c: (-(c["bytes"] + c["cache_bytes"]), c["name"]))
    return {
        "volume_root": doc["volume_root"],
        "collections": [
            {"name": c["name"], "items": c["items"], "bytes": c["bytes"], "cache_bytes": c["cache_bytes"],
             "role": c["role"], "large": c["items"] > LARGE_COLLECTION_ITEMS}
            for c in rows
        ],
        "items_total": doc["items_total"],
        "bytes_total": doc["bytes_total"],
        "cache_bytes_total": doc["cache_bytes_total"],
        "large_threshold": LARGE_COLLECTION_ITEMS,
        "warnings": ["collezione %s con %d item (oltre %d)" % (c["name"], c["items"], LARGE_COLLECTION_ITEMS)
                     for c in rows if c["items"] > LARGE_COLLECTION_ITEMS],
    }


def human_du(rep: Dict[str, Any]) -> List[str]:
    lines = ["%-40s %8s %12s %12s  %s" % ("collezione", "item", "dati", "cache", "ruolo")]
    for c in rep["collections"]:
        lines.append("%-40s %8d %12s %12s  %s%s" % (
            c["name"][:40], c["items"], fmt_bytes(c["bytes"]), fmt_bytes(c["cache_bytes"]), c["role"] or "-",
            "  ATTENZIONE: oltre %d item" % rep["large_threshold"] if c["large"] else ""))
    lines.append("%-40s %8d %12s %12s" % ("totale", rep["items_total"], fmt_bytes(rep["bytes_total"]), fmt_bytes(rep["cache_bytes_total"])))
    return lines


# ─── Verifica strutturale ─────────────────────────────────────


def check_item(data: bytes) -> Tuple[List[Tuple[str, str]], Optional[str]]:
    """([(codice, messaggio)], UID) di un item iCalendar: solo struttura, mai il contenuto nei messaggi."""
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return [("ITEM_NOT_UTF8", "non è testo UTF-8")], None
    if text.startswith("﻿"):
        text = text[1:]
    unfolded: List[str] = []
    for line in re.split(r"\r\n|\n|\r", text):
        if line[:1] in (" ", "\t") and unfolded:
            unfolded[-1] += line[1:]
        else:
            unfolded.append(line)
    content = [line for line in unfolded if line.strip()]
    if not content:
        return [("ITEM_EMPTY", "file vuoto")], None
    issues: List[Tuple[str, str]] = []
    if content[0].strip().upper() != "BEGIN:VCALENDAR" or content[-1].strip().upper() != "END:VCALENDAR":
        issues.append(("ITEM_STRUCTURE", "non inizia con BEGIN:VCALENDAR o non finisce con END:VCALENDAR"))
    stack: List[str] = []
    uids: Set[str] = set()
    components = 0
    balanced = True
    for line in content:
        m = PROPERTY_RE.match(line)
        if not m:
            continue
        name = m.group(1).upper()
        value = line.split(":", 1)[1].strip() if ":" in line else ""
        if name == "BEGIN":
            stack.append(value.upper())
            if len(stack) == 2 and value.upper() != "VTIMEZONE":
                components += 1
        elif name == "END":
            if not stack or stack[-1] != value.upper():
                balanced = False
                break
            stack.pop()
        elif name == "UID" and len(stack) == 2 and stack[1] != "VTIMEZONE":
            uids.add(value)
    if not balanced or stack:
        issues.append(("ITEM_STRUCTURE", "BEGIN/END non bilanciati"))
        return issues, None
    if components == 0:
        issues.append(("ITEM_NO_COMPONENT", "nessun componente (VEVENT, VTODO, VJOURNAL)"))
    if not uids or "" in uids:
        issues.append(("ITEM_NO_UID", "componente senza UID"))
    elif len(uids) > 1:
        issues.append(("ITEM_MULTIPLE_UIDS", "%d UID diversi nello stesso item (Radicale ne ammette uno)" % len(uids)))
    uid = next(iter(uids)) if len(uids) == 1 else None
    return issues, uid


def verify_volume(root: str, principal: str, *, max_resource_size: int, tmp_age_s: float) -> Dict[str, Any]:
    scan = scan_volume(root, principal, tmp_age_s=tmp_age_s)
    errors: List[Dict[str, str]] = []
    warnings: List[Dict[str, str]] = []

    def err(code: str, path: str, message: str) -> None:
        errors.append({"code": code, "path": path, "message": message})

    def warn(code: str, path: str, message: str) -> None:
        warnings.append({"code": code, "path": path, "message": message})

    checked = {"collections": 0, "items": 0}
    report = {"volume_root": scan["volume_root"], "principal": principal, "errors": errors, "warnings": warnings,
              "checked": checked, "marker": scan["marker"]}
    if not scan["layout_ok"]:
        err("LAYOUT", cs.COLLECTIONS, "manca la cartella collections/ (o è un link simbolico)")
        report["ok"] = False
        return report
    if not scan["collection_root"]:
        warn("NO_COLLECTION_ROOT", cs.COLLECTION_ROOT, "nessuna collection-root: Radicale non ha ancora servito richieste su questo volume")
    if not scan["lock"].get("present"):
        warn("LOCK_MISSING", cs.COLLECTIONS + "/" + LOCK_NAME, "lock di Radicale assente (lo crea Radicale alla prima richiesta)")
    elif not scan["lock"].get("regular"):
        err("LOCK_NOT_REGULAR", cs.COLLECTIONS + "/" + LOCK_NAME, "il lock di Radicale non è un file regolare")
    marker = scan["marker"]
    if marker["state"] == "invalid":
        err("MARKER_INVALID", "%s/%s/%s" % (cs.COLLECTION_ROOT, principal, cs.PROPS), "marker d'identità malformato: %s" % marker.get("detail"))
    elif marker["state"] == "unreadable":
        err("MARKER_UNREADABLE", "%s/%s/%s" % (cs.COLLECTION_ROOT, principal, cs.PROPS), "marker d'identità illeggibile: %s" % marker.get("detail"))
    elif marker["state"] == "missing" and scan["collection_root"]:
        warn("MARKER_MISSING", "%s/%s" % (cs.COLLECTION_ROOT, principal), "marker d'identità assente: volume non inizializzato (i device non hanno accesso)")
    for p in scan["principals"]:
        if p != principal:
            warn("EXTRA_PRINCIPAL", "%s/%s" % (cs.COLLECTION_ROOT, p), "principal diverso da quello canonico (%s): i device non lo vedono" % principal)

    owner = scan["owner"] or {}
    base, croot = _volume_paths(root)
    owner_mismatch = 0
    now = time.time()
    for dirpath, dirnames, filenames in os.walk(base, followlinks=False):
        rel_dir = os.path.relpath(dirpath, root)
        for name in list(dirnames):
            full = os.path.join(dirpath, name)
            try:
                st = os.lstat(full)
            except OSError as exc:
                err("UNREADABLE", os.path.join(rel_dir, name), "illeggibile: %s" % exc.strerror)
                dirnames.remove(name)
                continue
            if stat.S_ISLNK(st.st_mode):
                err("SYMLINK", os.path.join(rel_dir, name), "link simbolico nel volume")
                dirnames.remove(name)
                continue
            if name == CACHE_DIR:
                # La cache è di Radicale e si ricostruisce: non si verifica.
                dirnames.remove(name)
                continue
            if name.startswith(TMP_PREFIX):
                # Cartella temporanea di una creazione di collezione interrotta.
                if now - st.st_mtime > tmp_age_s:
                    warn("TEMP_LEFTOVER", os.path.join(rel_dir, name), "cartella temporanea di una scrittura interrotta (si può rimuovere a Radicale fermo)")
                dirnames.remove(name)
                continue
            if owner and (st.st_uid, st.st_gid) != (owner.get("uid"), owner.get("gid")):
                owner_mismatch += 1
                if owner_mismatch <= 20:
                    warn("OWNER_MISMATCH", os.path.join(rel_dir, name), "proprietario %d:%d diverso da collections/ (%d:%d): Radicale potrebbe non poterci scrivere" % (
                        st.st_uid, st.st_gid, owner["uid"], owner["gid"]))
        for name in filenames:
            full = os.path.join(dirpath, name)
            rel = os.path.join(rel_dir, name)
            try:
                st = os.lstat(full)
            except OSError as exc:
                err("UNREADABLE", rel, "illeggibile: %s" % exc.strerror)
                continue
            if stat.S_ISLNK(st.st_mode):
                err("SYMLINK", rel, "link simbolico nel volume")
                continue
            if name.startswith(TMP_PREFIX) and now - st.st_mtime > tmp_age_s:
                warn("TEMP_LEFTOVER", rel, "temporaneo di una scrittura interrotta (si può rimuovere a Radicale fermo)")
            if owner and (st.st_uid, st.st_gid) != (owner.get("uid"), owner.get("gid")):
                owner_mismatch += 1
                if owner_mismatch <= 20:
                    warn("OWNER_MISMATCH", rel, "proprietario %d:%d diverso da collections/ (%d:%d): Radicale potrebbe non poterlo riscrivere" % (
                        st.st_uid, st.st_gid, owner["uid"], owner["gid"]))
    if owner_mismatch > 20:
        warn("OWNER_MISMATCH", cs.COLLECTIONS, "altri %d file o cartelle con un proprietario diverso" % (owner_mismatch - 20))

    if scan["collection_root"]:
        for coll in scan["collections"]:
            checked["collections"] += 1
            p_name, c_name = coll["name"].split("/", 1)
            cpath = os.path.join(croot, p_name, c_name)
            rel_c = "%s/%s" % (cs.COLLECTION_ROOT, coll["name"])
            if coll["props"] == "invalid":
                err("PROPS_INVALID", rel_c + "/" + cs.PROPS, "proprietà della collezione illeggibili o non JSON")
            elif coll["props"] == "missing":
                warn("PROPS_MISSING", rel_c, "cartella senza .Radicale.props: per Radicale non è un calendario")
            elif coll["tag"] != "VCALENDAR":
                warn("NOT_A_CALENDAR", rel_c, "collezione con tag %r invece di VCALENDAR" % coll["tag"])
            if coll["subdirs"]:
                warn("NESTED_DIR", rel_c, "%d sottocartelle dentro una collezione" % coll["subdirs"])
            if coll["other_files"]:
                warn("OTHER_FILES", rel_c, "%d file che non sono item (nascosti o con ~ finale)" % coll["other_files"])
            if coll["items"] > LARGE_COLLECTION_ITEMS:
                warn("COLLECTION_LARGE", rel_c, "%d item (oltre %d)" % (coll["items"], LARGE_COLLECTION_ITEMS))
            uids: Dict[str, str] = {}
            with os.scandir(cpath) as entries:
                items = sorted((e for e in entries if e.is_file(follow_symlinks=False) and cs.is_item_name(e.name)), key=lambda e: e.name)
            for entry in items:
                checked["items"] += 1
                rel = "%s/%s" % (rel_c, entry.name)
                if not entry.name.lower().endswith(".ics"):
                    warn("ITEM_NAME", rel, "nome senza estensione .ics")
                size = entry.stat(follow_symlinks=False).st_size
                if size > max_resource_size:
                    err("ITEM_TOO_LARGE", rel, "%d byte, oltre max_resource_size (%d)" % (size, max_resource_size))
                    continue
                try:
                    with open(entry.path, "rb") as handle:
                        data = handle.read(max_resource_size + 1)
                except OSError as exc:
                    err("UNREADABLE", rel, "illeggibile: %s" % exc.strerror)
                    continue
                issues, uid = check_item(data)
                for code, message in issues:
                    err(code, rel, message)
                if uid is not None:
                    first = uids.get(uid)
                    if first is not None:
                        err("DUPLICATE_UID", rel, "stesso UID di %s nella collezione (Radicale lo rifiuterebbe)" % first)
                    else:
                        uids[uid] = entry.name
    report["ok"] = not errors
    report["summary"] = {"errors": len(errors), "warnings": len(warnings), "collections": checked["collections"], "items": checked["items"]}
    return report


def human_verify(rep: Dict[str, Any]) -> List[str]:
    lines = ["verifica di %s: %d collezioni, %d item, %d errori, %d avvisi" % (
        rep["volume_root"], rep["checked"]["collections"], rep["checked"]["items"], len(rep["errors"]), len(rep["warnings"]))]
    for e in rep["errors"][:50]:
        lines.append("  ERRORE %s %s: %s" % (e["code"], e["path"], e["message"]))
    if len(rep["errors"]) > 50:
        lines.append("  … altri %d errori nel report JSON" % (len(rep["errors"]) - 50))
    for w in rep["warnings"][:50]:
        lines.append("  avviso %s %s: %s" % (w["code"], w["path"], w["message"]))
    if len(rep["warnings"]) > 50:
        lines.append("  … altri %d avvisi nel report JSON" % (len(rep["warnings"]) - 50))
    return lines


# ─── Identità ─────────────────────────────────────────────────


def identity_report(root: str, state_raw: Any, principal: str) -> Tuple[Dict[str, Any], bool]:
    marker = cs.marker_dir(root, cs._check_principal(principal))
    state = cs.normalize_state(state_raw)
    status, detail = cs.identity_status(state, marker)
    usable = status == "ok" or (status == "uninitialized" and marker["state"] == "missing")
    if status == "uninitialized" and marker["state"] == "ok":
        detail = ("database non inizializzato (epoch 0) ma il volume ha già un marker (volume %s, epoch %s): "
                  "l'inizializzazione del wizard lo rifiuterebbe e i device resterebbero negati "
                  "(riallineamento: apps/radicale/README.md)" % (marker["volume_id"], marker["epoch"]))
    elif status == "uninitialized" and marker["state"] != "missing":
        detail = "database non inizializzato e marker sul volume %s (%s)" % (marker["state"], marker.get("detail"))
    doc = {
        "status": status,
        "usable": usable,
        "detail": detail,
        "marker": marker,
        "state": None if state is None else {"mode": state["mode"], "volume_id": state["volume_id"], "epoch": state["epoch"]},
    }
    return doc, usable


# ─── Cache di Radicale ────────────────────────────────────────


def ensure_lock(root: str) -> Dict[str, Any]:
    base, _ = _volume_paths(root)
    if not os.path.isdir(base) or os.path.islink(base):
        raise ToolError("manca collections/ in %s" % root)
    path = os.path.join(base, LOCK_NAME)
    st = os.stat(base)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o644)
    except FileExistsError:
        lst = os.lstat(path)
        if not stat.S_ISREG(lst.st_mode):
            raise ToolError("%s esiste ma non è un file regolare" % path)
        return {"path": path, "created": False}
    try:
        if os.geteuid() == 0:
            os.fchown(fd, st.st_uid, st.st_gid)
        os.fchmod(fd, 0o644)
    finally:
        os.close(fd)
    return {"path": path, "created": True}


def purge_cache(root: str, dry_run: bool) -> Dict[str, Any]:
    base, _ = _volume_paths(root)
    if not os.path.isdir(base) or os.path.islink(base):
        raise ToolError("manca collections/ in %s" % root)
    removed: List[Dict[str, Any]] = []
    skipped: List[Dict[str, str]] = []
    failed: List[Dict[str, str]] = []
    total = files = 0
    for dirpath, dirnames, _ in os.walk(base, followlinks=False):
        if CACHE_DIR not in dirnames:
            continue
        dirnames.remove(CACHE_DIR)
        path = os.path.join(dirpath, CACHE_DIR)
        rel = os.path.relpath(path, root)
        try:
            st = os.lstat(path)
        except FileNotFoundError:
            continue
        if not stat.S_ISDIR(st.st_mode):
            # Un link simbolico chiamato .Radicale.cache non si segue né si tocca.
            skipped.append({"path": rel, "reason": "non è una cartella (link simbolico?)"})
            continue
        size, count = tree_size(path)
        if not dry_run:
            try:
                shutil.rmtree(path)
            except OSError as exc:
                failed.append({"path": rel, "error": exc.strerror or str(exc)})
                continue
        removed.append({"path": rel, "bytes": size, "files": count})
        total += size
        files += count
    return {"volume_root": os.path.abspath(root), "dry_run": dry_run, "removed": removed, "skipped": skipped,
            "failed": failed, "bytes": total, "files": files}


def compact_cache(root: str, dry_run: bool) -> Dict[str, Any]:
    base, _ = _volume_paths(root)
    if not os.path.isdir(base) or os.path.islink(base):
        raise ToolError("manca collections/ in %s" % root)
    collections: List[Dict[str, Any]] = []
    total = removed_total = 0
    failed: List[Dict[str, str]] = []
    for dirpath, dirnames, _ in os.walk(base, followlinks=False):
        if CACHE_DIR not in dirnames:
            continue
        dirnames.remove(CACHE_DIR)
        item_dir = os.path.join(dirpath, CACHE_DIR, "item")
        try:
            if not stat.S_ISDIR(os.lstat(os.path.join(dirpath, CACHE_DIR)).st_mode) or not stat.S_ISDIR(os.lstat(item_dir).st_mode):
                continue
        except FileNotFoundError:
            continue
        orphans = 0
        freed = 0
        with os.scandir(item_dir) as entries:
            for entry in entries:
                # Stessa regola di Radicale (_clean_item_cache): voci con un nome
                # sicuro il cui item non è più un file della collezione.
                if not safe_component(entry.name) or not entry.is_file(follow_symlinks=False):
                    continue
                if os.path.isfile(os.path.join(dirpath, entry.name)):
                    continue
                size = entry.stat(follow_symlinks=False).st_size
                if not dry_run:
                    try:
                        os.remove(entry.path)
                    except FileNotFoundError:
                        continue
                    except OSError as exc:
                        failed.append({"path": os.path.relpath(entry.path, root), "error": exc.strerror or str(exc)})
                        continue
                orphans += 1
                freed += size
        if orphans:
            collections.append({"path": os.path.relpath(dirpath, root), "removed": orphans, "bytes": freed})
            removed_total += orphans
            total += freed
    return {"volume_root": os.path.abspath(root), "dry_run": dry_run, "collections": collections,
            "removed": removed_total, "bytes": total, "failed": failed}


# ─── Fase 0: nomi degli item come readTarIcsEntries() ─────────


class ExportNamer:
    """
    Nome `<collezione>__<item>.ics` di ogni item, con le regole di
    readTarIcsEntries() di apps/api/src/lib/calendar/migration/init.ts, nello
    stesso ordine dei membri del tar (tar --sort=name): segmenti vuoti e '.'
    ignorati; un segmento nascosto o '..', o un nome senza .ics → escluso; meno
    di due segmenti → scartato; oltre 10 MiB → scartato; nome già usato → si
    antepone il segmento precedente (il principal), poi scartato.
    """

    def __init__(self) -> None:
        self.used: Set[str] = set()
        self.skipped: List[Dict[str, str]] = []

    def name_for(self, path: str, size: int) -> Optional[str]:
        segments = [s for s in path.split("/") if s and s != "."]
        base = segments[-1] if segments else ""
        if any(s.startswith(".") or s == ".." for s in segments) or not base.lower().endswith(".ics"):
            return None
        if len(segments) < 2:
            self.skipped.append({"path": path, "reason": "fuori dal layout delle collezioni"})
            return None
        if size > ARCHIVE_MAX_ENTRY_BYTES:
            self.skipped.append({"path": path, "reason": "troppo grande"})
            return None
        name = "%s__%s" % (segments[-2], base)
        if name in self.used and len(segments) >= 3:
            name = "%s__%s" % (segments[-3], name)
        if name in self.used:
            self.skipped.append({"path": path, "reason": "nome già presente nell'archivio"})
            return None
        self.used.add(name)
        return name


def walk_sorted(root: str) -> Iterator[Tuple[str, os.stat_result]]:
    """(percorso relativo, lstat) dei file regolari sotto root, nell'ordine di tar --sort=name."""
    def walk(rel: str) -> Iterator[Tuple[str, os.stat_result]]:
        full = os.path.join(root, rel) if rel else root
        with os.scandir(full) as entries:
            names = sorted(entries, key=lambda e: e.name.encode("utf-8", "surrogateescape"))
        for entry in names:
            child = "%s/%s" % (rel, entry.name) if rel else entry.name
            st = entry.stat(follow_symlinks=False)
            if stat.S_ISDIR(st.st_mode):
                yield from walk(child)
            elif stat.S_ISREG(st.st_mode):
                yield child, st
    yield from walk("")


def iter_dir_items(root: str, namer: ExportNamer) -> Iterator[Tuple[str, str, Callable[[], bytes], int]]:
    """(nome nello zip, percorso sorgente, lettore, byte) degli item di una cartella."""
    for rel, st in walk_sorted(root):
        name = namer.name_for(rel, st.st_size)
        if name is None:
            continue
        full = os.path.join(root, rel)
        yield name, rel, (lambda p=full: _read_file(p)), st.st_size


def _read_file(path: str) -> bytes:
    with open(path, "rb") as handle:
        return handle.read(ARCHIVE_MAX_ENTRY_BYTES + 1)


def iter_tar_items(path: str, namer: ExportNamer) -> Iterator[Tuple[str, str, Callable[[], bytes], int]]:
    """Come iter_dir_items, dai membri di un tar o tar.gz (phase0-backup)."""
    try:
        tar = tarfile.open(path, "r:*")
    except (tarfile.TarError, OSError) as exc:
        raise ToolError("archivio illeggibile (%s): %s" % (path, exc))
    with tar:
        for member in tar:
            if not member.isreg():
                continue
            name = namer.name_for(member.name, member.size)
            if name is None:
                continue

            def reader(m: tarfile.TarInfo = member) -> bytes:
                # Letto subito dal chiamante, prima del membro successivo: il tar.gz si legge in sequenza.
                handle = tar.extractfile(m)
                if handle is None:
                    raise ToolError("membro illeggibile: %r" % m.name)
                return handle.read(ARCHIVE_MAX_ENTRY_BYTES + 1)

            yield name, member.name, reader, member.size


def phase0_scan(root: str) -> Dict[str, Any]:
    if not os.path.isdir(root):
        raise ToolError("cartella assente: %s" % root)
    namer = ExportNamer()
    files = total = 0
    ics: Dict[str, int] = {}
    exportable = 0
    exportable_bytes = 0
    for rel, st in walk_sorted(root):
        files += 1
        total += st.st_size
        name = namer.name_for(rel, st.st_size)
        if name is None:
            continue
        exportable += 1
        exportable_bytes += st.st_size
        parent = rel.rsplit("/", 1)[0] if "/" in rel else "."
        ics[parent] = ics.get(parent, 0) + 1
    croot = os.path.join(root, cs.COLLECTION_ROOT)
    principals: List[str] = []
    if os.path.isdir(croot):
        with os.scandir(croot) as entries:
            principals = sorted(e.name for e in entries if e.is_dir(follow_symlinks=False))
    return {
        "present": True,
        "root": os.path.abspath(root),
        "radicale_layout": os.path.isdir(croot),
        "principals": principals,
        "files": files,
        "bytes": total,
        "items": exportable,
        "items_bytes": exportable_bytes,
        "collections": [{"path": k, "items": v} for k, v in sorted(ics.items())],
        "skipped": namer.skipped,
    }


def phase0_manifest(archive: str, name: str, source: str, out: str) -> Dict[str, Any]:
    namer = ExportNamer()
    members = items = 0
    try:
        with tarfile.open(archive, "r:*") as tar:
            for member in tar:
                members += 1
                if member.isreg() and namer.name_for(member.name, member.size) is not None:
                    items += 1
    except (tarfile.TarError, OSError, EOFError) as exc:
        raise ToolError("archivio illeggibile (%s): %s" % (archive, exc))
    doc = {
        "schema": 1,
        "kind": BACKUP_KIND,
        "created_at": now_iso(),
        "source": source,
        "archive": {"file": name, "bytes": os.path.getsize(archive), "sha256": cs.sha256_file(archive),
                    "format": "tar gzip in sola lettura, radice = volume della Fase 0, proprietari numerici"},
        "members": members,
        "items": items,
        "skipped": namer.skipped,
        "note": "Decisione 7: il volume della Fase 0 non va cancellato né montato in Radicale. Gli item si importano dal wizard "
                "(passo 1) nella collezione archivio-fase0, caricando questo tar.gz oppure lo zip di phase0-export.",
    }
    write_json_atomic(out, doc)
    return doc


def phase0_export(out: str, items: Iterator[Tuple[str, str, Callable[[], bytes], int]], namer: ExportNamer,
                  source: Dict[str, Any], max_bytes: int, max_items: int) -> Dict[str, Any]:
    directory = os.path.dirname(os.path.abspath(out))
    if not os.path.isdir(directory):
        raise ToolError("cartella di destinazione assente: %s" % directory)
    fd, tmp = tempfile.mkstemp(prefix=".%s." % os.path.basename(out), suffix=".partial", dir=directory)
    os.close(fd)
    entries: List[Dict[str, Any]] = []
    total = 0
    try:
        with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=False) as zf:
            for name, source_path, reader, _size in items:
                if len(entries) >= max_items:
                    raise ToolError("oltre %d item: il wizard non accetterebbe l'archivio" % max_items)
                data = reader()
                if len(data) > ARCHIVE_MAX_ENTRY_BYTES:
                    namer.skipped.append({"path": source_path, "reason": "troppo grande"})
                    continue
                info = zipfile.ZipInfo(name, date_time=ZIP_DATE)
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = (stat.S_IFREG | 0o600) << 16
                zf.writestr(info, data)
                total += len(data)
                entries.append({"name": name, "source_path": source_path, "bytes": len(data),
                                "sha256": hashlib.sha256(data).hexdigest()})
            manifest = {
                "schema": 1,
                "kind": EXPORT_KIND,
                "created_at": now_iso(),
                "source": source,
                "items": len(entries),
                "bytes": total,
                "naming": "<collezione>__<item>.ics, come readTarIcsEntries() dell'API per il tar di phase0-backup",
                "limits": {"max_bytes": max_bytes, "max_items": max_items, "max_entry_bytes": ARCHIVE_MAX_ENTRY_BYTES},
                "entries": entries,
                "skipped": namer.skipped,
            }
            info = zipfile.ZipInfo("manifest.json", date_time=ZIP_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (stat.S_IFREG | 0o600) << 16
            zf.writestr(info, json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
        size = os.path.getsize(tmp)
        if size > max_bytes:
            raise ToolError("zip di %d byte, oltre il limite del wizard (%d): l'archivio va ridotto o importato in più parti" % (size, max_bytes))
        with zipfile.ZipFile(tmp) as zf:
            bad = zf.testzip()
            if bad is not None:
                raise ToolError("zip non integro alla rilettura: %s" % bad)
        os.chmod(tmp, 0o600)
        os.replace(tmp, out)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return {
        "zip": os.path.abspath(out),
        "bytes": os.path.getsize(out),
        "sha256": cs.sha256_file(out),
        "items": len(entries),
        "items_bytes": total,
        "skipped": namer.skipped,
        "source": source,
    }


# ─── Main ─────────────────────────────────────────────────────


def main(argv: List[str]) -> int:
    parser = argparse.ArgumentParser(prog="radicale_maint.py", description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("limits")
    p = sub.add_parser("ensure-lock")
    p.add_argument("root")
    for name in ("scan", "du"):
        p = sub.add_parser(name)
        p.add_argument("root")
        p.add_argument("--principal", default=os.environ.get("RADICALE_PRINCIPAL") or "federico")
        p.add_argument("--fs-type")
        p.add_argument("--human", action="store_true")
    p = sub.add_parser("verify")
    p.add_argument("root")
    p.add_argument("--principal", default=os.environ.get("RADICALE_PRINCIPAL") or "federico")
    p.add_argument("--max-resource-size", type=int, default=MAX_RESOURCE_SIZE)
    p.add_argument("--tmp-age-hours", type=float, default=1.0)
    p.add_argument("--human", action="store_true")
    p = sub.add_parser("identity")
    p.add_argument("root")
    p.add_argument("--state", required=True)
    p.add_argument("--principal", default=os.environ.get("RADICALE_PRINCIPAL") or "federico")
    p.add_argument("--human", action="store_true")
    for name in ("purge-cache", "compact-cache"):
        p = sub.add_parser(name)
        p.add_argument("root")
        p.add_argument("--dry-run", action="store_true")
    p = sub.add_parser("phase0-scan")
    p.add_argument("root")
    p.add_argument("--source", default=None)
    p.add_argument("--mounted-by", default="")
    p.add_argument("--human", action="store_true")
    p = sub.add_parser("phase0-manifest")
    p.add_argument("--archive", required=True)
    p.add_argument("--name", required=True)
    p.add_argument("--source", required=True)
    p.add_argument("--out", required=True)
    p = sub.add_parser("phase0-export")
    p.add_argument("--out", required=True)
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--dir")
    src.add_argument("--tar")
    p.add_argument("--source", default=None)
    p.add_argument("--max-bytes", type=int, default=ARCHIVE_MAX_BYTES)
    p.add_argument("--max-items", type=int, default=ARCHIVE_MAX_ITEMS)
    args = parser.parse_args(argv)

    try:
        if args.cmd == "limits":
            _print({"archive_max_bytes": ARCHIVE_MAX_BYTES, "archive_max_items": ARCHIVE_MAX_ITEMS,
                    "archive_max_entry_bytes": ARCHIVE_MAX_ENTRY_BYTES, "max_resource_size": MAX_RESOURCE_SIZE,
                    "large_collection_items": LARGE_COLLECTION_ITEMS})
        elif args.cmd == "ensure-lock":
            _print(ensure_lock(args.root))
        elif args.cmd in ("scan", "du"):
            doc = scan_volume(args.root, args.principal)
            if args.fs_type:
                doc["fs_type"] = args.fs_type
            if args.cmd == "scan":
                if args.human:
                    _human(human_scan(doc, title="volume di Radicale"))
                _print(doc)
            else:
                rep = du_report(doc)
                if args.human:
                    _human(human_du(rep))
                _print(rep)
        elif args.cmd == "verify":
            rep = verify_volume(args.root, args.principal, max_resource_size=args.max_resource_size,
                                tmp_age_s=max(0.0, args.tmp_age_hours) * 3600.0)
            if args.human:
                _human(human_verify(rep))
            _print(rep)
            return 0 if rep["ok"] else 1
        elif args.cmd == "identity":
            doc, usable = identity_report(args.root, json.loads(args.state), args.principal)
            if args.human:
                _human(["identità del volume: %s — %s" % (doc["status"], doc["detail"])])
            _print(doc)
            return 0 if usable else 1
        elif args.cmd == "purge-cache":
            rep = purge_cache(args.root, args.dry_run)
            _print(rep)
            return 1 if rep["failed"] else 0
        elif args.cmd == "compact-cache":
            rep = compact_cache(args.root, args.dry_run)
            _print(rep)
            return 1 if rep["failed"] else 0
        elif args.cmd == "phase0-scan":
            doc = phase0_scan(args.root)
            doc["source"] = args.source
            doc["mounted_by"] = [n for n in args.mounted_by.split(",") if n]
            if args.human:
                _human([
                    "volume della Fase 0 trovato: %s (%s)" % (args.source or doc["root"], doc["root"]),
                    "  file: %d (%s), item .ics esportabili: %d, layout di Radicale: %s, principal: %s" % (
                        doc["files"], fmt_bytes(doc["bytes"]), doc["items"], "sì" if doc["radicale_layout"] else "no",
                        ", ".join(doc["principals"]) or "-"),
                ] + ["  %s: %d item" % (c["path"], c["items"]) for c in doc["collections"][:30]])
            _print(doc)
        elif args.cmd == "phase0-manifest":
            _print(phase0_manifest(args.archive, args.name, args.source, args.out))
        elif args.cmd == "phase0-export":
            namer = ExportNamer()
            if args.dir:
                if not os.path.isdir(args.dir):
                    raise ToolError("cartella assente: %s" % args.dir)
                items = iter_dir_items(args.dir, namer)
                source: Dict[str, Any] = {"kind": "volume", "name": args.source or os.path.abspath(args.dir)}
            else:
                if not os.path.isfile(args.tar):
                    raise ToolError("archivio assente: %s" % args.tar)
                items = iter_tar_items(args.tar, namer)
                source = {"kind": "tar", "name": args.source or os.path.basename(args.tar), "sha256": cs.sha256_file(args.tar)}
            _print(phase0_export(args.out, items, namer, source, args.max_bytes, args.max_items))
    except ToolError as exc:
        print("radicale_maint: %s" % exc, file=sys.stderr)
        return 1
    except cs.ToolError as exc:
        print("radicale_maint: %s" % exc, file=sys.stderr)
        return 1
    except ValueError as exc:
        print("radicale_maint: JSON non valido: %s" % exc, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
