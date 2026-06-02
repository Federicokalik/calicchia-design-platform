# Radicale CalDAV — Fase 0 (spike trasporto)

Obiettivo di questa fase: **provare che un device (iPhone/Mac/DAVx5) riesce a connettersi via CalDAV** attraverso CloudPanel e fare round-trip di un evento, **prima** di scrivere il backend 1:1 (Fasi 1+). Qui Radicale gira con **storage a file + auth htpasswd** (usa-e-getta): in Fase 3 sarà sostituito dall'immagine custom con i plugin che parlano con l'API (Postgres resta l'unica fonte di verità).

> ⚠️ Questa NON è la configurazione definitiva. I dati creati ora vivono nel volume `radicale_data` e verranno buttati passando alla Fase 3.

---

## Passi (tutti sul server / CloudPanel — io non posso farli)

### 1. DNS
Crea un record per `dav.calicchia.design` che punta al server (come gli altri sottodomini).

### 2. Utente htpasswd (password del device)
Sul server, nella working copy del repo:
```bash
# bcrypt; ti chiede la password (questa la metterai sul telefono)
htpasswd -B -c apps/radicale/config/users federico
```
Il file `apps/radicale/config/users` è **gitignorato** (contiene un hash) e sopravvive ai `git pull` di Dockhand perché untracked.

### 3. Servizio nel compose — ✅ GIÀ FATTO
Il servizio `radicale` (image **`tomsquest/docker-radicale:3.7.3.0`**, pinnato) e il volume `radicale_data` sono già in `docker-compose.portainer.yml`. Si auto-deploya con Dockhand al push. Il container parte su `127.0.0.1:3011` e resta innocuo finché non fai DNS+CloudPanel (passi 1 e 4) e crei l'htpasswd (passo 2).

### 4. Vhost CloudPanel per `dav.calicchia.design`
Nuovo **Site → Reverse Proxy** verso `http://127.0.0.1:3011`, TLS Let's Encrypt attivo. Nella config nginx del site servono le direttive CalDAV (il proxy nudo non basta):
```nginx
# dentro il server { } del site dav.calicchia.design
client_max_body_size 100M;
proxy_read_timeout 300s;
proxy_request_buffering off;

location / {
    proxy_pass http://127.0.0.1:3011;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # I metodi WebDAV (PROPFIND/REPORT/MKCALENDAR/MOVE…) passano già col proxy_pass;
    # NON aggiungere 'limit_except' che li bloccherebbe.
}

# Auto-discovery Apple/Thunderbird
location = /.well-known/caldav  { return 301 /; }
location = /.well-known/carddav { return 301 /; }
```

### 5. Deploy
Il compose è già committato → Dockhand fa pull e `up -d` da solo. Devi solo aver fatto: **htpasswd** (passo 2, sul server), **DNS** (passo 1) e **vhost CloudPanel** (passo 4). Verifica che il container sia su: `docker ps | grep radicale` e `docker logs <radicale>`.

---

## Collegare i device (test)

- **iPhone/iPad:** Impostazioni → Calendario → Account → Aggiungi account → Altro → **Aggiungi account CalDAV** → Server `dav.calicchia.design`, Utente `federico`, Password (quella dell'htpasswd).
- **macOS:** Calendario → Aggiungi account → Altro account CalDAV → Tipo: Manuale → stessi dati.
- **Android (DAVx5):** Accesso con URL+credenziali → `https://dav.calicchia.design` → sincronizza.
- **Thunderbird:** Nuovo calendario → Sulla rete → CalDAV → URL `https://dav.calicchia.design`.

## ✅ Checklist di validazione (cosa mi devi confermare)
1. Il device si **connette** senza errori di certificato/login.
2. Compare almeno un calendario scrivibile.
3. **Crei** un evento sul telefono → resta dopo il sync.
4. Lo **modifichi/elimini** sul telefono → si aggiorna.
5. (se hai due device) appare anche sull'altro.

Quando questi 5 punti passano, il trasporto è validato: si procede con le **Fasi 1+** (schema, endpoint API CalDAV, plugin che puntano a Postgres). Se qualcosa fallisce (di solito: discovery `/.well-known`, metodi WebDAV bloccati, o TLS), mandami l'errore e il log del container (`docker logs <radicale>`), aggiustiamo la vhost e riproviamo.

## Teardown (passando alla Fase 3)
La Fase 3 sostituisce `image:` con l'immagine custom (`ghcr.io/federicokalik/calicchia-radicale:<pin>`) e i volumi/plugin; il volume `radicale_data` della Fase 0 si può rimuovere (`docker volume rm <stack>_radicale_data`).
