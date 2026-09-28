# Gemini Conversation Export

Exports every conversation from [gemini.google.com](https://gemini.google.com) into
individual `.txt` files — one file per chat, in `output/`.

Covers both your **Recents** list and chats filed under **Notebooks** (which don't
appear in Recents and are easy to miss).

Windows. Node.js + Playwright.

(The scraping logic is cross-platform; only `launch-chrome.bat` is
Windows-specific. On macOS/Linux, launch Chrome yourself with
`--remote-debugging-port=9222 --user-data-dir=./chrome-cdp-profile` and the rest
works unchanged.)

---

## Why it works this way

Google blocks sign-in inside automation-controlled browsers ("This browser or app
may not be secure"). It detects the automation flags Playwright sets when it
launches Chrome itself — it doesn't matter whose cookies you load.

So this tool never logs in from automation. You launch a **normal** Chrome with a
debug port open, sign in by hand like any other day, and the script **attaches** to
that already-authenticated window. Google only ever sees a regular browser doing
a regular login.

---

## One-time setup

1. **Install Node.js** — https://nodejs.org (LTS is fine).

2. **Install dependencies.** In this folder:

   ```
   npm install
   ```

3. **Install the Playwright browser bits** (only needed once):

   ```
   npx playwright install chromium
   ```

You also need Google Chrome installed in the normal place
(`C:\Program Files\Google\Chrome\Application\chrome.exe`).

---

## Running an export

### Step 1 — Launch Chrome with the debug port

Double-click **`launch-chrome.bat`**, or run it from a terminal:

```
launch-chrome.bat
```

A Chrome window opens at Gemini. This is a *separate, dedicated* Chrome profile
stored in `chrome-cdp-profile/` — it won't touch your everyday browsing.

> If Chrome opens but the script later can't connect, close **all** Chrome windows
> and run the .bat again. Chrome ignores the debug port if another instance is
> already running.

### Step 2 — Log in

Sign into your Google account in that window. Normal login, no tricks.

Wait until your chat history is visible in the left sidebar. **Leave this window
open** for the whole export.

### Step 3 — Run the scraper

In a terminal, in this folder:

```
node scrape.js
```

It will:

1. Scroll the sidebar until the full Recents list has loaded.
2. Open each notebook and work out the URL of every chat inside it.
3. Visit each conversation by its real URL (`/app/<id>`).
4. Scroll each chat up until all older turns have lazy-loaded.
5. Write it to `output/NNNN_Conversation Title.txt`.

Expect roughly **5 seconds per conversation** — about 25 minutes for 300 chats.
Notebook chats cost an extra page load each during step 2, because the rows in a
notebook carry no link of their own; the script has to click one to find out
where it goes.
Progress prints as it goes. Don't use that Chrome window while it runs.

---

## Output format

```
How Do Sourdough Starters Work
https://gemini.google.com/app/a1b2c3d4e5f6a7b8

============================================================

## You

Why does my starter smell like acetone?

---

## Gemini

That acetone note means it's hungry...
```

Feedback buttons, share widgets and the "Gemini can make mistakes" disclaimers
are stripped out — just the actual turns.

---

## Re-running / resuming

Safe to run again any time. Conversations already in `output/` are skipped
(matched on title), so an interrupted run picks up where it left off.

Anything that failed is written to `failures.json`. Just run `node scrape.js`
again to retry those.

To force a completely fresh export, delete the output folder first:

```
rmdir /s /q output
```

---

## Verifying it worked

The failure mode to watch for is every file coming out identical. Check that the
number of unique files matches the number of conversations:

```
powershell -c "(Get-FileHash output\*.txt).Hash | Sort-Object -Unique | Measure-Object | Select Count"
```

If that count is small (like 3) while `output/` has hundreds of files, the
selectors have broken — see below.

---

## Troubleshooting

**`Could not attach to Chrome on http://localhost:9222`**
Chrome isn't running with the debug port. Close every Chrome window, run
`launch-chrome.bat`, and try again.

**`No conversation links in the sidebar — are you logged in?`**
You're on the Gemini page but signed out, or it hasn't finished loading. Log in
in the Chrome window, wait for the sidebar, re-run.

**All output files are identical, or every conversation fails**
Google changed Gemini's HTML. Run the recon script to see the current structure:

```
node inspect.js               # Recents sidebar + a conversation
node inspect-all-notebooks.js # the /notebooks/view grid
node inspect-notebooks.js     # a single notebook (open one in Chrome first)
```

It prints the sidebar row's element chain and which custom elements hold the
message turns. The selectors to update are at the top of `scrape.js` (`ROW_SEL`)
and inside `extractConversationText`. As of the last working run they were:

| What | Selector |
|---|---|
| Recents row | `conversations-list a[href^="/app/"]` (title in `aria-label`, id in `href`) |
| Notebook card | `/notebooks/view`, then `project-mgmt-row` (title in `.title`) — **no href**; clicking navigates to `/notebook/<uuid>` |
| Notebook chat row | `project-chat-row` — **no href**; clicking navigates to `/app/<id>` |

> The two pinned notebooks in the sidebar *are* `<a href="/notebook/...">` links.
> Don't enumerate notebooks with that selector — it silently matches only the
> pinned ones and misses the rest. Use `project-mgmt-row` on `/notebooks/view`.

| Your turns | `user-query` → `user-query-content` |
| Gemini's turns | `model-response` → `message-content` |

**Some long conversations look truncated**
Gemini lazy-loads older turns. The script scrolls up until the turn count stops
growing, but a very long chat on a slow connection could settle early. Raise the
`waitForTimeout(500)` in `scrollUntilStable` and re-run those from
`failures.json`.

---

## Files

| File | Purpose |
|---|---|
| `launch-chrome.bat` | Opens a normal Chrome with `--remote-debugging-port=9222` |
| `scrape.js` | The exporter |
| `inspect.js` | DOM recon for the Recents sidebar and a conversation |
| `inspect-all-notebooks.js` | DOM recon for the `/notebooks/view` grid |
| `inspect-notebooks.js` | DOM recon for a single notebook's "Past chats" list |
| `output/` | Exported conversations |
| `failures.json` | Written only if something failed |
| `chrome-cdp-profile/` | The dedicated Chrome profile (holds your login session) |

---

## Note on privacy

Two things this tool creates are sensitive:

- **`chrome-cdp-profile/`** holds a live Google login session. Anyone with the
  folder *and* your Windows account could use it to reach your Google account.
- **`output/`** is the full text of every conversation you've had with Gemini.

Both are in `.gitignore`, so they won't be committed. But also:

- Don't keep this project in a cloud-synced folder (OneDrive, Dropbox, iCloud
  Drive) unless you're comfortable with that content syncing. The Chrome profile
  alone runs to about 1 GB and re-syncs on every run.
- To revoke the tool's access later, delete `chrome-cdp-profile/` and sign the
  session out from your
  [Google account's device list](https://myaccount.google.com/device-activity).

---

## Disclaimer

This is an unofficial tool that reads the Gemini web UI as a logged-in user. It
isn't affiliated with or endorsed by Google, and it will break whenever Google
changes the page structure — `inspect.js` and the troubleshooting section above
exist for exactly that. Use it on your own account, for your own data.
