#!/usr/bin/env python3
"""Word-level timings for vo/seg*.mp3 (local faster-whisper) -> film/vo-words.json."""
import json, subprocess
import numpy as np
from faster_whisper import WhisperModel
SEGS = ['1','2a','2b','3','4','5','6','7','8','9']
m = WhisperModel('small.en', device='cpu', compute_type='int8')
out = {}
for s in SEGS:
    pcm = subprocess.run(['ffmpeg','-v','error','-i',f'vo/seg{s}.mp3','-f','s16le','-ac','1','-ar','16000','-'],capture_output=True,check=True).stdout
    audio = np.frombuffer(pcm, np.int16).astype(np.float32) / 32768
    segs, _ = m.transcribe(audio, word_timestamps=True, beam_size=5)
    words = [{'w': w.word.strip(), 's': round(w.start, 3), 'e': round(w.end, 3)} for sg in segs for w in sg.words]
    out[s] = words
    print(s, ' '.join(f"{w['w']}@{w['s']}" for w in words))
json.dump(out, open('film/vo-words.json', 'w'), indent=1)
