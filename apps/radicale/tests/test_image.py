"""
Immagine Radicale (fase F1, piano attività 1; design §3.1-§3.2, §15
"healthcheck: 207 sulla root"): healthcheck, self-test di build, Dockerfile e
config.

Docker non serve: l'healthcheck e il self-test girano qui con lo stesso
Radicale 3.7.8 dell'immagine; del Dockerfile si verificano i punti che il
design rende vincolanti (base pinnata per digest, PYTHONPATH, self-test in
build, healthcheck).
"""

from __future__ import annotations

import configparser
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Dict, Optional

import pytest

import caldes_harness as h

HEALTHCHECK = h.PLUGINS_DIR / "caldes_healthcheck.py"
SELFTEST = h.PLUGINS_DIR / "caldes_selftest.py"
DOCKERFILE = h.RADICALE_APP_DIR / "Dockerfile"
BASE_DIGEST = "sha256:29a9098ef9851605ca37ef3a3d5e885594c7fe91731fb6edb3194a56cfc6c54e"


def _clean_env(**extra: str) -> Dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith(("PYTHON", "CALDES_", "RADICALE_"))}
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env.update(extra)
    return env


def _healthcheck(url: Optional[str], password: Optional[str]) -> subprocess.CompletedProcess:
    extra = {}
    if url is not None:
        extra["CALDES_HEALTHCHECK_URL"] = url
    if password is not None:
        extra["CALDES_PROBE_PASSWORD"] = password
    # Come nel Dockerfile: interprete isolato.
    return subprocess.run([sys.executable, "-I", str(HEALTHCHECK)], env=_clean_env(**extra), capture_output=True,
                          text=True, timeout=30)


# ─── Healthcheck ──────────────────────────────────────────────


@pytest.fixture
def process(tmp_path: Path) -> h.RadicaleProcess:
    rad = h.RadicaleProcess(tmp_path)
    yield rad
    rad.stop()


def test_healthcheck_sano_su_volume_vuoto_senza_policy(process: h.RadicaleProcess) -> None:
    result = _healthcheck(process.url, h.PASSWORDS[h.PROBE_USER])
    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout.startswith("healthy")
    assert not process.principal_dir().exists()


def test_healthcheck_sano_con_volume_inizializzato(process: h.RadicaleProcess) -> None:
    process.initialize(collections=("c",))
    process.control.set_mode("live", heartbeat_offset_s=-3600)
    result = _healthcheck(process.url, h.PASSWORDS[h.PROBE_USER])
    assert result.returncode == 0, "la root non dipende da policy, heartbeat e identità"


def test_healthcheck_password_sbagliata(process: h.RadicaleProcess) -> None:
    result = _healthcheck(process.url, "sbagliata")
    assert result.returncode == 1
    assert "401" in result.stdout
    assert "sbagliata" not in result.stdout + result.stderr


def test_healthcheck_senza_password(process: h.RadicaleProcess) -> None:
    result = _healthcheck(process.url, None)
    assert result.returncode == 1
    assert "CALDES_PROBE_PASSWORD" in result.stdout


def test_healthcheck_risposta_diversa_da_207(process: h.RadicaleProcess) -> None:
    result = _healthcheck(process.url + "federico/", h.PASSWORDS[h.PROBE_USER])
    assert result.returncode == 1
    assert "403" in result.stdout


def test_healthcheck_server_giu(tmp_path: Path) -> None:
    rad = h.RadicaleProcess(tmp_path)
    url = rad.url
    rad.stop()
    result = _healthcheck(url, h.PASSWORDS[h.PROBE_USER])
    assert result.returncode == 1
    assert "richiesta non riuscita" in result.stdout


def test_healthcheck_default_su_127_0_0_1_porta_5232() -> None:
    source = HEALTHCHECK.read_text(encoding="utf-8")
    assert 'DEFAULT_URL = "http://127.0.0.1:5232/"' in source
    assert 'PROBE_USER = "caldes-probe"' in source


# ─── Self-test di build ───────────────────────────────────────


def _selftest(config: Path, *, plugins_on_path: bool = True) -> subprocess.CompletedProcess:
    env = _clean_env(**({"PYTHONPATH": str(h.PLUGINS_DIR)} if plugins_on_path else {}))
    args = [sys.executable] + ([] if plugins_on_path else ["-I"]) + [str(SELFTEST), str(config)]
    return subprocess.run(args, env=env, capture_output=True, text=True, timeout=120)


def test_selftest_passa_con_config_e_plugin_del_repository() -> None:
    result = _selftest(h.CONFIG_FILE)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "caldes_selftest: tutto verificato" in result.stdout
    for name in ("versioni", "patch vobject", "config", "plugin", "percorso reale"):
        assert "caldes_selftest: ok %s:" % name in result.stdout


def test_selftest_fallisce_senza_sitecustomize() -> None:
    result = _selftest(h.CONFIG_FILE, plugins_on_path=False)
    assert result.returncode == 1
    assert "FALLITO patch vobject" in result.stdout


@pytest.mark.parametrize(
    ("section", "option", "value"),
    [
        ("rights", "permit_delete_collection", "True"),
        ("server", "max_vevent_rrule_occurrence", "10000"),
        ("server", "delay_on_error", "1"),
        ("rights", "type", "caldes_rights_vecchio"),
        ("storage", "predefined_collections", '{"c": {"tag": "VCALENDAR"}}'),
    ],
)
def test_selftest_fallisce_con_config_alterata(tmp_path: Path, section: str, option: str, value: str) -> None:
    parser = h.production_config_parser()
    parser.set(section, option, value)
    altered = tmp_path / "config"
    with open(altered, "w", encoding="utf-8") as handle:
        parser.write(handle)
    result = _selftest(altered)
    assert result.returncode == 1
    assert "FALLITO config: config: [%s] %s" % (section, option) in result.stdout


# ─── Dockerfile e config ──────────────────────────────────────


def test_dockerfile_base_pinnata_per_digest() -> None:
    text = DOCKERFILE.read_text(encoding="utf-8")
    froms = re.findall(r"^FROM\s+(\S+)", text, flags=re.MULTILINE)
    assert froms == ["tomsquest/docker-radicale:3.7.8.0@" + BASE_DIGEST]
    design = (h.REPO_ROOT / "docs" / "calendar-radicale" / "design.md").read_text(encoding="utf-8")
    assert "tomsquest/docker-radicale:3.7.8.0@" + BASE_DIGEST in design


def test_dockerfile_plugin_selftest_e_healthcheck() -> None:
    text = DOCKERFILE.read_text(encoding="utf-8")
    assert re.search(r"^ENV PYTHONPATH=/app/plugins\b", text, flags=re.MULTILINE)
    assert "COPY plugins/ /app/plugins/" in text
    assert "COPY config/config /config/config" in text
    assert "RUN /venv/bin/python /app/plugins/caldes_selftest.py /config/config" in text
    assert re.search(r'^HEALTHCHECK .*\n\s+CMD \["/venv/bin/python", "-I", "/app/plugins/caldes_healthcheck.py"\]',
                     text, flags=re.MULTILINE)
    assert "TAKE_FILE_OWNERSHIP=false" in text
    assert "RADICALE_CONFIG_" not in re.sub(r"^#.*$", "", text, flags=re.MULTILINE)
    assert "chmod 0700 /var/lib/caldes-auth" in text
    dockerignore = (h.RADICALE_APP_DIR / ".dockerignore").read_text(encoding="utf-8").split()
    assert "tests/" in dockerignore


def test_plugin_previsti_e_storage_proxy_eliminato() -> None:
    names = {p.name for p in h.PLUGINS_DIR.glob("*.py")}
    assert {"caldes_auth.py", "caldes_rights.py", "caldes_vobject_fix.py", "sitecustomize.py",
            "caldes_healthcheck.py", "caldes_selftest.py"} <= names
    assert "caldes_storage.py" not in names


def test_config_senza_commenti_in_fondo_alla_riga() -> None:
    # RawConfigParser di Radicale non toglie i commenti inline: finirebbero nel valore.
    parser = configparser.RawConfigParser()
    parser.read(h.CONFIG_FILE, encoding="utf-8")
    for section in parser.sections():
        for option, value in parser.items(section):
            assert "#" not in value and " ;" not in value, "[%s] %s = %r" % (section, option, value)


def test_config_valori_del_design() -> None:
    configuration = h.radicale_config.load([(str(h.CONFIG_FILE), False)])
    expected = {
        ("server", "hosts"): [("0.0.0.0", 5232)],
        ("server", "max_connections"): 16,
        ("server", "max_content_length"): 20_000_000,
        ("server", "timeout"): 30.0,
        ("server", "delay_on_error"): 0.0,
        ("server", "max_vevent_rrule_occurrence"): 50_000,
        ("auth", "type"): "caldes_auth",
        ("auth", "delay"): 1.0,
        ("rights", "type"): "caldes_rights",
        ("rights", "caldes_policy_file"): "/control/policy.json",
        ("rights", "caldes_heartbeat_file"): "/control/heartbeat.json",
        ("rights", "permit_delete_collection"): False,
        ("rights", "permit_overwrite_collection"): False,
        ("storage", "type"): "multifilesystem",
        ("storage", "filesystem_folder"): "/data/collections",
        ("storage", "use_mtime_and_size_for_item_cache"): True,
        ("storage", "max_sync_token_age"): 5_184_000,
        ("storage", "skip_broken_item"): True,
        ("storage", "strict_preconditions"): False,
        ("storage", "predefined_collections"): {},
        ("hook", "type"): "none",
        ("sharing", "type"): "none",
        ("web", "type"): "none",
        ("logging", "level"): "info",
        ("logging", "mask_passwords"): True,
    }
    for (section, option), value in expected.items():
        assert configuration.get(section, option) == value, (section, option)
