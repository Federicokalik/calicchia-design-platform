#!/usr/bin/env bash
# takeout-wget.sh
set -euo pipefail

# Requirements: bash, wget, sed, awk, tput, tail, curl
# macOS-friendly; avoids stdbuf if not present. Shows K per-worker progress lines + total.

cleanup() {
	tput cnorm || true
	# Kill background processes
	[[ -n "${TMP_DIR:-}" ]] && pkill -P $$ 2>/dev/null || true
	# Wait a moment for processes to terminate
	sleep 0.5
	[[ -n "${TMP_DIR:-}" && -d "$TMP_DIR" ]] && rm -rf "$TMP_DIR"
}
trap cleanup EXIT

log() { printf "[%s] %s\n" "$(date '+%H:%M:%S')" "$*" >&2; }

# Read curl command (single line). Prefer file 'testcurl' if present.
CURL_CMD=""
if [[ -f testcurl ]]; then
	CURL_CMD="$(cat testcurl)"
	log "Loaded curl command from file 'testcurl' (len=${#CURL_CMD})"
elif [[ $# -ge 1 ]]; then
	CURL_CMD="$*"
	log "Loaded curl command from CLI args (len=${#CURL_CMD})"
else
	echo "Paste the full curl command or URL and press Enter:"
	IFS= read -r CURL_CMD
	log "Loaded curl command from interactive input (len=${#CURL_CMD})"
fi

# Extract URL (prefers single quotes, falls back to double, then raw token)
URL=$(printf "%s\n" "$CURL_CMD" | sed -nE "s/.*'(https?:\/\/[^']+)'.*/\1/p")
if [[ -z "$URL" ]]; then
	URL=$(printf "%s\n" "$CURL_CMD" | sed -nE 's/.*"(https?:\/\/[^"]+)".*/\1/p' || true)
fi
if [[ -z "$URL" ]]; then
	URL=$(printf "%s\n" "$CURL_CMD" | awk '{for(i=1;i<=NF;i++) if($i ~ /^https?:\/\//){print $i; exit}}' || true)
fi
if [[ -z "$URL" ]]; then
	echo "Could not extract URL from input." >&2
	exit 1
fi

# Extract cookies from -b/--cookie or from -H 'Cookie: ...'
extract_cookie() {
	local src="$1"
	local c=""

	# -b '...'
	c=$(printf "%s\n" "$src" | sed -nE "s/.* -b '([^']+)'.*/\1/p")
	# --cookie '...' or --cookie="..."
	if [[ -z "$c" ]]; then
		c=$(printf "%s\n" "$src" | sed -nE 's/.* --cookie "([^"]+)".*/\1/p')
	fi
	# -H 'Cookie: ...'
	if [[ -z "$c" ]]; then
		c=$(printf "%s\n" "$src" | sed -nE "s/.*-H 'Cookie: ([^']+)'.*/\1/p")
	fi
	printf "%s" "$c"
}

COOKIE="$(extract_cookie "$CURL_CMD")"
if [[ -z "$COOKIE" && -f cookies ]]; then
	# Try to load from file 'cookies' (take first non-empty line; strip optional 'Cookie:' prefix)
	COOKIE_LINE="$(sed -n '/./{p;q}' cookies 2>/dev/null || true)"
	COOKIE="$(printf "%s" "$COOKIE_LINE" | sed -E 's/^[Cc]ookie:[[:space:]]*//')"
	[[ -n "$COOKIE" ]] && log "Cookie loaded from file 'cookies'"
fi

if [[ -n "$COOKIE" ]]; then
	log "Cookie detected, length: ${#COOKIE}"
else
	log "No Cookie detected. If your cookies string isn’t quoted, please wrap it in single quotes or add a 'cookies' file."
fi

# Collect headers (-H), excluding Cookie/Host/Content-Length
mapfile -t RAW_HS < <(printf "%s\n" "$CURL_CMD" | grep -Eo -- "-H '([^']+)'" || true)
mapfile -t RAW_HS2 < <(printf "%s\n" "$CURL_CMD" | grep -Eo -- '-H "([^"]+)"' || true)
HEADERS=()
_add_header() {
	local h="$1"
	h="${h#-H }"; h="${h#\'}"; h="${h%\' }"; h="${h#\"}"; h="${h%\" }"
	if [[ "${h,,}" =~ ^cookie: ]]; then return; fi
	if [[ "${h,,}" =~ ^host: ]]; then return; fi
	if [[ "${h,,}" =~ ^content-length: ]]; then return; fi
	HEADERS+=("$h")
}
for x in "${RAW_HS[@]:-}";  do _add_header "$x"; done
for x in "${RAW_HS2[@]:-}"; do _add_header "$x"; done

# Helper to run curl with our headers to resolve redirects (for page URL form)
curl_with_headers() {
	local method="$1"; shift
	local url="$1"; shift
	local args=()
	if [[ -n "${COOKIE:-}" ]]; then args+=(-H "Cookie: ${COOKIE}"); fi
	for h in "${HEADERS[@]:-}"; do args+=(-H "$h"); done
	curl -sS -L "${args[@]}" "${method}" "$url" "$@"
}

# If URL is a "page" URL, resolve to the final download URL
host=$(printf "%s" "$URL" | awk -F/ '{print $3}')
if [[ "$host" == "takeout.google.com" ]]; then
	log "Resolving redirect for page URL..."
	final_url=$(curl_with_headers "-o" /dev/null -w "%{url_effective}" "$URL")
	
	if [[ -z "$final_url" ]]; then
		echo "Failed to resolve redirect." >&2
		exit 1
	fi

	log "Resolved to: $final_url"
	URL="$final_url"
	host=$(printf "%s" "$URL" | awk -F/ '{print $3}')
fi

# From here, we expect a direct download host; use as canonical template
if [[ "$host" != "takeout-download.usercontent.google.com" ]]; then
	log "Warning: unexpected host '$host'. Proceeding, but downloads may fail."
fi

# Parse URL parts and build template
URL_NO_QS="${URL%%\?*}"
QS_ORIG=""
if [[ "$URL" == *\?* ]]; then QS_ORIG="${URL#*\?}"; fi
# Keep all query params except i=..., we will set i per part
QS_BASE=$(printf "%s\n" "$QS_ORIG" | sed -E 's/(^|&)i=[^&]*//g; s/&&/\&/g; s/^&//; s/&$//')

BASENAME=$(basename "$URL_NO_QS")

# Match: takeout-<stamp>-1-<digits>.zip ; allow 3+ digits
if [[ "$BASENAME" =~ ^(takeout-[^-]+-1-)([0-9]{3,})\.zip$ ]]; then
	FNAME_PREFIX="${BASENAME%%-[0-9]*}."; : # placeholder to avoid shellcheck
	FNAME_PREFIX="${BASH_REMATCH[1]}"
	SAMPLE_NUM="${BASH_REMATCH[2]}"
else
	echo "Could not parse filename pattern from URL ($BASENAME)." >&2
	exit 1
fi
# URL prefix up to the number
URL_PREFIX=$(printf "%s\n" "$URL_NO_QS" | sed -E 's#^(.*-1-)[0-9]{3,}\.zip$#\1#')
if [[ -z "$URL_PREFIX" || "$URL_PREFIX" == "$URL_NO_QS" ]]; then
	echo "Could not parse URL prefix." >&2
	exit 1
fi

log "Parsed pattern:"
log "  URL prefix: ${URL_PREFIX}<NNN>.zip"
log "  Query base: ${QS_BASE:-<none>} (i will be set per part)"
log "  File prefix: ${FNAME_PREFIX}<NNN>.zip"
[[ -n "$COOKIE" ]] && log "Using Cookie header (hidden)" || log "No Cookie header detected"
for h in "${HEADERS[@]:-}"; do log "Using header: $h"; done

echo -n "How many parts total (e.g., 1155): "
read -r TOTAL_PARTS
if ! [[ "$TOTAL_PARTS" =~ ^[0-9]+$ ]] || [[ "$TOTAL_PARTS" -le 0 ]]; then
	echo "Invalid number" >&2; exit 1
fi

echo -n "How many concurrent downloads (e.g., 5): "
read -r CONCURRENCY
if ! [[ "$CONCURRENCY" =~ ^[0-9]+$ ]] || [[ "$CONCURRENCY" -le 0 ]]; then
	echo "Invalid number" >&2; exit 1
fi

echo -n "Output directory [default: ./downloads]: "
read -r OUTDIR
OUTDIR="${OUTDIR:-./downloads}"
if ! mkdir -p "$OUTDIR"; then
	echo "Failed to create output directory '$OUTDIR'" >&2
	exit 1
fi

TMP_DIR=$(mktemp -d -t takeout-wget-XXXXXX)
QUEUE="$TMP_DIR/queue.fifo"
DONE_PIPE="$TMP_DIR/done.fifo"
mkfifo "$QUEUE" "$DONE_PIPE"

# Function to create cookies.txt file
_create_cookies_file() {
	# Extract domain from URL
	DOMAIN=$(printf "%s" "$URL" | sed -E 's|^https?://([^/]+).*|\1|')
	# Create Netscape format cookies.txt
	printf "# Netscape HTTP Cookie File\n" > "$COOKIES_FILE"
	printf "# https://curl.se/rfc/cookie_spec.html\n" >> "$COOKIES_FILE"
	printf "# This file was generated by takeout-wget.sh\n\n" >> "$COOKIES_FILE"
	
	# Parse cookies and convert to Netscape format
	printf "%s" "$COOKIE" | tr ';' '\n' | while IFS='=' read -r name value; do
		name=$(printf "%s" "$name" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
		value=$(printf "%s" "$value" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
		if [[ -n "$name" && -n "$value" ]]; then
			printf "%s\tTRUE\t%s\t/\tFALSE\t2147483647\t%s\t%s\n" "$DOMAIN" "$DOMAIN" "$name" "$value" >> "$COOKIES_FILE"
		fi
	done
	log "Created cookies.txt with $(wc -l < "$COOKIES_FILE" | tr -d ' ') cookie entries"
}

# Create cookies.txt file in Netscape format if cookies are available
COOKIES_FILE="./cookies.txt"
if [[ -n "${COOKIE:-}" ]]; then
	# Check if cookies.txt already exists
	if [[ -f "$COOKIES_FILE" ]]; then
		echo -n "cookies.txt already exists. Override with cookies from curl command? [Y/n]: "
		read -r override_response
		override_response="${override_response:-Y}"
		if [[ "${override_response,,}" != "y" && "${override_response,,}" != "yes" ]]; then
			log "Using existing cookies.txt file"
		else
			log "Overriding existing cookies.txt with cookies from curl command"
			_create_cookies_file
		fi
	else
		_create_cookies_file
	fi
fi

# Enqueue jobs; dynamic width: width = max(3, digits(part_num))
(
	for (( i=0; i< TOTAL_PARTS; i++ )); do
		part_num=$((i+1))
		digits=${#part_num}
		width=$(( digits < 3 ? 3 : digits ))
		part_str=$(printf "%0${width}d" "$part_num")
		out_name="${FNAME_PREFIX}${part_str}.zip"

		qs="$QS_BASE"
		if [[ -n "$qs" ]]; then qs="${qs}&"; fi
		qs="${qs}i=${i}"

		full_url="${URL_PREFIX}${part_str}.zip"
		if [[ -n "$qs" ]]; then full_url="${full_url}?${qs}"; fi

		printf "%s|%s|%s\n" "$i" "$full_url" "$out_name"
	done > "$QUEUE"
) &

# Clear screen and move cursor to top before drawing progress UI
if command -v tput >/dev/null 2>&1; then
	tput clear
	tput cup 0 0
else
	printf '\033[2J\033[H'
fi

# TUI helpers
tput civis
cols=$(tput cols || echo 120)
base_row=0

print_line() {
	local row="$1"; shift
	local msg="$*"
	tput cup "$row" 0
	if ((${#msg} > cols)); then
		printf "%s" "${msg:0:cols}"
	else
		printf "%-${cols}s" "$msg"
	fi
}

draw_total() {
	local done="$1" total="$2"
	local width=$((cols - 25))
	(( width < 10 )) && width=10
	local percent=0
	local filled=0
	local empty=$width
	if [[ $total -gt 0 ]]; then
		percent=$(( done*100/total ))
		filled=$(( width*done/total ))
		empty=$(( width - filled ))
	fi
	printf -v bar "[%s%s]" "$(printf '%0.s#' $(seq 1 $filled))" "$(printf '%0.s-' $(seq 1 $empty))"
	print_line "$base_row" "Total ${done}/${total} ${bar} ${percent}%%"
}

# Per-slot presenters
for (( s=1; s<=CONCURRENCY; s++ )); do
	logf="$TMP_DIR/slot-$s.log"
	: > "$logf"
	(
		tail -n 0 -F "$logf" 2>/dev/null | while IFS= read -r line; do
			# Clean up the line (remove carriage returns and trim)
			line=$(printf "%s" "$line" | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
			if [[ -n "$line" ]]; then
				print_line $((base_row + s)) "[S${s}] ${line}"
			fi
		done
	) &
done

# Build wget args
WGET_ARGS=(-q --show-progress --progress=bar:force --continue --tries=3 --mirror)
if [[ -f "$COOKIES_FILE" ]]; then
	WGET_ARGS+=(--load-cookies "$COOKIES_FILE")
	log "Using cookies from $COOKIES_FILE"
else
	log "No cookies file created, proceeding without authentication"
fi
for h in "${HEADERS[@]:-}"; do
	WGET_ARGS+=(--header "$h")
done

# Cross-platform stat size
file_size() {
	local f="$1"
	if command -v stat >/dev/null 2>&1; then
		if stat -f%z "$f" >/dev/null 2>&1; then
			stat -f%z "$f"
		elif stat -c%s "$f" >/dev/null 2>&1; then
			stat -c%s "$f"
		else
			echo "unknown"
		fi
	else
		echo "unknown"
	fi
}

# Optional stdbuf
STDBUF=()
if command -v stdbuf >/dev/null 2>&1; then
	STDBUF=(stdbuf -oL -eL)
fi

# Workers
start_worker() {
	local slot="$1"
	local logf="$TMP_DIR/slot-$slot.log"
	(
		while IFS='|' read -r idx job_url out_name; do
			print_line $((base_row + slot)) "[S${slot}] downloading ${out_name} from ${job_url}"
			log "S${slot} START idx=${idx} file=${out_name} url=${job_url}"

			# Build the command
			CMD=(wget "${WGET_ARGS[@]}" -O "$OUTDIR/$out_name" "$job_url")
			if [[ ${#STDBUF[@]} -gt 0 ]]; then
				CMD=("${STDBUF[@]}" "${CMD[@]}")
			fi

			# Print the exact command for debugging
			printf -v CMD_STR '%q ' "${CMD[@]}"
			print_line $((base_row + slot)) "[S${slot}] cmd: ${CMD_STR}"
			log "S${slot} FULL_WGET_CMD: ${CMD_STR}"
			log "S${slot} WGET_ARGS: $(printf '%q ' "${WGET_ARGS[@]}")"
			log "S${slot} URL: ${job_url}"
			log "S${slot} OUTPUT: $OUTDIR/$out_name"
			# Execute - redirect both stdout and stderr to log file for progress display
			if "${CMD[@]}" > "$logf" 2>&1; then
				size=$(file_size "$OUTDIR/$out_name")
				print_line $((base_row + slot)) "[S${slot}] completed ${out_name} (${size} bytes)"
				log "S${slot} OK idx=${idx} file=${out_name} size=${size}"
			else
				print_line $((base_row + slot)) "[S${slot}] FAILED ${out_name}"
				log "S${slot} FAIL idx=${idx} file=${out_name}"
			fi

			printf "%s\n" "1" > "$DONE_PIPE"
		done < "$QUEUE"
	) &
}

for (( s=1; s<=CONCURRENCY; s++ )); do
	start_worker "$s"
done

draw_total 0 "$TOTAL_PARTS"
done_cnt=0
while (( done_cnt < TOTAL_PARTS )); do
	IFS= read -r _ < "$DONE_PIPE" || true
	((done_cnt++))
	draw_total "$done_cnt" "$TOTAL_PARTS"
done

tput cnorm
echo
echo "All downloads completed in '$OUTDIR'."