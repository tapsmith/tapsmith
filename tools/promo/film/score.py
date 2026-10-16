#!/usr/bin/env python3
"""Original score + sound design for the Tapsmith film, scored to picture.

Reads film/cues.json (exported from the page by `node film/render.mjs cues`)
and writes two stereo 48 kHz stems:
  film/music.wav  the score: 120 BPM, D major, bar = 2.0 s, scene cuts on bar lines
  film/sfx.wav    sound design: one synthesized sound per picture cue
assemble.sh mixes them under the voiceover (music ducks under the VO).

Arc: a cold, ticking D-minor intro under the problem montage; near-silence
for "Tapsmith is the next step."; the drop lands on BEAT (18.0) with the mark;
a warm sidechained groove runs the product tour with per-scene chord plans;
the feature montage is the climax; the outro resolves on Dmaj9.
"""
import json
import numpy as np
from scipy import signal
import soundfile as sf

SR = 48000
CUES = json.load(open('film/cues.json'))
TL = CUES['TL']
DUR = TL['DUR']
BEAT = TL['BEAT']
N = int(SR * (DUR + 0.5))
rng = np.random.default_rng(7)

# ─── primitives ───
def t_axis(n):
    return np.arange(n) / SR

def mtof(m):
    return 440.0 * 2 ** ((m - 69) / 12)

def table(nh, rolloff=1.0):
    """One cycle of a band-limited saw-ish wavetable with nh harmonics."""
    x = np.arange(2048) / 2048
    w = np.zeros(2048)
    for k in range(1, nh + 1):
        w += np.sin(2 * np.pi * k * x) / k ** rolloff
    return w / np.max(np.abs(w))

TABLES = {n: table(n) for n in (1, 3, 6, 10, 16, 24)}
SOFT = {n: table(n, 1.6) for n in (6, 10, 16)}

def osc(freq, n, tbl, phase0=0.0):
    """Wavetable oscillator; freq may be scalar or per-sample array."""
    f = np.broadcast_to(np.asarray(freq, dtype=float), (n,))
    ph = (phase0 + np.cumsum(f) / SR) % 1.0
    idx = ph * 2048
    i0 = idx.astype(int) % 2048
    fr = idx - np.floor(idx)
    return tbl[i0] * (1 - fr) + tbl[(i0 + 1) % 2048] * fr

def pick_table(f, soft=False):
    nh = max(1, min(24, int(16000 / max(f, 20))))
    keys = sorted((SOFT if soft else TABLES).keys())
    k = max([x for x in keys if x <= nh] or [keys[0]])
    return (SOFT if soft else TABLES)[k]

def adsr(n, a, d, s, r, total=None):
    t = t_axis(n)
    total = total if total is not None else n / SR
    env = np.where(t < a, t / max(a, 1e-4), s + (1 - s) * np.exp(-(t - a) / max(d, 1e-4)))
    rel_start = max(total - r, 0)
    env = env * np.clip((total - t) / max(r, 1e-4), 0, 1) ** 1.0 if r > 0 else env
    return env

def bp(x, lo, hi, order=2):
    sos = signal.butter(order, [lo, min(hi, SR / 2 - 100)], 'bandpass', fs=SR, output='sos')
    return signal.sosfilt(sos, x, axis=0)

def lp(x, fc, order=2):
    sos = signal.butter(order, min(fc, SR / 2 - 100), 'lowpass', fs=SR, output='sos')
    return signal.sosfilt(sos, x, axis=0)

def hp(x, fc, order=2):
    sos = signal.butter(order, fc, 'highpass', fs=SR, output='sos')
    return signal.sosfilt(sos, x, axis=0)

def stereo(x, pan=0.0, width=0.0):
    """pan -1..1 (equal power); width adds a short Haas offset on one side."""
    l = np.cos((pan + 1) * np.pi / 4)
    r = np.sin((pan + 1) * np.pi / 4)
    out = np.stack([x * l, x * r], axis=1)
    if width:
        d = int(width * SR)
        out[d:, 1] = out[:-d, 1] if d else out[:, 1]
    return out

def add(bus, x, t0):
    i0 = int(round(t0 * SR))
    if i0 >= len(bus):
        return
    if i0 < 0:
        x = x[-i0:]
        i0 = 0
    n = min(len(x), len(bus) - i0)
    bus[i0:i0 + n] += x[:n]

def make_ir(dur, decay, seed, bright=6000):
    n = int(dur * SR)
    r = np.random.default_rng(seed)
    t = t_axis(n)
    ir = r.standard_normal((n, 2)) * np.exp(-t / decay)[:, None]
    ir = lp(ir, bright)
    ir[: int(0.012 * SR)] *= np.linspace(0, 1, int(0.012 * SR))[:, None]
    return ir / np.sqrt(np.sum(ir ** 2) / 2)

def reverb(x, ir, mix):
    wet = np.stack([signal.fftconvolve(x[:, c], ir[:, c])[: len(x)] for c in range(2)], axis=1)
    return x * (1 - mix * 0.5) + wet * mix

def noise(n):
    return rng.standard_normal(n)

def sat(x, drive=1.0):
    return np.tanh(x * drive) / np.tanh(drive)

# ─── score: tempo grid ───
SPB = 0.5               # seconds per beat (120 BPM)
BAR = 2.0

CH = {   # chord voicings (MIDI) and bass roots
    'D':  ([50, 57, 61, 64, 66], 38),     # Dmaj9
    'Bm': ([47, 54, 57, 62, 64], 35),     # Bm11
    'G':  ([43, 50, 54, 57, 61], 31),     # Gmaj9(#11)
    'A':  ([45, 52, 57, 59, 61], 33),     # A(add9, sus-ish)
    'Em': ([40, 47, 50, 55, 59], 28),     # Em7
}
# per-section chord plans: (chord, bars)
PLAN = [
    (18, [('D', 2), ('Bm', 2), ('G', 2), ('A', 2)]),
    (34, [('D', 2), ('Bm', 2), ('G', 1), ('A', 1)]),
    (46, [('Bm', 2), ('G', 2), ('D', 1), ('A', 1)]),
    (58, [('G', 2), ('D', 2), ('Bm', 1), ('A', 1)]),
    (70, [('D', 2), ('Bm', 2), ('G', 2), ('A', 1)]),
    (84, [('Bm', 2), ('G', 2), ('Em', 1), ('A', 1), ('D', 1)]),
    (98, [('D', 2), ('Bm', 2), ('G', 2), ('A', 2), ('A', 1)]),
]
CHORDS = []   # (t0, t1, name)
for start, seq in PLAN:
    t = start
    for name, bars in seq:
        CHORDS.append((t, t + bars * BAR, name))
        t += bars * BAR

def chord_at(t):
    for a, b, n in CHORDS:
        if a <= t < b:
            return n
    return None

music = np.zeros((N, 2))
drums = np.zeros((N, 2))
pads = np.zeros((N, 2))
synths = np.zeros((N, 2))
SECT = [0, 16, 18, 34, 46, 58, 70, 84, 98, 116, DUR]

# ─── drums ───
def kick(gain=1.0, tone=1.0):
    n = int(0.55 * SR)
    t = t_axis(n)
    f = 46 + 110 * np.exp(-t / 0.045) * tone
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.2)
    click = hp(noise(n), 3000) * np.exp(-t / 0.004) * 0.35
    return sat(body * 1.2 + click, 1.6) * gain

def clap(gain=1.0):
    n = int(0.45 * SR)
    t = t_axis(n)
    env = np.zeros(n)
    for d in (0, 0.011, 0.023):
        env += np.where(t >= d, np.exp(-(t - d) / 0.012), 0)
    env += np.where(t >= 0.03, 0.5 * np.exp(-(t - 0.03) / 0.12), 0)
    return bp(noise(n), 900, 5200) * env * 0.9 * gain

def hat(open_=False, gain=1.0):
    n = int((0.35 if open_ else 0.08) * SR)
    t = t_axis(n)
    return hp(noise(n), 7500, 4) * np.exp(-t / (0.11 if open_ else 0.022)) * gain * 0.75

def shaker(gain=1.0):
    n = int(0.09 * SR)
    t = t_axis(n)
    return bp(noise(n), 5000, 12000) * (t / 0.02 * np.exp(1 - t / 0.02)) * 0.35 * gain

def crash(gain=1.0):
    n = int(3.0 * SR)
    t = t_axis(n)
    x = hp(noise(n), 3500, 2) * np.exp(-t / 0.9)
    for f in (3240, 4410, 5630, 7220):
        x += 0.05 * np.sin(2 * np.pi * f * t) * np.exp(-t / 0.6)
    return x * 0.5 * gain

def snare(gain=1.0):
    n = int(0.25 * SR)
    t = t_axis(n)
    body = np.sin(2 * np.pi * 190 * t) * np.exp(-t / 0.05)
    return (bp(noise(n), 1500, 8000) * np.exp(-t / 0.07) * 0.8 + body * 0.5) * gain

KICKS = []   # kick times (for sidechain)

def section_drums(a, b, kick_beats, clap_on=True, hats=True, shake=True, opens=False, kgain=1.0):
    t = a
    beat = 0
    while t < b - 1e-6:
        bi = beat % 4
        if bi in kick_beats:
            add(drums, stereo(kick(0.55 * kgain)), t)
            KICKS.append(t)
        if clap_on and bi in (1, 3):
            add(drums, stereo(clap(0.55), 0.0, 0.0), t)
        if hats:
            add(drums, stereo(hat(open_=opens and bi % 2 == 1, gain=0.22), 0.25), t + SPB / 2)
        if shake:
            for k in range(4):
                add(drums, stereo(shaker(0.55 if k % 2 else 0.3), -0.3), t + k * SPB / 4)
        t += SPB
        beat += 1

def fill(t_end, bars=1.0):
    """Accelerating snare roll into t_end."""
    t = t_end - bars * BAR
    step = SPB / 2
    i = 0
    while t < t_end - 0.03:
        g = 0.2 + 0.6 * (1 - (t_end - t) / (bars * BAR))
        add(drums, stereo(snare(g * 0.6), 0.1 * (-1) ** i), t)
        step = max(SPB / 8, step * 0.9)
        t += step
        i += 1

# intro clock: 8ths, slowing through the sleep station, cut before the turn
def tick_click(gain, pitch=3000):
    n = int(0.05 * SR)
    t = t_axis(n)
    return (np.sin(2 * np.pi * pitch * t) * np.exp(-t / 0.006) + bp(noise(n), 2000, 9000) * np.exp(-t / 0.003) * 0.4) * gain

hard = [c['t'] for c in CUES['cues'] if c['kind'] == 'slam'][0] if any(c['kind'] == 'slam' for c in CUES['cues']) else 5.2
sleep_a = next((c['t'] for c in CUES['cues'] if c['kind'] == 'whoosh' and 8.5 < c['t'] < 9.2), 8.84)
t = 1.0
k = 0
while t < 15.85:
    in_sleep = sleep_a + 0.3 < t < 10.8
    acc = 1.0 if k % 2 == 0 else 0.55
    add(drums, stereo(tick_click(0.16 * acc, 2600 if k % 2 == 0 else 3400), 0.35 if k % 2 else -0.35), t)
    t += SPB * (2.0 if in_sleep else 0.5)
    k += 1
# intro low pulse: half-note heartbeat kicks from the setup station on
for tt in np.arange(4.0, 15.5, 1.0):
    add(drums, stereo(kick(0.3, tone=0.6)), tt)

# groove sections
section_drums(18.0, 34.0, kick_beats=(0, 2), clap_on=False, shake=True, kgain=0.85)
section_drums(34.0, 84.0, kick_beats=(0, 1, 2, 3))
section_drums(84.0, 86.0, kick_beats=(), clap_on=False, hats=True, shake=False)        # the failure: drums drop out
section_drums(86.0, 98.0, kick_beats=(0, 1, 2, 3))
section_drums(98.0, 115.5, kick_beats=(0, 1, 2, 3), opens=True, kgain=1.1)
for tt in (34, 46, 58, 70, 84, 98):
    add(drums, stereo(crash(0.55 if tt != 98 else 0.8), 0.15), tt)
fill(34.0, 0.5)
fill(98.0, 1.0)

# ─── harmony ───
def pad_note(m, dur, gain, cutoff=2600, soft=True):
    n = int((dur + 1.2) * SR)
    f = mtof(m)
    t = t_axis(n)
    x = np.zeros(n)
    for det, ph in ((-0.09, 0.1), (0.0, 0.37), (0.11, 0.71)):
        vib = 1 + 0.0012 * np.sin(2 * np.pi * (0.3 + det) * t + ph * 6)
        x += osc(f * (2 ** (det / 12)) * vib, n, pick_table(f, soft), ph)
    env = np.clip(t / 0.35, 0, 1) * np.clip((dur + 1.2 - t) / 1.2, 0, 1)
    return lp(x * env, cutoff) * gain / 3

def bass_note(m, dur, gain):
    n = int(dur * SR)
    f = mtof(m)
    t = t_axis(n)
    x = osc(f, n, TABLES[10]) * 0.8 + np.sin(2 * np.pi * f * t) * 0.45
    env = np.clip(t / 0.008, 0, 1) * np.exp(-t / 0.5) * 0.6 + 0.4 * np.clip(t / 0.01, 0, 1)
    env *= np.clip((dur - t) / 0.03, 0, 1)
    return lp(sat(x * env, 1.6), 1400) * gain

def pluck(m, gain, decay=0.22, bright=1.0):
    n = int(0.9 * SR)
    f = mtof(m)
    t = t_axis(n)
    x = np.zeros(n)
    for kk in range(1, 12):
        if f * kk > 15000:
            break
        x += np.sin(2 * np.pi * f * kk * t + kk) / kk * np.exp(-t * (1 / decay + kk * 2.2 / bright))
    return x * np.clip(t / 0.002, 0, 1) * gain

def bell(m, gain, decay=1.6):
    n = int(decay * 3 * SR)
    f = mtof(m)
    t = t_axis(n)
    mod = np.sin(2 * np.pi * f * 3.5 * t) * 2.2 * np.exp(-t / 0.4)
    x = np.sin(2 * np.pi * f * t + mod) * np.exp(-t / decay) + 0.3 * np.sin(2 * np.pi * f * 2.01 * t) * np.exp(-t / (decay * 0.5))
    return x * np.clip(t / 0.003, 0, 1) * gain

# intro: cold D-minor drone + a high, uneasy cluster
n_int = int(16.0 * SR)
ti = t_axis(n_int)
drone = (osc(mtof(38), n_int, SOFT[10]) * 0.5 + osc(mtof(45), n_int, SOFT[10]) * 0.35 + np.sin(2 * np.pi * mtof(26) * ti) * 0.5)
drone = lp(drone, 700) * np.clip(ti / 3.0, 0, 1) * np.clip((15.9 - ti) / 0.08, 0, 1) * 0.22
air = (np.sin(2 * np.pi * mtof(76) * ti) + np.sin(2 * np.pi * mtof(77) * ti * 1.0007)) * 0.025 * np.clip((ti - 4) / 6, 0, 1) * np.clip((15.9 - ti) / 0.1, 0, 1)
add(pads, stereo(drone, 0, 0.012), 0)
add(pads, stereo(air, 0.2, 0.017), 0)
# tension riser into the cut
n_r = int(2.9 * SR)
tr = t_axis(n_r)
rise = hp(noise(n_r), 600) * (tr / 2.9) ** 3 * 0.35
for i, m in enumerate((62, 63, 68)):
    rise += osc(mtof(m) * (1 + 0.5 * (tr / 2.9) ** 2), n_r, TABLES[6]) * (tr / 2.9) ** 2.5 * 0.05
rise = bp(rise, 300, 9000)
add(synths, stereo(rise, 0, 0.01), 13.0)

# groove: pads, bass, arps
ARP = [0, 2, 1, 3, 2, 4, 3, 1]
for a, b, name in CHORDS:
    notes, root = CH[name]
    dur = b - a
    lvl = 0.34 if a < 98 else 0.4
    for m in notes:
        add(pads, stereo(hp(pad_note(m, dur, lvl, cutoff=3600 if a < 98 else 5000), 160), rng.uniform(-0.5, 0.5), 0.011), a)
    # high octave shimmer on the climax
    if a >= 98:
        for m in notes[2:]:
            add(pads, stereo(pad_note(m + 12, dur, 0.05, cutoff=5000), rng.uniform(-0.7, 0.7), 0.013), a)
    # bass: driving 8ths (rests on the downbeat, the kick owns it)
    tt = a
    i = 0
    while tt < b - 1e-6:
        if a >= 34 or i % 2 == 1:
            g = 0.2 if i % 2 else 0.12
            if not (84 <= tt < 86):
                add(synths, stereo(bass_note(root + (12 if i % 8 == 7 else 0), SPB / 2 * 0.92, g)), tt)
        tt += SPB / 2
        i += 1
    # arp: 16ths from the UI scene on, sparse during the code scene
    if a >= 34 or a >= 26:
        tt = a
        j = 0
        while tt < b - 1e-6:
            if not (84 <= tt < 86):
                m = notes[ARP[j % 8] % len(notes)] + 12
                g = (0.16 if a < 98 else 0.2) * (1.0 if j % 4 == 0 else 0.7)
                p = pluck(m, g, decay=0.18, bright=0.9 + 0.3 * np.sin(tt * 0.7))
                add(synths, stereo(p, 0.45 * np.sin(j * 1.3), 0.0), tt)
            tt += SPB / 2 if a < 46 else SPB / 4
            j += 1

# features: a bell hook on each title hit, and chord stabs
feat_hits = [c['t'] for c in CUES['cues'] if c['kind'] in ('tick', 'hit') and 98 <= c['t'] < 115.5]
HOOK = [78, 76, 73, 74, 78, 81, 76, 73]
for i, th in enumerate(sorted(set(round(x, 2) for x in feat_hits))[:8]):
    add(synths, stereo(bell(HOOK[i % len(HOOK)], 0.16, 1.1), 0.25 * (-1) ** i, 0.008), th + 0.16)
    name = chord_at(th + 0.2) or 'D'
    for m in CH[name][0][1:]:
        add(synths, stereo(pluck(m + 12, 0.05, decay=0.35, bright=1.6), 0, 0.01), th + 0.16)

# the drop at BEAT and the final chord at 116
for m in CH['D'][0] + [74, 78]:
    add(pads, stereo(pad_note(m, 3.5, 0.12, cutoff=4200), rng.uniform(-0.6, 0.6), 0.012), BEAT)
for m in CH['D'][0] + [69, 74, 78, 81]:
    add(pads, stereo(pad_note(m, 6.5, 0.15, cutoff=3800), rng.uniform(-0.6, 0.6), 0.012), 116.0)
for i, m in enumerate((74, 78, 81, 86)):
    add(synths, stereo(bell(m, 0.08, 2.4), 0.3 * (-1) ** i, 0.01), 116.0 + i * 0.12)
for m in (26, 38):
    n2 = int(6 * SR)
    t2 = t_axis(n2)
    add(pads, stereo(np.sin(2 * np.pi * mtof(m) * t2) * np.exp(-t2 / 2.5) * 0.35), 116.0)

# ─── sidechain + mix ───
sc = np.ones(N)
for kt in KICKS:
    i0 = int(kt * SR)
    n = int(0.42 * SR)
    t = t_axis(n)
    g = 1 - 0.62 * np.exp(-t / 0.11) * np.clip(t / 0.004, 0, 1)
    seg = sc[i0:i0 + n]
    sc[i0:i0 + n] = np.minimum(seg, g[: len(seg)])
pads *= sc[:, None]
synths *= (0.35 + 0.65 * sc)[:, None]

IR_ROOM = make_ir(1.4, 0.35, 1, 7000)
IR_HALL = make_ir(4.0, 1.2, 2, 5000)
music = reverb(pads, IR_HALL, 0.35) + reverb(synths, IR_HALL, 0.22) + reverb(drums, IR_ROOM, 0.12)
# master bus: gentle glue
music = hp(music, 28)
music = sat(music * 1.3, 1.1) / 1.3

# ─── sound design ───
sfx = np.zeros((N, 2))

def whoosh(dur=0.5, gain=1.0, pan=0.0):
    n = int(dur * 1.6 * SR)
    t = t_axis(n)
    x = noise(n)
    k = np.clip(t / dur, 0, 1)
    env = np.sin(np.pi * np.clip(k, 0, 1)) ** 1.6 * np.exp(-np.maximum(0, t - dur) / 0.08)
    # sweep a band-pass by blending three fixed bands with a moving weight
    lo, mid, hi = bp(x, 200, 800), bp(x, 800, 3000), bp(x, 3000, 9000)
    c = np.sin(np.pi * k)
    y = lo * (1 - c) + mid * c + hi * c ** 2 * 0.7
    out = np.stack([y * env * (1 - 0.5 * (k - 0.5) * 2 * pan), y * env * (1 + 0.5 * (k - 0.5) * 2 * pan)], axis=1)
    return out * 0.5 * gain

def impact(gain=1.0, big=False):
    n = int((3.5 if big else 2.2) * SR)
    t = t_axis(n)
    f = 36 + 90 * np.exp(-t / 0.08)
    sub = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / (1.1 if big else 0.6))
    crack = hp(noise(n), 1200) * np.exp(-t / 0.05) * 0.6
    body = bp(noise(n), 80, 600) * np.exp(-t / 0.25) * 0.6
    x = sat(sub * 1.4 + crack + body, 1.5)
    return reverb(stereo(x, 0, 0.015), IR_HALL, 0.45) * gain

def tone_blip(f0, f1, dur, gain, wave=TABLES[1]):
    n = int(dur * SR)
    t = t_axis(n)
    f = f0 * (f1 / f0) ** (t / dur)
    return osc(f, n, wave) * np.exp(-t / (dur / 3)) * np.clip(t / 0.003, 0, 1) * gain

def make(kind, c):
    g = c.get('gain', 1.0)
    if kind == 'whoosh':
        return whoosh(c.get('dur', 0.5), g * 0.9, rng.uniform(-0.6, 0.6))
    if kind == 'swipe':
        return whoosh(0.28, g * 0.8, 0.5)
    if kind == 'slam':
        n = int(0.6 * SR); t = t_axis(n)
        x = np.sin(2 * np.pi * np.cumsum(70 * np.exp(-t / 0.2) + 40) / SR) * np.exp(-t / 0.16) + bp(noise(n), 400, 4000) * np.exp(-t / 0.03) * 0.7
        return reverb(stereo(sat(x, 1.3), rng.uniform(-0.3, 0.3)), IR_ROOM, 0.3) * g * 0.8
    if kind == 'glitch':
        n = int(0.07 * SR); t = t_axis(n)
        f = rng.choice([220, 440, 660, 1760])
        x = np.sign(np.sin(2 * np.pi * f * t)) * 0.4 + noise(n) * 0.3
        x = np.round(x * 4) / 4
        return stereo(x * np.exp(-t / 0.04), rng.uniform(-0.8, 0.8)) * g * 0.6
    if kind == 'boom':
        return impact(g * 1.1)
    if kind == 'shatter':
        n = int(1.2 * SR); out = np.zeros((n, 2))
        for i in range(40):
            d = rng.uniform(0, 0.45); fq = rng.uniform(2500, 9000)
            m = int(0.15 * SR); tt = t_axis(m)
            p = np.sin(2 * np.pi * fq * tt) * np.exp(-tt / rng.uniform(0.01, 0.05)) * rng.uniform(0.1, 0.4)
            add(out, stereo(p, rng.uniform(-1, 1)), d)
        tt = t_axis(n)
        add(out, stereo(hp(noise(n), 2000) * np.exp(-tt / 0.08) * 0.6), 0)
        return reverb(out, IR_ROOM, 0.4) * g
    if kind == 'shard':
        i = c.get('i', 0)
        w = whoosh(0.7, g * 0.7, (-0.7, -0.4, 0.7)[i])
        ping = stereo(bell(86 + i * 3, 0.06, 0.7), (-0.6, -0.3, 0.6)[i])
        out = np.zeros((max(len(w), len(ping) + int(0.5 * SR)), 2))
        add(out, w, 0); add(out, ping, 0.45)
        return reverb(out, IR_HALL, 0.4)
    if kind == 'swell':
        d = c.get('dur', 1.4)
        n = int(d * SR); t = t_axis(n)
        x = hp(noise(n), 300) * (t / d) ** 3 * 0.5
        for m in (62, 69, 74, 78):
            x += np.sin(2 * np.pi * mtof(m) * t) * (t / d) ** 4 * 0.06
        y = reverb(stereo(x, 0, 0.01), IR_HALL, 0.6)
        return y[:n] * np.clip((d - t) / 0.01, 0, 1)[:, None] * g
    if kind == 'impact':
        return impact(g, c.get('big', False))
    if kind == 'morph':
        n = int(0.7 * SR); t = t_axis(n)
        x = osc(300 * (8 ** (t / 0.7)), n, TABLES[10]) * np.sin(np.pi * t / 0.7) ** 2 * 0.15
        return reverb(stereo(bp(x, 300, 8000), 0, 0.012), IR_HALL, 0.4) * g + whoosh(0.6, g * 0.6, 0.3)[: n]
    if kind == 'key':
        n = int(0.03 * SR); t = t_axis(n)
        x = bp(noise(n), 1800, 6000) * np.exp(-t / 0.004) + np.sin(2 * np.pi * rng.uniform(900, 1300) * t) * np.exp(-t / 0.006) * 0.3
        return stereo(x * 0.5, rng.uniform(-0.2, 0.2)) * g
    if kind == 'pop':
        y = np.zeros(int(0.12 * SR)); add(y, tone_blip(600, 1100, 0.09, 0.35), 0); add(y, tone_blip(1200, 2200, 0.06, 0.12), 0.0)
        return stereo(y, 0.1) * g
    if kind == 'click':
        n = int(0.03 * SR); t = t_axis(n)
        x = bp(noise(n), 2000, 8000) * np.exp(-t / 0.002) + np.sin(2 * np.pi * 1800 * t) * np.exp(-t / 0.004) * 0.4
        return stereo(x * 0.6, 0.15) * g
    if kind == 'fold':
        out = np.zeros((int(0.8 * SR), 2))
        add(out, whoosh(0.35, 0.6, -0.4), 0)
        add(out, stereo(tone_blip(900, 300, 0.3, 0.12, TABLES[3]), 0), 0.1)
        return out * g
    if kind == 'thud':
        n = int(0.5 * SR); t = t_axis(n)
        x = np.sin(2 * np.pi * np.cumsum(55 + 60 * np.exp(-t / 0.03)) / SR) * np.exp(-t / 0.12)
        return stereo(x * 0.7, rng.uniform(-0.3, 0.3)) * g
    if kind == 'tick':
        n = int(0.4 * SR); t = t_axis(n)
        x = (np.sin(2 * np.pi * 1760 * t) + 0.5 * np.sin(2 * np.pi * 2640 * t)) * np.exp(-t / 0.06) * 0.25
        return reverb(stereo(x, 0.2), IR_ROOM, 0.25) * g
    if kind == 'land':
        n = int(1.0 * SR); t = t_axis(n)
        x = np.sin(2 * np.pi * np.cumsum(45 + 40 * np.exp(-t / 0.05)) / SR) * np.exp(-t / 0.3) + bp(noise(n), 100, 1500) * np.exp(-t / 0.15) * 0.4
        return reverb(stereo(x * 0.8), IR_HALL, 0.3) * g
    if kind == 'zap':
        n = int(0.45 * SR); t = t_axis(n)
        mod = np.sin(2 * np.pi * 80 * t) * 8
        x = np.sin(2 * np.pi * np.cumsum(400 + 2400 * np.exp(-t / 0.08)) / SR + mod) * np.exp(-t / 0.12) * 0.35
        return reverb(stereo(x, -0.2, 0.01), IR_ROOM, 0.3) * g
    if kind == 'send':
        out = np.zeros((int(1.2 * SR), 2))
        add(out, whoosh(0.7, 0.7, 0.8), 0)
        add(out, stereo(tone_blip(700, 1400, 0.12, 0.3), 0.5), 0.85)
        return out * g
    if kind == 'blip':
        out = np.zeros((int(0.4 * SR), 2))
        add(out, stereo(tone_blip(1320, 1320, 0.05, 0.2), -0.2), 0)
        add(out, stereo(tone_blip(1980, 1980, 0.06, 0.2), 0.2), 0.07)
        return out * g
    if kind == 'success':
        out = np.zeros((int(2.5 * SR), 2))
        for i, m in enumerate((74, 78, 81, 86)):
            add(out, stereo(bell(m, 0.12, 0.8), 0.3 * (i - 1.5)), i * 0.07)
        return reverb(out, IR_HALL, 0.35) * g
    if kind == 'fail':
        n = int(0.9 * SR); t = t_axis(n)
        x = (osc(mtof(46), n, TABLES[10]) + osc(mtof(47) * 1.003, n, TABLES[10])) * np.exp(-t / 0.35) * 0.18
        y = np.zeros(n)
        add(y, tone_blip(660, 660, 0.14, 0.25), 0); add(y, tone_blip(440, 440, 0.25, 0.25), 0.16)
        return reverb(stereo(lp(x, 2500) + y, 0, 0.01), IR_ROOM, 0.3) * g
    if kind == 'burst':
        out = np.zeros((int(2.0 * SR), 2))
        add(out, whoosh(0.5, 0.9, 0), 0)
        add(out, impact(0.35), 0.35)
        return out * g
    if kind == 'rewind':
        n = int(0.8 * SR); t = t_axis(n)
        x = np.zeros(n)
        for i in range(10):
            d = i * 0.07
            m = int(0.06 * SR); tt = t_axis(m)
            p = np.sin(2 * np.pi * (3000 - 2000 * tt / 0.06) * tt) * np.exp(-tt / 0.02) * 0.2
            add(x, p, d)
        return reverb(stereo(x, 0, 0.01), IR_ROOM, 0.3) * g
    if kind == 'hit':
        return impact(g * 0.6)
    if kind == 'riser':
        d = c.get('dur', 0.5); n = int(d * SR); t = t_axis(n)
        x = hp(noise(n), 1000) * (t / d) ** 2 * 0.5
        return stereo(x, 0, 0.01) * g
    if kind == 'shimmer':
        out = np.zeros((int(2.5 * SR), 2))
        for i, m in enumerate((86, 90, 93, 98)):
            add(out, stereo(bell(m, 0.05, 0.6), 0.4 * (i - 1.5)), i * 0.05)
        return reverb(out, IR_HALL, 0.5) * g
    return None

for c in CUES['cues']:
    x = make(c['kind'], c)
    if x is not None:
        add(sfx, x, c['t'])

# master levels
def norm(x, peak):
    return x * (peak / (np.max(np.abs(x)) + 1e-9))

music = norm(music, 0.7)
sfx = norm(sfx, 0.8)
fade = np.clip((DUR - t_axis(N)) / 1.5, 0, 1)[:, None]
music *= fade
sf.write('film/music.wav', music.astype(np.float32), SR, subtype='FLOAT')
sf.write('film/sfx.wav', sfx.astype(np.float32), SR, subtype='FLOAT')
print('music', music.shape, 'sfx', sfx.shape, 'kicks', len(KICKS), 'chords', len(CHORDS))
