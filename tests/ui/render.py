"""Render the renderer pages in Chromium with a mocked `window.flick` bridge.

Usage: python3 tests/ui/render.py <out_dir> [lang]
Produces PNG screenshots of the mini player, full-screen player (playing,
paused, idle) and the settings window. Dev-only helper, not shipped.
"""
import base64
import json
import pathlib
import subprocess
import sys

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'ui-shots')
LANG = sys.argv[2] if len(sys.argv) > 2 else 'ru'
OUT.mkdir(parents=True, exist_ok=True)

strings = json.loads(subprocess.check_output(
    ['node', '-e', f"process.stdout.write(JSON.stringify(require('./src/main/i18n').strings('{LANG}')))"], cwd=ROOT))
cover = 'data:image/jpeg;base64,' + base64.b64encode((ROOT / 'tests/ui/sample-cover.jpg').read_bytes()).decode()

settings = {
    'deviceName': 'Flick PC', 'language': 'auto', 'autostart': True, 'showMiniOnPlay': True,
    'autoFullscreen': False, 'fullscreenDisplay': 'auto', 'miniAlwaysOnTop': True, 'mediaKeys': True,
    'taperVolume': True, 'allowTakeover': True, 'video': True, 'videoFullscreen': True, 'audioSink': 'auto', 'autoUpdate': True,
}

def state(status, paused=False, title='Midnight City Lights', artist='Northern Echo', album='Late Drive'):
    return {
        'status': status, 'paused': paused, 'remoteAvailable': True,
        'device': {'deviceName': 'iPhone', 'deviceModel': 'iPhone15,2', 'deviceId': 'AA'},
        'title': title, 'artist': artist, 'album': album, 'trackVersion': 1, 'coverVersion': 1,
        'hasCover': True, 'position': 83, 'duration': 231, 'at': 0,
    }

MOCK = """
window.flick = {
  init: async () => (%s),
  command: async () => true, saveSettings: async (p) => p, restartEngine: async () => {}, openLogs: async () => {},
  openFull(){}, closeFull(){}, openSettings(){}, hideMini(){},
  onState(){}, onCover(){}, onEngine(){}, onRemote(){}, onRemoteError(){}, onDisplaysChanged(){},
  checkUpdate: async () => {}, installUpdate: async () => {}, onUpdate(){},
};
"""

def shot(page_name, size, init, out_name, wait=900, scale=2):
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={'width': size[0], 'height': size[1]}, device_scale_factor=scale)
        pg.add_init_script(MOCK % json.dumps(init))
        errors = []
        pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        pg.goto((ROOT / 'src/renderer' / page_name).as_uri())
        pg.wait_for_timeout(wait)
        pg.screenshot(path=str(OUT / out_name))
        b.close()
        if errors:
            print(out_name, 'ERRORS:', errors)
        else:
            print(out_name, 'ok')

base = {'strings': strings, 'lang': LANG, 'settings': settings, 'version': '0.2.3',
        'update': {'status': 'uptodate', 'version': '', 'percent': 0, 'current': '0.2.3', 'error': ''},
        'engine': {'state': 'running', 'error': '', 'networkWarning': ''},
        'displays': [{'id': '1', 'label': '1: 3440×1440 ★'}, {'id': '2', 'label': '2: 3840×2160'}], 'isFull': False}

shot('mini.html', (380, 160), {**base, 'state': state('playing'), 'cover': cover}, 'mini-playing.png')
shot('mini.html', (380, 160), {**base, 'state': state('paused', paused=True), 'cover': None}, 'mini-paused-nocover.png')
shot('full.html', (1920, 1080), {**base, 'state': state('playing'), 'cover': cover}, 'full-playing.png', 1800, 1)
shot('full.html', (1920, 1080), {**base, 'state': state('paused', paused=True), 'cover': cover}, 'full-paused.png', 1800, 1)
shot('full.html', (3440, 1440), {**base, 'state': state('playing', title='A Very Long Track Title That Should Wrap Onto Two Lines Nicely'), 'cover': cover}, 'full-ultrawide.png', 1800, 1)
shot('full.html', (1920, 1080), {**base, 'state': {'status': 'idle', 'position': 0, 'duration': 0}, 'cover': None}, 'full-idle.png', 900, 1)
shot('settings.html', (600, 1500), {**base, 'state': state('idle'), 'cover': None,
     'engine': {'state': 'running', 'error': '', 'networkWarning': strings['netPublic'].replace('{name}', 'Wi-Fi 5')}}, 'settings.png')
shot('settings.html', (600, 820), {**base, 'state': state('idle'), 'cover': None}, 'settings-clean.png')
