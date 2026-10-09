#!/usr/bin/env bash
# Controlli sul server di produzione (sola lettura). Eseguire a mano, un blocco alla volta.

# 21) Server: stato reale del CalDAV di oggi (conferma che nessun device ha mai sincronizzato)
docker ps --format '{{.Names}} {{.Image}}' | grep -i radicale
docker logs --since 2160h $(docker ps -qf name=radicale) 2>&1 | grep -c 'takes 3 positional arguments'
docker logs --since 2160h $(docker ps -qf name=radicale) 2>&1 | grep -E 'PUT|PROPFIND|REPORT' | tail -n 20

# 22) Server: vecchio volume della Fase 0 (eventi iCalendar mai migrati?)
docker volume ls --format '{{.Name}}' | grep -i radicale
# se esiste <stack>_radicale_data:
docker run --rm -v <stack>_radicale_data:/v:ro alpine sh -c 'ls -la /v; find /v -name "*.ics" | wc -l; ls /v/collections/collection-root 2>/dev/null'

# 23) Server: filesystem dei volumi Docker (il campanello richiede ext4/xfs/btrfs locale) e subnet in uso (per scegliere caldav-int)
stat -f -c '%T' /var/lib/docker/volumes
docker network ls --format '{{.Name}}' | xargs -I{} docker network inspect {} --format '{{.Name}} {{range .IPAM.Config}}{{.Subnet}} gw={{.Gateway}} {{end}}'

# 24) Server: vhost CalDAV e header per l'IP del device
curl -sI https://dav.calicchia.design/.well-known/caldav | head -n 5
grep -rn 'dav.calicchia.design' /etc/nginx/sites-enabled/ 2>/dev/null; grep -rn 'X-Remote-Addr\|client_max_body_size' /etc/nginx/sites-enabled/*dav* 2>/dev/null

# 25) Server: cadenza reale dei backup (lo script unico deve passare a 6 h) e immagine API in uso (per il pin del tag)
crontab -l 2>/dev/null | grep -E 'backup-db|backup-calendar'
docker inspect $(docker ps -qf name=api) --format '{{.Config.Image}} {{.Image}} {{.Created}}'
