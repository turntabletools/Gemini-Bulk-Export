// scrape.js
// Scrapes all Gemini (gemini.google.com) conversations into individual .txt files,
// including conversations filed under Notebooks.
//
// USAGE:
//   1. Run launch-chrome.bat  -> opens a NORMAL Chrome with a debug port.
//   2. Log into Gemini in that window (no automation flags, so Google does not
//      show "this browser may not be secure").
//   3. node scrape.js         -> attaches to that already-logged-in window.
//
// Output: one .txt file per conversation in ./output/
// Re-runnable: conversations already saved are skipped.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = path.join(__dirname, 'output');
const CDP_URL = 'http://localhost:9222';

// Confirmed against the live DOM (see inspect.js):
//   Recents row = conversations-list a[href^="/app/"], aria-label holds the title
//   turns       = <user-query> and <model-response>, in document order
const ROW_SEL = 'conversations-list a[href^="/app/"]';

// Notebooks are a separate world. Conversations filed under one do NOT appear
// in Recents. Neither notebook cards nor the chat rows inside them are links --
// both are Angular components you have to click. Clicking a notebook card goes
// to /notebook/<uuid>; clicking a chat row inside goes to an ordinary
// /app/<id>, which renders exactly like any other conversation.
const NB_CARD_SEL = 'project-mgmt-row';
const NB_ROW_SEL = 'project-chat-row';
const NOTEBOOKS_URL = 'https://gemini.google.com/notebooks/view';

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim().slice(0, 120) || 'untitled';
}

// Scroll a virtualised list until its item count stops growing.
async function scrollUntilStable(page, sel, label) {
  let previous = -1;
  let stable = 0;
  for (let i = 0; i < 300; i++) {
    const count = await page.evaluate((s) => document.querySelectorAll(s).length, sel);
    if (count === previous) {
      // 6 quiet rounds, not 3: a slow fetch mid-list otherwise looks like the
      // end of the list and the scrape silently stops short.
      if (++stable >= 6) break;
    } else {
      stable = 0;
      process.stdout.write(`\r${label}: ${count}   `);
    }
    previous = count;
    await page.evaluate((s) => {
      const rows = document.querySelectorAll(s);
      const last = rows[rows.length - 1];
      if (last) last.scrollIntoView({ block: 'end' });
    }, sel);
    await page.waitForTimeout(700);
  }
  console.log(`\r${label}: ${previous} (settled)   `);
  return previous;
}

// Click the nth element matching sel, then wait for the URL to match.
//
// Two traps here, both learned the hard way:
//  - Every row also contains a "..." menu button. A naive
//    querySelector('button') finds THAT first and just opens a popover, so the
//    clickable body has to be picked explicitly and menus excluded.
//  - These are client-side route changes, so no 'load' event fires and
//    page.waitForURL() sits there until it times out. Poll the URL instead.
async function clickRowAndWait(page, sel, index, urlPattern, innerSel) {
  const before = page.url();
  await page.evaluate(
    ([s, i, inner]) => {
      const row = document.querySelectorAll(s)[i];
      if (!row) return;
      const isMenu = (el) =>
        el.closest('project-list-item-menu, conversation-action-menu, gem-popover, [aria-haspopup]');
      const target =
        (inner && row.querySelector(inner)) ||
        Array.from(row.querySelectorAll('[role="button"], button, a')).find((el) => !isMenu(el)) ||
        row;
      target.click();
    },
    [sel, index, innerSel || null]
  );

  for (let i = 0; i < 40; i++) {
    const url = page.url();
    if (url !== before && urlPattern.test(url)) return url;
    await page.waitForTimeout(500);
  }
  throw new Error(`click on ${sel}[${index}] did not navigate (still ${page.url()})`);
}

async function rowTitles(page, sel, titleSel) {
  return page.evaluate(
    ([s, t]) =>
      Array.from(document.querySelectorAll(s)).map((row) => {
        const el = t ? row.querySelector(t) : null;
        const text = (el || row).innerText || '';
        return text.trim().split('\n')[0].trim();
      }),
    [sel, titleSel]
  );
}

async function collectRecents(page) {
  await scrollUntilStable(page, ROW_SEL, 'Recents');
  return page.evaluate((sel) => {
    const seen = new Set();
    const out = [];
    document.querySelectorAll(sel).forEach((a) => {
      const id = a.getAttribute('href').split('/').pop();
      if (!id || seen.has(id)) return;
      seen.add(id);
      out.push({ id, title: (a.getAttribute('aria-label') || a.innerText || '').trim() });
    });
    return out;
  }, ROW_SEL);
}

// Notebook cards have no href, so each one must be clicked to learn its URL.
async function collectNotebooks(page) {
  await page.goto(NOTEBOOKS_URL, { waitUntil: 'domcontentloaded' });
  const present = await page
    .waitForSelector(NB_CARD_SEL, { timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  if (!present) {
    console.log('No notebooks found (or the page did not load).');
    return [];
  }
  await scrollUntilStable(page, NB_CARD_SEL, 'Notebooks');

  const titles = await rowTitles(page, NB_CARD_SEL, '.title');
  const notebooks = [];
  for (let i = 0; i < titles.length; i++) {
    try {
      if (i > 0) {
        await page.goto(NOTEBOOKS_URL, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector(NB_CARD_SEL, { timeout: 20000 });
      }
      await page.waitForTimeout(700);
      await clickRowAndWait(page, NB_CARD_SEL, i, /\/notebook\//, '.card-body, .project-card');
      notebooks.push({ url: page.url(), title: titles[i] || `notebook ${i + 1}` });
    } catch (err) {
      console.log(`  could not open notebook "${titles[i]}" -- ${err.message}`);
    }
  }
  return notebooks;
}

async function extractConversationText(page) {
  // Long chats lazy-load older turns as you scroll up.
  let previous = -1;
  let stable = 0;
  for (let i = 0; i < 100; i++) {
    const count = await page.evaluate(() => document.querySelectorAll('user-query').length);
    if (count === previous) {
      if (++stable >= 3) break;
    } else {
      stable = 0;
    }
    previous = count;
    await page.evaluate(() => {
      const first = document.querySelector('user-query');
      if (first) first.scrollIntoView({ block: 'start' });
    });
    await page.waitForTimeout(500);
  }

  return page.evaluate(() => {
    const parts = [];
    // One combined query => turns come back in document order.
    document.querySelectorAll('user-query, model-response').forEach((el) => {
      const isUser = el.tagName.toLowerCase() === 'user-query';
      // Drill into the content element so we skip buttons, disclaimers and
      // feedback widgets that live inside <model-response>.
      const body = el.querySelector(isUser ? 'user-query-content' : 'message-content') || el;
      const text = (body.innerText || '').trim();
      if (text) parts.push(`## ${isUser ? 'You' : 'Gemini'}\n\n${text}`);
    });
    return parts.join('\n\n---\n\n');
  });
}

(async () => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch (err) {
    console.log(`Could not attach to Chrome on ${CDP_URL}.`);
    console.log('Run launch-chrome.bat first, log into Gemini there, then re-run this script.');
    process.exit(1);
  }

  const context = browser.contexts()[0];
  const page =
    context.pages().find((p) => p.url().includes('gemini.google.com')) ||
    context.pages()[0] ||
    (await context.newPage());

  await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded' });
  const loggedIn = await page
    .waitForSelector(ROW_SEL, { timeout: 60000 })
    .then(() => true)
    .catch(() => false);
  if (!loggedIn) {
    console.log('No conversation links in the sidebar -- are you logged in?');
    process.exit(1);
  }

  // Resume: match on title, since the leading index shifts between runs.
  const done = new Set(fs.readdirSync(OUTPUT_DIR).map((f) => f.replace(/^\d+_/, '')));
  const seenIds = new Set();
  const failures = [];
  let seq = 0;
  let saved = 0;
  let skipped = 0;

  const write = (id, title) => {
    const safe = sanitizeFilename(title);
    const header = `${title}\nhttps://gemini.google.com/app/${id}\n\n${'='.repeat(60)}\n\n`;
    return { safe, header };
  };

  // Saves whatever conversation the page is currently showing.
  async function saveCurrent(title) {
    await page.waitForSelector('user-query', { timeout: 30000 });
    const id = page.url().split('/app/')[1].split(/[?#]/)[0];
    if (seenIds.has(id)) return 'dupe';
    seenIds.add(id);

    const text = await extractConversationText(page);
    if (!text) throw new Error('conversation rendered but extracted no turns');
    const { safe, header } = write(id, title);
    fs.writeFileSync(
      path.join(OUTPUT_DIR, `${String(++seq).padStart(4, '0')}_${safe}.txt`),
      header + text,
      'utf-8'
    );
    return 'saved';
  }

  // ---- 1. Recents -------------------------------------------------------
  const recents = await collectRecents(page);
  console.log(`\n${recents.length} conversations in Recents.\n`);

  for (let i = 0; i < recents.length; i++) {
    const { id, title } = recents[i];
    const safe = sanitizeFilename(title);
    seq = Math.max(seq, i);
    if (done.has(`${safe}.txt`)) {
      skipped++;
      seenIds.add(id);
      continue;
    }
    try {
      console.log(`[recents ${i + 1}/${recents.length}] ${safe}`);
      await page.goto(`https://gemini.google.com/app/${id}`, { waitUntil: 'domcontentloaded' });
      if ((await saveCurrent(title)) === 'saved') saved++;
    } catch (err) {
      console.log(`  FAILED -- ${err.message}`);
      failures.push({ id, title, error: err.message });
    }
  }

  // ---- 2. Notebooks -----------------------------------------------------
  const notebooks = await collectNotebooks(page);
  console.log(`\n${notebooks.length} notebook(s) to walk.\n`);

  for (const nb of notebooks) {
    await page.goto(nb.url, { waitUntil: 'domcontentloaded' });
    const hasRows = await page
      .waitForSelector(NB_ROW_SEL, { timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    if (!hasRows) {
      console.log(`"${nb.title}": no chats`);
      continue;
    }
    await scrollUntilStable(page, NB_ROW_SEL, `"${nb.title}"`);
    const titles = await rowTitles(page, NB_ROW_SEL, null);

    for (let i = 0; i < titles.length; i++) {
      const title = titles[i] || `${nb.title} chat ${i + 1}`;
      const safe = sanitizeFilename(title);
      // Checking the title BEFORE clicking means an already-exported chat
      // costs no page loads at all.
      if (done.has(`${safe}.txt`)) {
        skipped++;
        continue;
      }
      try {
        console.log(`[${nb.title} ${i + 1}/${titles.length}] ${safe}`);
        await page.goto(nb.url, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector(NB_ROW_SEL, { timeout: 20000 });
        await page.waitForTimeout(700);
        // The click lands us on the conversation, so extract it right here
        // rather than navigating to it a second time.
        await clickRowAndWait(page, NB_ROW_SEL, i, /\/app\/[0-9a-f]+/i);
        const result = await saveCurrent(title);
        if (result === 'saved') saved++;
        else skipped++; // already exported under a different notebook or Recents
      } catch (err) {
        console.log(`  FAILED -- ${err.message}`);
        failures.push({ notebook: nb.title, title, error: err.message });
      }
    }
  }

  console.log(`\nDone. Saved ${saved}, skipped ${skipped} already-present, ${failures.length} failed.`);
  if (failures.length) {
    fs.writeFileSync(path.join(__dirname, 'failures.json'), JSON.stringify(failures, null, 2));
    console.log('Failures written to failures.json -- re-run to retry them.');
  }
  browser.close(); // detach only -- your Chrome window stays open
  process.exit(0);
})();
