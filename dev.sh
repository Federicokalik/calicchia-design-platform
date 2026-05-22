#!/bin/bash

# Colori per output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  Calicchia Design Platform - Development Server${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "${BLUE}Sito v3 (Next):${NC}   http://localhost:3000"
echo -e "${YELLOW}Admin (Vite):${NC}     http://localhost:5173"
echo -e "${RED}API (Hono):${NC}       http://localhost:3001"
echo ""
echo -e "${GREEN}Avvio in corso...${NC}"
echo ""

# Funzione per cleanup quando si esce
cleanup() {
    echo ""
    echo -e "${YELLOW}Arresto dei server...${NC}"
    kill $(jobs -p) 2>/dev/null
    exit 0
}

trap cleanup SIGINT SIGTERM

# Avvia tutti i servizi in parallelo
npm run dev --workspace=@calicchia/api &
npm run dev --workspace=@calicchia/sito-v3 &
npm run dev --workspace=@calicchia/admin &

# Aspetta tutti i processi
wait
