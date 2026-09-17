#!/usr/bin/env python3
"""Retime screencast frames into mp4 clips via ffmpeg concat demuxer.

Builds whichever clips have source frames present:
  rec-frames/   -> clip-trace.mp4
  multi-frames/ -> clip-multi.mp4 (two-device chat test: run, both mirrors
                   acting, then the two-pane trace + network tab)
  ui-frames/  -> clip-ui.mp4 (3 segments: setup, compressed run with actions
                 streaming in one by one, results exploration)
              -> clip-ui-session.mp4 (full session, lightly retimed archive
                 so future re-cuts don't require a simulator)
"""
import json, os, subprocess

def build(frames_dir, out, segments, size='1920x1200', vf_pre=None):
    meta = json.load(open(f'{frames_dir}/meta.json'))
    frames = meta['frames'] if isinstance(meta, dict) else meta
    lines = []
    total = 0.0
    for t0, t1, cap, speed in segments:
        sel = [f for f in frames if t0 <= f['t'] <= t1]
        acc = 0.0
        for a, b in zip(sel, sel[1:] + [None]):
            dt = (b['t'] - a['t']) if b else 0.15
            acc += min(dt, cap) / speed
            # decimate: only emit once enough retimed time has accumulated
            if acc < 1 / 45: continue
            lines.append(f"file '{frames_dir}/f{a['idx']:05d}.jpg'\nduration {acc:.4f}")
            total += acc
            acc = 0.0
    last = lines[-1].split('\n')[0]
    lines.append(last)
    # where each segment starts in the finished clip (for syncing comp.html beats)
    acc_t, starts = 0.0, []
    for t0, t1, cap, speed in segments:
        starts.append(round(acc_t, 2))
        sel = [f for f in frames if t0 <= f['t'] <= t1]
        acc_t += sum(min(b['t'] - a['t'], cap) for a, b in zip(sel, sel[1:])) / speed
    print(f'{out}: segment starts {starts}')
    open(f'{out}.txt', 'w').write('\n'.join(lines) + '\n')
    vf = (f'{vf_pre},' if vf_pre else '') + f'scale={size}:flags=lanczos,fps=30'
    subprocess.run(['ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', f'{out}.txt',
                    '-vf', vf, '-c:v', 'libx264', '-crf', '17',
                    '-pix_fmt', 'yuv420p', '-preset', 'medium', f'{out}.mp4'],
                   check=True, capture_output=True)
    d = subprocess.run(['ffprobe', '-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', f'{out}.mp4'],
                       capture_output=True, text=True).stdout.strip()
    print(f'{out}.mp4 {float(d):.2f}s (target {total:.2f}s)')
    return total

if os.path.exists('rec-frames/meta.json'):
    tmeta = json.load(open('rec-frames/meta.json'))
    t0, t1 = tmeta[0]['t'], tmeta[-1]['t']
    build('rec-frames', 'clip-trace', [(t0, t1, 0.45, 1.5)])

if os.path.exists('ui-frames/meta.json'):
    umeta = json.load(open('ui-frames/meta.json'))
    m = umeta['marks']
    tend = umeta['frames'][-1]['t']
    # Three segments; total must stay ~23.6s so the comp timeline (S3 spans
    # 24.6-43.8 at UI_RATE 1.18 with a 0.4s lead-in) is unchanged. Each
    # segment's speed is solved from its capped raw length and a target
    # duration, so a faster or slower live run lands on the same cut.
    def capped(t0, t1, cap):
        sel = [f for f in umeta['frames'] if t0 <= f['t'] <= t1]
        return sum(min(b['t'] - a['t'], cap) for a, b in zip(sel, sel[1:])) + 0.15
    bounds = [
        (m['typing'] - 1.0, m['runClicked'] + 1.5, 0.26, 6.0),    # filter + expand + click run
        (m['runClicked'] + 1.5, m['passed'] - 1.2, 0.45, 4.0),    # actions stream in (near real time)
        (m['passed'] - 1.2, tend, 0.38, 13.6),                    # results: action, Network tab, response
    ]
    segs = [(t0, t1, cap, max(0.5, capped(t0, t1, cap) / target)) for t0, t1, cap, target in bounds]
    print('ui segment speeds:', [round(sp, 2) for *_, sp in segs])
    build('ui-frames', 'clip-ui', segs)
    # Archive: whole session, near-real pacing with idle gaps capped.
    build('ui-frames', 'clip-ui-session', [(umeta['frames'][0]['t'], tend, 0.6, 1.0)])

if os.path.exists('mcp-frames/meta.json'):
    mmeta = json.load(open('mcp-frames/meta.json'))
    mk = mmeta['marks']
    # Right-column story: panel opens -> agent connects -> list -> run -> pass
    # -> expanded result. Beats loosely sync the synthetic agent window in s35.
    # The card plays from S+2.6 to the end of the 17.0s scene, so the clip
    # should total ~14.4s; speeds are solved from per-segment targets.
    def mcapped(t0, t1, cap):
        sel = [f for f in mmeta['frames'] if t0 <= f['t'] <= t1]
        return sum(min(b['t'] - a['t'], cap) for a, b in zip(sel, sel[1:])) + 0.15
    mbounds = [
        (mk['mcpOpened'] - 0.7, mk['connected'] + 0.6, 0.4, 3.1),     # panel opens, agent connects
        (mk['connected'] + 0.6, mk['runStarted'] + 0.8, 0.4, 4.6),    # list_tests + snapshot feed entries
        (mk['runStarted'] + 0.8, mk['passed'] - 1.2, 0.5, 2.6),       # run streams, mirror animates
        (mk['passed'] - 1.2, mk['passed'] + 1.6, 0.4, 2.2),           # green
        (mk['passed'] + 1.6, mk['expanded'] + 0.9, 0.5, 1.9),         # expanded result entry
    ]
    segs = [(t0, t1, cap, max(0.5, mcapped(t0, t1, cap) / target)) for t0, t1, cap, target in mbounds]
    print('mcp segment speeds:', [round(sp, 2) for *_, sp in segs])
    build('mcp-frames', 'clip-mcp', segs, size='608x1896',
          vf_pre='crop=608:1896:2592:104')
    # Archive: full-frame session at near-real pacing for future re-crops.
    build('mcp-frames', 'clip-mcp-session', [(mmeta['frames'][0]['t'], mmeta['frames'][-1]['t'], 0.6, 1.0)])

if os.path.exists('pick-frames/meta.json'):
    pmeta = json.load(open('pick-frames/meta.json'))
    pk = pmeta['marks']
    pend = pmeta['frames'][-1]['t']
    # Selector playground: chip click -> hovers with green highlight -> pick ->
    # locator list fills -> option interactions. Target ~10.9s.
    # Speeds solved from per-segment targets (total ~11.2s = the S3.7 scene).
    def pcapped(t0, t1, cap):
        sel = [f for f in pmeta['frames'] if t0 <= f['t'] <= t1]
        return sum(min(b['t'] - a['t'], cap) for a, b in zip(sel, sel[1:])) + 0.15
    pbounds = [
        (pk['start'] + 0.2, pk['pickOn'] + 0.7, 0.4, 1.5),           # pick toggle
        (pk['pickOn'] + 0.7, pk['hover1'] - 1.2, 0.4, 1.0),          # glide onto the mirror
        (pk['hover1'] - 1.2, pk['picked'] + 0.4, 0.45, 3.7),         # hovers with green highlight, pick
        (pk['picked'] + 0.4, pk['picked'] + 2.2, 0.4, 1.8),          # locator list fills
        (pk['picked'] + 2.2, pk['optionClicked'] + 0.8, 0.45, 2.3),  # second option: live re-match
        (pk['optionClicked'] + 0.8, pend, 0.45, 0.9),                # back to first, rest
    ]
    psegs = [(t0, t1, cap, max(0.5, pcapped(t0, t1, cap) / target)) for t0, t1, cap, target in pbounds]
    print('pick segment speeds:', [round(sp, 2) for *_, sp in psegs])
    build('pick-frames', 'clip-pick', psegs)
    build('pick-frames', 'clip-pick-session', [(pmeta['frames'][0]['t'], pend, 0.6, 1.0)])

if os.path.exists('mcp-frames/meta.json'):
    fmeta = json.load(open('mcp-frames/meta.json'))
    fm = fmeta['marks']
    # Full-window intro for the MCP scene: the whole UI visible while the
    # panel opens, so the zoom-in makes clear the card is a crop of UI mode.
    build('mcp-frames', 'clip-mcp-full', [(fm['mcpOpened'] - 0.8, fm['connected'] + 1.6, 0.45, 1.15)])

if os.path.exists('multi-frames/meta.json'):
    dmeta = json.load(open('multi-frames/meta.json'))
    dk = dmeta['marks']
    dend = dmeta['frames'][-1]['t']
    # Multi-device: click run -> both devices act (compressed, but slow enough
    # to read the chat bubbles landing) -> pass -> two-pane trace -> network.
    # Target ~13.0s to match comp.html's S3.8 scene at MULTI_RATE=1.0.
    def dcapped(t0, t1, cap):
        sel = [f for f in dmeta['frames'] if t0 <= f['t'] <= t1]
        return sum(min(b['t'] - a['t'], cap) for a, b in zip(sel, sel[1:])) + 0.15
    dbounds = [
        (dk['start'], dk['runClicked'] + 0.8, 0.4, 1.6),                 # hover the test, click run
        (dk['runClicked'] + 0.8, dk['passed'] - 1.0, 0.5, 6.4),          # both devices act, messages cross
        (dk['passed'] - 1.0, dk['actionSelected'] + 0.6, 0.45, 1.9),     # green, select bob's assertion
        (dk['actionSelected'] + 0.6, dend, 0.5, 3.0),                    # two panes, Network tab per device
    ]
    dsegs = [(t0, t1, cap, max(0.5, dcapped(t0, t1, cap) / target)) for t0, t1, cap, target in dbounds]
    print('multi segment speeds:', [round(sp, 2) for *_, sp in dsegs])
    build('multi-frames', 'clip-multi', dsegs)
    build('multi-frames', 'clip-multi-session', [(dmeta['frames'][0]['t'], dend, 0.6, 1.0)])
