# Palette di settore

*Strumento gratuito di [Federico Calicchia](https://calicchia.design), web designer freelance. Senza registrazione.*

> Scrivi che attività hai e, se ce l'hai, carica il logo. Lo strumento cerca foto del tuo settore, ne estrae i colori dominanti e li mostra su un sito, un post e un biglietto da visita, con i contrasti già verificati.

## Cosa fa

1. **Settore.** Scegli uno dei settori pronti o scrivi la tua attività. I settori pronti hanno foto scelte e analizzate in anticipo; per le altre attività la ricerca parte al momento su Unsplash, tradotta in inglese.
2. **Foto e logo.** Ogni foto viene ridotta ai suoi tre colori dominanti. Il logo, se lo carichi, viene scontornato quando lo sfondo è a tinta unita: i suoi colori (fino a tre) entrano nella palette e restano fissi. Puoi aggiungere fino a tre foto tue, che pesano il doppio.
3. **Palette.** I cinque colori più rappresentativi, senza doppioni. Puoi bloccarne alcuni e rigenerare il resto, o scegliere quale usare come primario.
4. **Stile.** Quattro stili pronti (Morbido, Netto, Editoriale, Tecnico), con forme, ombre e font open source diversi. Lo strumento ne suggerisce uno in base al settore e ai colori.
5. **Anteprima e supporti.** La palette applicata a una home di esempio, a un post Instagram, a un biglietto da visita e a un'insegna, con la simulazione di deuteranopia, protanopia, tritanopia e scala di grigi (modello di Machado et al., 2009).
6. **Contrasti.** Ogni coppia usata per i testi viene misurata con i criteri WCAG 2.2 (4,5:1 per il testo normale, 3:1 per la grafica). Se un contrasto non basta, lo strumento corregge la luminosità e tiene la tinta.
7. **Esportazione.** Variabili CSS, tema Tailwind v4, token JSON in formato DTCG o i codici da incollare in Canva. La palette si può condividere con un link.

## Metodo

- 6 foto per settore, ridotte a miniature 64 × 48.
- 3 colori dominanti per foto, con k-means nello spazio colore OKLab (percettivamente uniforme).
- Doppioni percettivi uniti sotto ΔE 0,05; restano i 5 colori più rappresentativi e distanti tra loro.
- Sfondo, testo e neutri derivati per la leggibilità; primario e accento presi dai colori estratti.

## Privacy

- Logo e foto caricati dall'utente restano nel browser: non vengono inviati a nessun server.
- Il link condiviso contiene solo i colori, lo stile e, per i settori pronti, il nome del settore. Mai il testo cercato.
- Le foto di Unsplash sono caricate direttamente dai server di Unsplash (hotlink), come chiedono le loro linee guida: il browser comunica a Unsplash il proprio indirizzo IP. Sotto ogni foto c'è il credito del fotografo.

## Link utili

- Strumento: <https://calicchia.design/risorse/palette-di-settore>
- Hai un progetto? <https://calicchia.design/contatti>
