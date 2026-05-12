export interface NoteTemplate {
  id: string;
  title: string;
  description: string;
  icon: string;
  content: string; // markdown
}

export const NOTE_TEMPLATES: NoteTemplate[] = [
  {
    id: 'meeting',
    title: 'Meeting Notes',
    description: 'Template per appunti riunione',
    icon: '📋',
    content: `## Riunione — [Data]

### Partecipanti
-

### Agenda
1.

### Decisioni
-

### Action Items
- [ ]
- [ ]

### Note
`,
  },
  {
    id: 'project-brief',
    title: 'Project Brief',
    description: 'Brief per nuovo progetto',
    icon: '📐',
    content: `## Project Brief — [Nome Progetto]

### Cliente


### Obiettivo
Descrivere l'obiettivo principale del progetto.

### Scope
-

### Timeline
- **Inizio**:
- **Consegna**:

### Budget


### Requisiti Tecnici
-

### Note
`,
  },
  {
    id: 'client-research',
    title: 'Client Research',
    description: 'Ricerca su cliente/prospect',
    icon: '🔍',
    content: `## Ricerca Cliente — [Nome]

### Azienda
- **Settore**:
- **Dimensione**:
- **Sito web**:

### Competitor
1.
2.

### Pain Points
-

### Opportunità
-

### Budget stimato


### Prossimi passi
- [ ]
`,
  },
  {
    id: 'weekly-review',
    title: 'Review Settimanale',
    description: 'Retrospettiva della settimana',
    icon: '📆',
    content: `## Review Settimana — [Data]

### Completato
-

### In Corso
-

### Bloccato
-

### Obiettivi Prossima Settimana
- [ ]
- [ ]
- [ ]

### Lezioni Apprese

`,
  },
  {
    id: 'idea',
    title: 'Idea / Brainstorm',
    description: 'Cattura un\'idea veloce',
    icon: '💡',
    content: `## Idea — [Titolo]

### Descrizione


### Perché è interessante


### Passi per realizzarla
1.
2.
3.

### Risorse necessarie
-
`,
  },
];
