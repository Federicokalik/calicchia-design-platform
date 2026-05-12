"""Pydantic models per validazione input preventivo."""

from __future__ import annotations

from pydantic import BaseModel, Field


class Meta(BaseModel):
    numero_preventivo: str
    data: str
    validita_giorni: int = 30
    tipo_cliente: str = "azienda"  # azienda | privato


class Cliente(BaseModel):
    ragione_sociale: str = ""
    nome_display: str = ""
    sottotitolo: str = ""
    sede_legale: str = ""
    piva: str = ""
    codice_fiscale: str = ""
    codice_univoco_pec: str = ""
    legale_rappresentante: str = ""
    telefono: str = ""
    email: str = ""
    sito_web: str = ""


class Documento(BaseModel):
    titolo: str = "Preventivo"
    sottotitolo: str = "Preventivo e Contratto di Incarico"


class Statistica(BaseModel):
    valore: str
    label: str


class Premessa(BaseModel):
    testo: str = ""
    statistiche: list[Statistica] = []
    problemi_critici: list[str] = []


class RigaComparativa(BaseModel):
    caratteristica: str
    colonna_a: str
    colonna_b: str
    a_positivo: bool = True


class SezioneExtra(BaseModel):
    tipo: str = "comparativa"
    titolo: str = ""
    intro: str = ""
    intestazione_a: str = "Astro.build"
    intestazione_b: str = "Attuale"
    righe: list[RigaComparativa] = []


class Offerta(BaseModel):
    id: str
    nome: str
    descrizione: str = ""
    prezzo: float
    consigliata: bool = False
    include: list[str] = []
    esclude: list[str] = []
    note_extra: str | None = None


class ProblemaRisolto(BaseModel):
    numero: int
    problema: str
    soluzione: str


class ClausolaSpeciale(BaseModel):
    tipo: str = "warning"  # warning | info | success
    titolo: str
    testo: str = ""
    lista: list[str] = []


class Rata(BaseModel):
    percentuale: float
    momento: str


class ModalitaPagamento(BaseModel):
    id: str
    nome: str
    sconto_percentuale: float = 0
    descrizione: str = ""
    rate: list[Rata] = []


class Pagamento(BaseModel):
    modalita: list[ModalitaPagamento] = []


class Tempistiche(BaseModel):
    prima_bozza: str = ""
    nota: str = ""


class ContrattoPerimetro(BaseModel):
    servizi: list[str] = []
    clausole: list[str] = []


class Preventivo(BaseModel):
    """Root model per un preventivo completo."""

    meta: Meta
    cliente: Cliente
    documento: Documento = Documento()
    premessa: Premessa = Premessa()
    sezioni_extra: list[SezioneExtra] = []
    offerte: list[Offerta] = []
    problemi_risolti: list[ProblemaRisolto] = []
    clausole_speciali: list[ClausolaSpeciale] = []
    materiali_necessari: list[str] = []
    tempistiche: Tempistiche = Tempistiche()
    pagamento: Pagamento = Pagamento()
    contratto_perimetro: ContrattoPerimetro = ContrattoPerimetro()
