#!/usr/bin/env python3
"""
Audio report: renders every sound of the procedural audio engine offline (OfflineAudioContext in headless
Chromium, driven through the Vite dev server), prints the levels per sound, checks them and writes a WAV
preview per sound to tests/audio-previews/ (gitignored).

  python3 scripts/audio-report.py                  # everything, starts its own dev server
  python3 scripts/audio-report.py --only block.    # only sounds whose name starts with this
  python3 scripts/audio-report.py --no-wav         # levels only (faster)
  python3 scripts/audio-report.py --url http://localhost:5173   # use a running dev server
  python3 scripts/audio-report.py --no-worst-case
  python3 scripts/audio-report.py --worst-only

Checks per sound: not silent (peak above -50 dBFS and RMS above the sound's minimum), no clipping
(peak < 0.98), no NaN. Then a worst-case scene (explosion + 16 players firing in rain with music) reports
peak, voices dropped by the limiter, main-thread scheduling cost per frame and the offline render speed.
Exit code 1 when any check fails. Listening is still up to a human: open the WAVs.
"""
import argparse
import base64
import math
import os
import socket
import subprocess
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'tests', 'audio-previews')
PEAK_MAX = 0.98
PEAK_MIN_DB = -50.0


def db(x):
    return 20 * math.log10(max(x, 1e-9))


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    p = s.getsockname()[1]
    s.close()
    return p


def start_server():
    port = free_port()
    proc = subprocess.Popen(['npx', 'vite', '--port', str(port), '--strictPort', '--host', '127.0.0.1'], cwd=ROOT,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    url = f'http://127.0.0.1:{port}'
    for _ in range(100):
        try:
            urllib.request.urlopen(url, timeout=1)
            return proc, url
        except Exception:
            time.sleep(0.3)
    proc.kill()
    sys.exit('dev server did not start')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--url')
    ap.add_argument('--only', default='')
    ap.add_argument('--no-wav', action='store_true')
    ap.add_argument('--no-worst-case', action='store_true')
    ap.add_argument('--worst-only', action='store_true', help='only the worst-case scene')
    args = ap.parse_args()

    proc = None
    url = args.url
    if not url:
        proc, url = start_server()
    os.makedirs(OUT, exist_ok=True)
    failures = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
            page = browser.new_page()
            # A blank page on the dev server's origin: the game itself would compete for the CPU.
            page.route('**/__audio.html', lambda route: route.fulfill(body='<!doctype html><title>audio</title>', content_type='text/html'))
            page.goto(url + '/__audio.html')
            page.evaluate("import('/src/core/audio/offlineRender.ts')")
            page.wait_for_function('window.__audio !== undefined', timeout=60000)
            names = page.evaluate('window.__audio.catalogNames()')
            names = [] if args.worst_only else [n for n in names if n['name'].startswith(args.only)]
            print(f"{'sound':36} {'peak':>7} {'rms':>7} {'active':>7} {'tail s':>7} {'ms':>6}  status")
            for n in names:
                name = n['name']
                r = page.evaluate('([n, w]) => window.__audio.renderOne(n, w)', [name, not args.no_wav])
                problems = []
                if r['nan']:
                    problems.append('NaN')
                if r['peak'] >= PEAK_MAX:
                    problems.append('CLIP')
                if db(r['peak']) < PEAK_MIN_DB:
                    problems.append('SILENT')
                if r['rmsDb'] < n['rmsMin']:
                    problems.append('TOO QUIET')
                status = 'ok' if not problems else ' '.join(problems)
                if problems:
                    failures.append((name, status))
                print(f"{name:36} {db(r['peak']):7.1f} {r['rmsDb']:7.1f} {r['activeRmsDb']:7.1f} {r['tailSeconds']:7.2f} {r['renderMs']:6.0f}  {status}")
                if not args.no_wav and r.get('wavBase64'):
                    with open(os.path.join(OUT, name + '.wav'), 'wb') as f:
                        f.write(base64.b64decode(r['wavBase64']))

            if not args.no_worst_case and (args.worst_only or not args.only):
                print('\nWorst case: explosion + 16 players firing SMGs (12 shots/s each) in rain, arcade pulse on, 6 s')
                w = page.evaluate('([w]) => window.__audio.renderWorstCase(6, w)', [not args.no_wav])
                print(f"  peak {db(w['peak']):.1f} dBFS ({w['peak']:.3f}), rms {w['rmsDb']:.1f} dBFS, NaN: {w['nan']}")
                print(f"  shots {w['shots']}, voices dropped {w['dropped']}, stolen {w['stolen']} (limit 64)")
                print(f"  main-thread scheduling {w['scheduleMsPerFrame']:.3f} ms per 60 Hz frame (budget 0.3), worst slice {w['worstSliceMs']:.2f} ms")
                print(f"  offline render {w['renderMs']:.0f} ms for 6000 ms of audio = {w['realtimeFactor']:.3f}x realtime (headless, software; proxy for audio thread load)")
                if w['peak'] >= PEAK_MAX or w['nan']:
                    failures.append(('worst-case', 'CLIP/NaN'))
                if w['scheduleMsPerFrame'] > 0.3:
                    failures.append(('worst-case', f"scheduling {w['scheduleMsPerFrame']:.2f} ms/frame > 0.3"))
                if not args.no_wav and w.get('wavBase64'):
                    with open(os.path.join(OUT, 'worst-case.wav'), 'wb') as f:
                        f.write(base64.b64decode(w['wavBase64']))
            browser.close()
    finally:
        if proc:
            proc.terminate()
    print(f"\n{len(failures)} problem(s)" + ''.join(f"\n  {n}: {s}" for n, s in failures))
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
