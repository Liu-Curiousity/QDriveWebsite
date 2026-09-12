"""Pixel-level regression for full-width navigation blur (local browser only)."""
import argparse
import base64
import json
from pathlib import Path
from playwright.sync_api import sync_playwright


def sample(page, screenshot, boxes):
    return page.evaluate("""async ({png, boxes}) => {
      const img = new Image(); img.src = 'data:image/png;base64,' + png;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.width; canvas.height = img.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
      return boxes.map(({x, y, width}) => {
        const data = ctx.getImageData(x, y, width, 1).data;
        const values = [];
        for (let i = 0; i < data.length; i += 4)
          values.push((data[i] + data[i + 1] + data[i + 2]) / 3);
        return Math.max(...values) - Math.min(...values);
      });
    }""", {"png": base64.b64encode(screenshot).decode(), "boxes": boxes})


def inspect(page):
    return page.evaluate("""() => {
      const header = document.querySelector('header.site-header');
      const frost = header.querySelector('.site-header-frost');
      const cs = getComputedStyle(header);
      return {header: header.getBoundingClientRect().toJSON(),
        frost: frost.getBoundingClientRect().toJSON(),
        viewport: document.body.clientWidth,
        backdrop: getComputedStyle(frost).backdropFilter,
        ancestor: {backdrop: cs.backdropFilter, willChange: cs.willChange,
          opacity: cs.opacity, transform: cs.transform}};
    }""")


def check(page, url, width, theme, artifacts, diagnose):
    is_home = url.endswith(':4322/')
    page.set_viewport_size({"width": width, "height": 900})
    page.emulate_media(color_scheme=theme)
    page.goto(url, wait_until="networkidle")
    page.wait_for_selector('header.site-header', state='visible')
    page.wait_for_timeout(850)
    if width <= 980:
        toggle = page.locator('.site-nav-toggle')
        toggle.click()
        assert toggle.get_attribute('aria-expanded') == 'true'
        assert page.locator('#site-navigation').is_visible()
        toggle.click()
        assert toggle.get_attribute('aria-expanded') == 'false'
        assert not page.locator('#site-navigation').is_visible()
    else:
        item = page.locator('.site-header .nav-item').filter(
            has=page.locator('a[href="/products/qd4310"]'))
        item.locator('button.nav-link').hover()
        item.locator('.nav-item-popover').wait_for(state='visible')
        page.mouse.move(1, 200)
        item.locator('.nav-item-popover').wait_for(state='hidden')
    page.add_style_tag(content='html { scroll-behavior: auto !important; }')
    # Interior headers are sticky/fixed and are tested after scrolling. The
    # landing-page header intentionally remains in normal flow, so sample it
    # at the top of the document instead.
    if not is_home:
        page.evaluate('window.scrollTo(0, 280)')
    else:
        page.evaluate('window.scrollTo(0, 280)')
        moved_header_top = page.locator('header.site-header').evaluate(
            '(element) => element.getBoundingClientRect().top')
        assert moved_header_top < -1, ('Home header should scroll with document', moved_header_top)
        page.evaluate('window.scrollTo(0, 0)')
    page.wait_for_timeout(100)
    state = inspect(page)
    if diagnose:
        print(page.locator('.site-header-frost').evaluate("""e => {
          const result=[]; for(let a=e;a;a=a.parentElement){
            const s=getComputedStyle(a); result.push({tag:a.tagName,cls:a.className,
              filter:s.filter,backdrop:s.backdropFilter,opacity:s.opacity,
              willChange:s.willChange,isolation:s.isolation,transform:s.transform,
              contain:s.contain,clip:s.clipPath,blend:s.mixBlendMode}); }
          return result;
        }"""))
    label = url.split(':4322')[-1].strip('/').replace('/', '-') or 'home'
    prefix = f'{label}-{width}-{theme}'
    artifacts.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(artifacts / f'{prefix}-page.png'))
    page.evaluate("""() => {
      const probe = document.createElement('div');
      probe.dataset.frostProbe = '';
      Object.assign(probe.style, {position:'fixed', top:'-120px', left:'-120px', right:'-120px',
        height:'320px', zIndex:'100', pointerEvents:'none',
        background:'repeating-linear-gradient(90deg,#111 0 8px,#eee 8px 16px)'});
      document.querySelector('.page').append(probe);
    }""")
    page.add_style_tag(content='header.site-header > :not(.site-header-frost) { visibility:hidden !important; }')
    page.wait_for_timeout(250)
    # Sample outside the content rail but away from viewport clipping pixels.
    edge = max(16, min(24, int(state['header']['left']) - 36))
    right = state['viewport']
    inset = 36 if width > 980 else 12
    boxes = [{"x": x, "y": int(state['header']['height'] * .72), "width": edge}
             for x in (inset, int(right / 2), right - edge - inset)]
    shot = page.screenshot(path=str(artifacts / f'{prefix}-probe.png'))
    blurred = sample(page, shot, boxes)
    # A direct viewport-level reference calibrates Chromium's blur at screen
    # edges. Compare rendered pixels, not just the declared CSS filter value.
    page.evaluate("""() => {
      const frost = document.querySelector('.site-header-frost');
      const rect = frost.getBoundingClientRect();
      const cs = getComputedStyle(frost);
      const reference = document.createElement('div');
      reference.dataset.frostReference = '';
      Object.assign(reference.style, {position:'fixed', left:rect.left + 'px',
        top:rect.top + 'px', width:rect.width + 'px', height:rect.height + 'px',
        zIndex:'200', background:cs.backgroundColor, backdropFilter:cs.backdropFilter});
      document.body.append(reference);
      frost.style.visibility = 'hidden';
    }""")
    reference = sample(page, page.screenshot(path=str(artifacts / f'{prefix}-reference.png')), boxes)
    page.evaluate("""() => {
      document.querySelector('[data-frost-reference]').remove();
      document.querySelector('.site-header-frost').style.removeProperty('visibility');
    }""")
    page.add_style_tag(content='header.site-header, .site-header-frost { backdrop-filter:none !important; -webkit-backdrop-filter:none !important; }')
    sharp = sample(page, page.screenshot(), boxes)
    print(json.dumps({"page":prefix, **state, "contrast_left_center_right":blurred,
                      "no_blur_control":sharp, "reference":reference}), flush=True)
    if not diagnose:
        if not is_home:
            assert abs(state['header']['top']) < 1, state
        else:
            assert abs(state['header']['top']) < 1, state
        assert state['frost']['left'] <= 1 and state['frost']['right'] >= right - 1, state
        assert state['ancestor']['backdrop'] == 'none', state
        assert state['ancestor']['willChange'] == 'auto', state
        assert 'blur(' in state['backdrop'], state
        for residual, control, expected in zip(blurred, sharp, reference):
            assert control > 30, ('Probe must be visible beneath the header', prefix, sharp)
            assert residual < control * .6, ('Unblurred region', prefix, blurred, sharp)
            assert abs(residual - expected) <= 2, ('Not a uniform full-width surface', prefix, blurred, reference)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default='http://127.0.0.1:4322')
    parser.add_argument('--artifacts', type=Path, default=Path('.ui-craft/header-frost'))
    parser.add_argument('--diagnose', action='store_true')
    args = parser.parse_args()
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        try:
            for path in (['/'] if args.diagnose else ['/', '/about', '/account', '/solutions/qgimbal']):
                for width in ([1440] if args.diagnose else [1440, 390]):
                    for theme in (['light'] if args.diagnose else ['light', 'dark']):
                        check(page, args.base_url + path, width, theme, args.artifacts, args.diagnose)
        finally:
            browser.close()


if __name__ == '__main__':
    main()
