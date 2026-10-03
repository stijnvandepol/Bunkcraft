"""
Loads the production build under the server's CSP, starts a singleplayer world (chunk workers, WebGL, fonts,
blob textures) and reports every CSP violation and page error.

  PORT=3100 npm start &            # needs `npm run build` first
  python3 scripts/security/csp-smoke.py [http://127.0.0.1:3100]
"""
import sys
import time

from playwright.sync_api import sync_playwright

url = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:3100'
problems = []

with sync_playwright() as p:
    browser = p.chromium.launch(args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    page = browser.new_page(viewport={'width': 1000, 'height': 600})
    page.on('console', lambda m: problems.append(f'console {m.type}: {m.text}') if m.type in ('error', 'warning') else None)
    page.on('pageerror', lambda e: problems.append(f'pageerror: {e}'))
    page.add_init_script("""
      window.__csp = [];
      document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
    """)
    page.goto(url)
    page.wait_for_selector('button')
    time.sleep(1)
    for label in ['Singleplayer', 'Create New World', 'Create New World']:
        btn = page.get_by_role('button', name=label).first
        if btn.count():
            btn.click()
            time.sleep(0.5)
    t0 = time.time()
    state = None
    while time.time() - t0 < 40:
        page.bring_to_front()
        state = page.evaluate("typeof window.game === 'object' && window.game.state ? window.game.state : (document.querySelector('canvas') ? 'canvas' : 'none')")
        if state in ('playing', 'paused'):
            break
        time.sleep(1)
    time.sleep(3)
    violations = page.evaluate('window.__csp')
    shot = '/private/tmp/claude-501/csp-smoke.png'
    page.screenshot(path=shot)
    print('state:', state, '| screenshot:', shot)
    print('CSP violations:', violations)
    print('console problems:', problems)
    browser.close()
sys.exit(1 if violations else 0)
