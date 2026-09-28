// inspect-notebooks.js — recon for notebook conversations.
// Does NOT navigate. Inspects whatever is on screen right now.
//
//   1. In the Chrome window, click into a notebook so you can see "Past chats".
//   2. node inspect-notebooks.js
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes('gemini.google.com')) || ctx.pages()[0];
  console.log('Current URL:', page.url());

  // Wait for the sidebar's notebook section, rather than assuming it is there.
  const found = await page
    .waitForFunction(
      () =>
        document.querySelectorAll('project-sidenav-list-item').length > 0 ||
        /All notebooks/i.test(document.body.innerText),
      { timeout: 30000 }
    )
    .then(() => true)
    .catch(() => false);
  console.log('Notebook section present:', found);

  const dump = await page.evaluate(() => {
    const descr = (el) => {
      const a = {};
      for (const at of el.attributes) a[at.name] = at.value.slice(0, 70);
      return { tag: el.tagName.toLowerCase(), attrs: a };
    };

    // (a) Custom elements whose name hints at notebooks/projects.
    const customEls = {};
    document.querySelectorAll('*').forEach((el) => {
      const t = el.tagName.toLowerCase();
      if (t.includes('-') && /project|notebook|gem|collection/.test(t))
        customEls[t] = (customEls[t] || 0) + 1;
    });

    // (b) EVERY distinct href on the page, grouped by URL shape.
    const shapes = {};
    document.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href');
      const shape = href.replace(/[0-9a-f]{8,}/gi, '<ID>');
      (shapes[shape] = shapes[shape] || []).push({
        href,
        label: (a.getAttribute('aria-label') || a.innerText || '').trim().slice(0, 55),
      });
    });
    const shapeSummary = {};
    for (const [k, v] of Object.entries(shapes))
      shapeSummary[k] = { count: v.length, sample: v.slice(0, 3) };

    // (c) The "Past chats" region, if visible.
    const all = Array.from(document.querySelectorAll('*'));
    const heading = all.find(
      (el) => !el.children.length && /^past chats$/i.test((el.textContent || '').trim())
    );
    let pastChats = 'NO "Past chats" heading on this page';
    if (heading) {
      let box = heading.parentElement;
      for (let i = 0; i < 8 && box; i++) {
        if (box.querySelectorAll('a[href]').length >= 2) break;
        box = box.parentElement;
      }
      // If there are no <a> at all, the rows are clickable non-links; describe them.
      const rows = box ? Array.from(box.querySelectorAll('a[href]')) : [];
      if (rows.length) {
        pastChats = {
          mode: 'links',
          container: descr(box),
          rows: rows.slice(0, 8).map((a) => ({
            href: a.getAttribute('href'),
            label: (a.getAttribute('aria-label') || a.innerText || '').trim().slice(0, 55),
          })),
        };
      } else {
        let b = heading.parentElement;
        for (let i = 0; i < 8 && b; i++) {
          if (b.children.length >= 2) break;
          b = b.parentElement;
        }
        pastChats = {
          mode: 'NOT links — clickable rows',
          container: b ? descr(b) : null,
          children: b
            ? Array.from(b.children).slice(0, 8).map((c) => ({
                ...descr(c),
                text: (c.innerText || '').trim().slice(0, 55),
              }))
            : [],
        };
      }
    }

    return { customEls, shapeSummary, pastChats };
  });

  console.log('\n=== notebook-ish custom elements ===');
  console.log(JSON.stringify(dump.customEls, null, 1));
  console.log('\n=== all link shapes on page ===');
  console.log(JSON.stringify(dump.shapeSummary, null, 1));
  console.log('\n=== "Past chats" ===');
  console.log(JSON.stringify(dump.pastChats, null, 1));

  browser.close();
})();
