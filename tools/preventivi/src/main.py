"""CLI entrypoint per il generatore preventivi."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import typer

from .config import OUTPUT_DIR
from .generator import generate_pdf, generate_pdf_bytes, render_html
from .models import Preventivo

app = typer.Typer(
    name="preventivi",
    help="Generatore preventivi PDF — Calicchia Design",
)


@app.command()
def generate(
    input_file: Path = typer.Argument(..., help="File JSON del preventivo"),
    output: Path = typer.Option(None, "-o", "--output", help="Percorso file PDF di output"),
    preview: bool = typer.Option(False, "--preview", help="Genera solo HTML (per debug)"),
    open_file: bool = typer.Option(False, "--open", help="Apri il PDF dopo la generazione"),
) -> None:
    """Genera un PDF dal file JSON di input."""
    if not input_file.exists():
        typer.echo(f"Errore: file non trovato: {input_file}", err=True)
        raise typer.Exit(1)

    try:
        raw = json.loads(input_file.read_text(encoding="utf-8"))
        data = Preventivo.model_validate(raw)
    except Exception as e:
        typer.echo(f"Errore validazione JSON: {e}", err=True)
        raise typer.Exit(1)

    if preview:
        html = render_html(data)
        out = output or Path("preview.html")
        out.write_text(html, encoding="utf-8")
        typer.echo(f"Preview HTML generata: {out}")
        return

    if output is None:
        slug = data.meta.numero_preventivo.replace("/", "-")
        nome = data.cliente.nome_display or data.cliente.ragione_sociale or "preventivo"
        nome = nome.replace(" ", "_").replace("/", "-")
        output = OUTPUT_DIR / f"Preventivo_{slug}_{nome}.pdf"

    pdf_path = generate_pdf(data, output)
    typer.echo(f"PDF generato: {pdf_path}")

    if open_file:
        _open_file(pdf_path)


@app.command()
def validate(
    input_file: Path = typer.Argument(..., help="File JSON da validare"),
) -> None:
    """Valida un file JSON senza generare il PDF."""
    if not input_file.exists():
        typer.echo(f"Errore: file non trovato: {input_file}", err=True)
        raise typer.Exit(1)

    try:
        raw = json.loads(input_file.read_text(encoding="utf-8"))
        data = Preventivo.model_validate(raw)
        typer.echo(f"JSON valido: {data.meta.numero_preventivo}")
        typer.echo(f"  Cliente: {data.cliente.nome_display or data.cliente.ragione_sociale}")
        typer.echo(f"  Offerte: {len(data.offerte)}")
        total = sum(o.prezzo for o in data.offerte)
        typer.echo(f"  Totale: € {total:,.2f}")
    except Exception as e:
        typer.echo(f"Errore validazione: {e}", err=True)
        raise typer.Exit(1)


@app.command()
def templates() -> None:
    """Lista i template predefiniti disponibili."""
    tpl = [
        ("sito_nuovo", "Sito Web Nuovo (Astro/React/WordPress)"),
        ("rifacimento", "Rifacimento Sito (da audit)"),
        ("emergenza", "Intervento Emergenza"),
        ("seo_audit", "SEO / Audit"),
        ("grafica", "Grafica / Brochure"),
        ("hosting", "Hosting / Manutenzione"),
    ]
    typer.echo("Template disponibili:\n")
    for tid, desc in tpl:
        typer.echo(f"  {tid:20s} — {desc}")


@app.command()
def from_stdin(
    output: Path = typer.Option(None, "-o", "--output", help="Percorso file PDF"),
) -> None:
    """Genera PDF leggendo JSON da stdin (per integrazione API)."""
    raw_input = sys.stdin.read()
    try:
        raw = json.loads(raw_input)
        data = Preventivo.model_validate(raw)
    except Exception as e:
        typer.echo(f"Errore: {e}", err=True)
        raise typer.Exit(1)

    if output:
        pdf_path = generate_pdf(data, output)
        typer.echo(f"PDF generato: {pdf_path}")
    else:
        pdf_bytes = generate_pdf_bytes(data)
        sys.stdout.buffer.write(pdf_bytes)


def _open_file(path: Path) -> None:
    """Open file with system default viewer."""
    import platform

    system = platform.system()
    if system == "Darwin":
        subprocess.run(["open", str(path)], check=False)
    elif system == "Linux":
        subprocess.run(["xdg-open", str(path)], check=False)
    elif system == "Windows":
        subprocess.run(["start", str(path)], shell=True, check=False)


if __name__ == "__main__":
    app()
