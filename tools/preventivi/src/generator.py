"""Core PDF generation logic using Jinja2 + WeasyPrint."""

from __future__ import annotations

import locale
from datetime import datetime, timedelta
from pathlib import Path

from jinja2 import Environment, FileSystemLoader
from weasyprint import HTML

from .config import (
    ASSETS_DIR,
    BRAND,
    CONTRATTO,
    FORNITORE,
    REGIME_FISCALE,
    TEMPLATES_DIR,
)
from .models import Preventivo


def _format_currency(amount: float, currency: str = "EUR") -> str:
    """Format amount as Italian currency string."""
    if currency == "EUR":
        return f"€ {amount:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
    return f"{amount:,.2f} {currency}"


def _format_date(date_str: str) -> str:
    """Format ISO date to Italian format."""
    try:
        dt = datetime.strptime(date_str, "%Y-%m-%d")
        mesi = [
            "", "gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno",
            "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre",
        ]
        return f"{dt.day} {mesi[dt.month]} {dt.year}"
    except (ValueError, IndexError):
        return date_str


def _scadenza(data: str, giorni: int) -> str:
    """Calculate expiry date from issue date + days."""
    try:
        dt = datetime.strptime(data, "%Y-%m-%d") + timedelta(days=giorni)
        return _format_date(dt.strftime("%Y-%m-%d"))
    except ValueError:
        return ""


def _calcola_bollo(totale: float) -> float:
    """Return stamp duty if applicable."""
    if totale > REGIME_FISCALE["soglia_bollo"]:
        return REGIME_FISCALE["importo_bollo"]
    return 0.0


def build_context(data: Preventivo) -> dict:
    """Build the full Jinja2 template context from validated data."""
    totale_offerte = sum(o.prezzo for o in data.offerte)
    bollo = _calcola_bollo(totale_offerte)

    # Calculate discounted totals for payment options
    modalita_calcolate = []
    for m in data.pagamento.modalita:
        sconto = m.sconto_percentuale / 100 * totale_offerte if m.sconto_percentuale else 0
        totale_scontato = totale_offerte - sconto + bollo
        rate_calcolate = []
        for r in m.rate:
            importo_rata = (totale_offerte + bollo) * r.percentuale / 100
            rate_calcolate.append({
                "percentuale": r.percentuale,
                "momento": r.momento,
                "importo": importo_rata,
                "importo_fmt": _format_currency(importo_rata),
            })
        modalita_calcolate.append({
            **m.model_dump(),
            "sconto_fmt": _format_currency(sconto) if sconto else None,
            "totale_scontato": totale_scontato,
            "totale_scontato_fmt": _format_currency(totale_scontato),
            "rate_calcolate": rate_calcolate,
        })

    # Determine logo path as file URI for WeasyPrint
    logo_path = Path(BRAND["logo_path"])
    logo_uri = logo_path.as_uri() if logo_path.exists() else ""

    return {
        "preventivo": data.model_dump(),
        "fornitore": FORNITORE,
        "brand": BRAND,
        "regime": REGIME_FISCALE,
        "contratto_config": CONTRATTO,
        "logo_uri": logo_uri,
        "data_formattata": _format_date(data.meta.data),
        "scadenza_formattata": _scadenza(data.meta.data, data.meta.validita_giorni),
        "totale_offerte": totale_offerte,
        "totale_offerte_fmt": _format_currency(totale_offerte),
        "bollo": bollo,
        "bollo_fmt": _format_currency(bollo),
        "totale_con_bollo": totale_offerte + bollo,
        "totale_con_bollo_fmt": _format_currency(totale_offerte + bollo),
        "modalita_calcolate": modalita_calcolate,
        "is_azienda": data.meta.tipo_cliente == "azienda",
        "has_premessa": bool(data.premessa.testo),
        "has_statistiche": len(data.premessa.statistiche) > 0,
        "has_problemi_critici": len(data.premessa.problemi_critici) > 0,
        "has_sezioni_extra": len(data.sezioni_extra) > 0,
        "has_problemi_risolti": len(data.problemi_risolti) > 0,
        "has_clausole": len(data.clausole_speciali) > 0,
        "has_materiali": len(data.materiali_necessari) > 0,
        "has_tempistiche": bool(data.tempistiche.prima_bozza),
        "has_contratto": bool(data.contratto_perimetro.servizi),
        "format_currency": _format_currency,
        "format_date": _format_date,
        "anno": datetime.strptime(data.meta.data, "%Y-%m-%d").year
            if data.meta.data else datetime.now().year,
    }


def render_html(data: Preventivo) -> str:
    """Render the quote as HTML string."""
    env = Environment(
        loader=FileSystemLoader(str(TEMPLATES_DIR)),
        autoescape=True,
    )
    template = env.get_template("preventivo.html")
    context = build_context(data)
    return template.render(**context)


def generate_pdf(data: Preventivo, output_path: str | Path) -> Path:
    """Generate PDF from validated quote data."""
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    html_content = render_html(data)
    HTML(
        string=html_content,
        base_url=str(TEMPLATES_DIR),
    ).write_pdf(str(output_path))

    return output_path


def generate_pdf_bytes(data: Preventivo) -> bytes:
    """Generate PDF and return as bytes (for API use)."""
    html_content = render_html(data)
    return HTML(
        string=html_content,
        base_url=str(TEMPLATES_DIR),
    ).write_pdf()
