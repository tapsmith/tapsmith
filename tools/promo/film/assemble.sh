#!/bin/bash
# Final assembly: film/frames + VO + score + sound design -> tapsmith-promo.mp4
#   film/assemble.sh                full film
#   film/assemble.sh preview A B    seconds A..B (frames for that range must exist) -> film/preview.mp4
#   film/assemble.sh audio          only the mix (film/mix.wav)
# VO segments are placed at TL.VO (film/timeline.js, exported into film/cues.json);
# the score ducks under the voice via sidechain compression.
set -euo pipefail
cd "$(dirname "$0")/.."
DUR=$(node -e "console.log(require('./film/cues.json').TL.DUR)")
SEGS=(1 2a 2b 3 4 5 6 7 8 9)
IN=(); FC=""; i=0
for s in "${SEGS[@]}"; do
  ms=$(node -e "console.log(Math.round(require('./film/cues.json').TL.VO['$s']*1000))")
  IN+=(-i "vo/seg$s.mp3")
  FC+="[$i:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${ms}|${ms}[v$i];"
  i=$((i+1))
done
VOL=""; for j in $(seq 0 $((i-1))); do VOL+="[v$j]"; done
FC+="${VOL}amix=inputs=$i:normalize=0,volume=1.0,apad=whole_dur=${DUR},asplit=2[vo][key];"
FC+="[$i:a]volume=0.34[mus];[mus][key]sidechaincompress=threshold=0.02:ratio=8:attack=30:release=520:makeup=1[musd];"
FC+="[$((i+1)):a]volume=0.5[sfx];"
FC+="[vo]highpass=f=70,equalizer=f=3200:t=q:w=1.2:g=2.5[vof];"
FC+="[vof][musd][sfx]amix=inputs=3:normalize=0,alimiter=limit=0.95:level=disabled,loudnorm=I=-14:TP=-1.5:LRA=11[aout]"
ffmpeg -y -v error "${IN[@]}" -i film/music.wav -i film/sfx.wav -filter_complex "$FC" -map "[aout]" -ar 48000 -t "$DUR" film/mix.wav
echo "mix: $(ffprobe -v error -show_entries format=duration -of csv=p=0 film/mix.wav)s"
[ "${1:-}" = "audio" ] && exit 0

if [ "${1:-}" = "preview" ]; then
  A=$2; B=$3
  START=$(python3 -c "print(round($A*30))"); LEN=$(python3 -c "print($B-$A)")
  ffmpeg -y -v error -framerate 30 -start_number "$START" -i film/frames/f%05d.jpg -ss "$A" -t "$LEN" -i film/mix.wav \
    -map 0:v -map 1:a -t "$LEN" -c:v libx264 -crf 18 -preset fast -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart film/preview.mp4
  echo "film/preview.mp4"; exit 0
fi

ffmpeg -y -v error -framerate 30 -i film/frames/f%05d.jpg -i film/mix.wav \
  -map 0:v -map 1:a -c:v libx264 -crf 16 -preset slow -pix_fmt yuv420p -profile:v high -tune film -movflags +faststart \
  -c:a aac -b:a 256k -ar 48000 -t "$DUR" tapsmith-promo.mp4
ffprobe -v error -show_entries format=duration,size -of default=nw=1 tapsmith-promo.mp4
