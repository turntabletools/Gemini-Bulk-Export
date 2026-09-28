// inspect-all-notebooks.js — what is on the /notebooks/view page?
// Run with Chrome open and logged in:  node inspect-all-notebooks.js
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes('gemini.google.com')) || ctx.pages()[0];

  await page.goto('https://gemini.google.com/notebooks/view', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);
  console.log('URL:', page.url());

  // Scroll the main region in case the grid is virtualised.
  for (let i = 0; i < 25; i++) {
    await page.evaluate(() => {
      const main = document.querySelector('bard-sidenav-content') || document.body;
      main.scrollTop = main.scrollHeight;
      window.scrollTo(0, document.body.scrollHeight);
      const last = document.querySelectorAll('bard-sidenav-content *');
      if (last.length) last[last.length - 1].scrollIntoView({ block: 'end' });
    });
    await page.waitForTimeout(400);
  }

  const dump = await page.evaluate(() => {
    const descr = (el) => {
      const a = {};
      for (const at of el.attributes) a[at.name] = at.value.slice(0, 70);
      return { tag: el.tagName.toLowerCase(), attrs: a };
    };
    // Everything OUTSIDE the left sidebar.
    const nav = document.querySelector('bard-sidenav');
    const outside = (el) => !nav || !nav.contains(el);

    // Custom elements in the main region only.
    const customEls = {};
    document.querySelectorAll('*').forEach((el) => {
      const t = el.tagName.toLowerCase();
      if (t.includes('-') && outside(el)) customEls[t] = (customEls[t] || 0) + 1;
    });

    // Links in the main region only.
    const links = [];
    document.querySelectorAll('a[href]').forEach((a) => {
      if (outside(a))
        links.push({ href: a.getAttribute('href'), label: (a.innerText || '').trim().slice(0, 50) });
    });

    // The visible text of the main region, so we can see how many notebooks
    // are actually listed even if we cannot yet select them.
    const main = document.querySelector('bard-sidenav-content');
    const mainText = main ? main.innerText.slice(0, 2500) : '(no bard-sidenav-content)';

    // Any element outside the nav that looks like a repeated card.
    const repeated = {};
    document.querySelectorAll('*').forEach((el) => {
      if (!outside(el)) return;
      const cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean).join('.');
      if (!cls) return;
      const key = el.tagName.toLowerCase() + '.' + cls.slice(0, 60);
      repeated[key] = (repeated[key] || 0) + 1;
    });
    const repeatedCards = Object.entries(repeated)
      .filter(([, n]) => n >= 3)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15);

    return { customEls, links, mainText, repeatedCards };
  });

  console.log('\n=== custom elements OUTSIDE the sidebar ===');
  console.log(JSON.stringify(dump.customEls, null, 1));
  console.log('\n=== links OUTSIDE the sidebar ===');
  console.log(JSON.stringify(dump.links, null, 1));
  console.log('\n=== repeated elements (possible notebook cards) ===');
  console.log(JSON.stringify(dump.repeatedCards, null, 1));
  console.log('\n=== visible text of main region ===');
  console.log(dump.mainText);

  browser.close();
})();
