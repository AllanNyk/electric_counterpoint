#!/usr/bin/env bash
# build_samples.sh
# Generate chromatic MP3 sample banks for Electric Counterpoint.
#
# Downloads CC0 source WAVs from public GitHub repos into a local cache,
# then pitch-shifts via ffmpeg to produce one MP3 per semitone under
# ../assets/audio/<instrument>/<note>.mp3 — e.g. guitar_clean/c4.mp3,
# guitar_clean/fs5.mp3, bass_guitar/e2.mp3. Sharps written as 's'
# (cs4 = C#4) for URL safety, mirroring the In C convention.
#
# Sources (all CC0):
#   guitar_clean — sfzinstruments/karoryfer.black-and-green-guitars
#                  Samples/black/ord/twang_<pitch>_mf_rr1.wav     (chromatic A3..C7)
#   bass_guitar  — sfzinstruments/karoryfer.black-and-blue-basses
#                  Samples/darkblack/reg/darkblack_<pitch>_mf_rr1.wav (chromatic B1..E5)
#   woodblock    — sgossner/VCSL
#                  Idiophones/Struck Idiophones/Woodblock/wood_click_mp.wav (single hit)
#
# Karoryfer pitch tokens use flats (db, eb, gb, ab, bb), not sharps —
# `midi_to_karoryfer` translates from MIDI to the source filename token,
# while output files use our own URL-safe sharp-prefix convention via
# `midi_to_note` (matches In C).
#
# Usage:
#   bash tools/build_samples.sh
#
# Idempotent. Source WAVs live in tools/.cache/ and are reused on
# subsequent runs. Delete that directory to force a fresh download.
# Requires: curl, ffmpeg, awk, bash 4+.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CACHE_ROOT="$SCRIPT_DIR/.cache"
DEST_ROOT="$PROJECT_ROOT/assets/audio"
TARGET_RATE=44100
MP3_BITRATE=128k

mkdir -p "$CACHE_ROOT"
mkdir -p "$DEST_ROOT"

# ---- helpers ----

midi_to_note() {
  # MIDI -> URL-safe filename token (e.g. 60 -> c4, 61 -> cs4, 70 -> as4, 71 -> b4)
  local midi=$1
  local octave=$(( midi / 12 - 1 ))
  local pc=$(( midi % 12 ))
  local names=("c" "cs" "d" "ds" "e" "f" "fs" "g" "gs" "a" "as" "b")
  echo "${names[$pc]}${octave}"
}

midi_to_karoryfer() {
  # MIDI -> Karoryfer pitch token (uses flats: db, eb, gb, ab, bb)
  local midi=$1
  local octave=$(( midi / 12 - 1 ))
  local pc=$(( midi % 12 ))
  local names=("c" "db" "d" "eb" "e" "f" "gb" "g" "ab" "a" "bb" "b")
  echo "${names[$pc]}${octave}"
}

# download <url> <cache_subpath>
# On success: caches the file under $CACHE_ROOT/<cache_subpath> and sets
# RESULT_PATH to its absolute path. On 404 or transport failure: returns
# nonzero, removes any partial file, leaves RESULT_PATH empty.
download() {
  local url="$1"
  local cache_path="$CACHE_ROOT/$2"
  RESULT_PATH=""
  if [[ -f "$cache_path" ]]; then
    RESULT_PATH="$cache_path"
    return 0
  fi
  mkdir -p "$(dirname "$cache_path")"
  if curl -fsSL "$url" -o "$cache_path" 2>/dev/null; then
    RESULT_PATH="$cache_path"
    return 0
  fi
  rm -f "$cache_path"
  return 1
}

# Pitch-shift a wav to an mp3 by N semitones using ffmpeg's asetrate trick.
# Cheap, formant-shifting (good enough for chromatic interpolation up to
# ~5 semitones; beyond that the timbre starts to shift noticeably).
# Args: in_wav semitones out_mp3
shift_to_mp3() {
  local in="$1"
  local semis="$2"
  local out="$3"
  if [[ "$semis" == "0" ]]; then
    ffmpeg -y -loglevel error -i "$in" -ac 1 -ar "$TARGET_RATE" -b:a "$MP3_BITRATE" "$out"
  else
    local new_rate
    new_rate=$(awk -v r="$TARGET_RATE" -v s="$semis" 'BEGIN { printf "%d", r * 2.0^(s/12.0) }')
    ffmpeg -y -loglevel error -i "$in" -af "asetrate=${new_rate},aresample=${TARGET_RATE}" -ac 1 -ar "$TARGET_RATE" -b:a "$MP3_BITRATE" "$out"
  fi
}

# build_chromatic_bank
#   $1  instrument_name  (output folder under DEST_ROOT)
#   $2  src_low_midi     (lowest *sounding* MIDI in the source range)
#   $3  src_high_midi    (highest *sounding* MIDI in the source range)
#   $4  out_low_midi     (target chromatic range — lowest, sounding)
#   $5  out_high_midi    (target chromatic range — highest, sounding)
#   $6  base_url         (raw URL prefix to the source folder)
#   $7  fname_prefix     (filename prefix before the pitch token, e.g. "twang_")
#   $8  fname_suffix     (filename suffix after the pitch token, e.g. "_mf_rr1.wav")
#   $9  cache_subdir     (where to cache source WAVs under tools/.cache/)
#   $10 src_label_offset (semitones; default 0)
#                        Some libraries label their source files at a
#                        pitch one octave below what they actually sound
#                        (or vice versa). For each iteration `m` (the
#                        sounding MIDI we want), the filename token is
#                        derived from `m + src_label_offset`. So:
#                          0   — labels match sounding pitch (Karoryfer
#                                black-and-green-guitars, black-and-blue
#                                -basses)
#                          -12 — file labelled "X" sounds at MIDI(X)+12
#                                (Karoryfer shinyguitar — set this and
#                                pass src_low/src_high in *sounding*
#                                MIDI, the iteration will map each m back
#                                to the source's own labelling)
build_chromatic_bank() {
  local name="$1" src_low="$2" src_high="$3"
  local out_low="$4" out_high="$5"
  local base_url="$6" fname_prefix="$7" fname_suffix="$8" cache_subdir="$9"
  local src_label_offset="${10:-0}"
  local out_dir="$DEST_ROOT/$name"
  mkdir -p "$out_dir"

  echo "[$name] discovering source samples (sounding MIDI $src_low..$src_high)..."
  local -a src_midis=()
  local -a src_files=()
  local m k fname
  for (( m=src_low; m<=src_high; m++ )); do
    k=$(midi_to_karoryfer "$((m + src_label_offset))")
    fname="${fname_prefix}${k}${fname_suffix}"
    if download "${base_url}/${fname}" "${cache_subdir}/${fname}"; then
      src_midis+=("$m")
      src_files+=("$RESULT_PATH")
    fi
  done

  if (( ${#src_midis[@]} == 0 )); then
    echo "[$name] ERROR: no source samples downloaded — check URL / network"
    return 1
  fi
  echo "[$name] ${#src_midis[@]} source samples cached"

  echo "[$name] generating chromatic mp3 bank (MIDI $out_low..$out_high)..."
  local target nearest_idx nearest_dist d delta out_name out_path
  for (( target=out_low; target<=out_high; target++ )); do
    nearest_idx=0; nearest_dist=999
    for i in "${!src_midis[@]}"; do
      d=$(( target - src_midis[i] )); d=${d#-}
      if (( d < nearest_dist )); then nearest_dist=$d; nearest_idx=$i; fi
    done
    delta=$(( target - src_midis[nearest_idx] ))
    out_name=$(midi_to_note "$target")
    out_path="${out_dir}/${out_name}.mp3"
    shift_to_mp3 "${src_files[nearest_idx]}" "$delta" "$out_path"
  done
  echo "[$name] -> $out_dir ($((out_high - out_low + 1)) notes)"
}

# ---- woodblock (VCSL, CC0) ----
build_woodblock() {
  local out_dir="$DEST_ROOT/woodblock"
  mkdir -p "$out_dir"
  local url="https://raw.githubusercontent.com/sgossner/VCSL/master/Idiophones/Struck%20Idiophones/Woodblock/wood_click_mp.wav"
  local cache_path="vcsl/Idiophones/Struck Idiophones/Woodblock/wood_click_mp.wav"

  echo "[woodblock] sourcing single sample..."
  if ! download "$url" "$cache_path"; then
    echo "[woodblock] ERROR: failed to fetch $url"
    return 1
  fi
  # +12 dB boost — VCSL wood_click_mp is recorded soft (mp = mezzo-
  # piano). At our default click channel gain it was barely audible
  # over the guitars; baking the boost into the file keeps the sample
  # itself at a usable peak.
  ffmpeg -y -loglevel error -i "$RESULT_PATH" -af "volume=4.0" -ac 1 -ar "$TARGET_RATE" -b:a "$MP3_BITRATE" "$out_dir/click.mp3"
  echo "[woodblock] -> $out_dir/click.mp3"
}

# ---- run ----

# Karoryfer black-and-green-guitars — clean Strat-ish electric, sustain (ord).
# Source range: chromatic A3..C7 (MIDI 57..96).
# Output range: E2..C7 (MIDI 40..96). Notes below A3 are pitch-shifted from
# A3 by up to 17 semitones — they sound darker / slower than the natural
# tone but are listenable. Phase 7 swap palettes can supply a wider source.
build_chromatic_bank \
  "guitar_clean" 57 96 40 96 \
  "https://raw.githubusercontent.com/sfzinstruments/karoryfer.black-and-green-guitars/main/Samples/black/ord" \
  "twang_" "_mf_rr1.wav" \
  "karoryfer-black-and-green/Samples/black/ord"

# Karoryfer black-and-blue-basses — fingered electric bass, sustained (reg).
# Source range: chromatic B1..E5 (MIDI 35..76).
# Output range: E1..E5 (MIDI 28..76). Reich's bass parts dip to A1; widen
# the floor to E1 (4-string bass low E) for a small safety margin.
build_chromatic_bank \
  "bass_guitar" 35 76 28 76 \
  "https://raw.githubusercontent.com/sfzinstruments/karoryfer.black-and-blue-basses/main/Samples/darkblack/reg" \
  "darkblack_" "_mf_rr1.wav" \
  "karoryfer-black-and-blue/Samples/darkblack/reg"

# Karoryfer shinyguitar — archtop / acoustic-leaning electric. CC0,
# master branch. Source has 17 sample points under Samples/acoustic/
# spanning labels Db2..C6 at minor-third spacing.
#
# IMPORTANT: this library labels its files an octave BELOW the sounding
# pitch (file `a3_vl1_rr1_1.wav` actually sounds at A4). black-and-
# green-guitars labels match sounding; this library is offset. We pass
# src_label_offset = -12 so the build maps each sounding-MIDI iteration
# back to the source's own naming. Source range in *sounding* MIDI is
# therefore Db3..C7 (49..96), shifted up from the file labels' 37..84.
build_chromatic_bank \
  "guitar_acoustic" 49 96 40 96 \
  "https://raw.githubusercontent.com/sfzinstruments/karoryfer.shinyguitar/master/Samples/acoustic" \
  "" "_vl1_rr1_1.wav" \
  "karoryfer-shinyguitar/Samples/acoustic" \
  -12

build_woodblock

echo
echo "all sample banks built under: $DEST_ROOT"
