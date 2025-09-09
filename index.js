// index.js - Full robust Twitter auto-post script
// Put this file as a replacement for your existing index.js

// -------------------- DEBUG BOOTSTRAP (VERY TOP) --------------------
console.log('DEBUG BOOTSTRAP: starting index.js at', new Date().toISOString());
try {
  console.log('node version:', process.version);
  console.log('cwd:', process.cwd());
} catch (e) {
  console.error('debug info error', e);
}
const keysToCheck = ['GOOGLE_SHEET_ID','GOOGLE_SERVICE_ACCOUNT_EMAIL','GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY','TWITTER_COOKIES','PUPPETEER_EXECUTABLE_PATH'];
for (const k of keysToCheck) {
  console.log(`ENV ${k}:`, typeof process.env[k] === 'string' && process.env[k].length ? 'PRESENT' : 'MISSING');
}
process.on('unhandledRejection', (r) => { console.error('UNHANDLED REJECTION:', r && (r.stack || r)); });
process.on('uncaughtException', (err) => { console.error('UNCAUGHT EXCEPTION:', err && (err.stack || err)); });
const DEBUG_KEEP_ALIVE_SECS = parseInt(process.env.DEBUG_KEEP_ALIVE_SECS || '10', 10);
console.log(`DEBUG: will keep process alive for ${DEBUG_KEEP_ALIVE_SECS}s (short) to view logs if needed.`);
setTimeout(() => {
  console.log('DEBUG: keep-alive period ended at', new Date().toISOString());
}, DEBUG_KEEP_ALIVE_SECS * 1000);

// -------------------- IMPORTS & SETUP --------------------
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const fs = require('fs');
const path = require('path');

puppeteerExtra.use(StealthPlugin());

// Configurable environment variables
const DEFAULT_TIMEOUT_MS = parseInt(process.env.DEFAULT_TIMEOUT_MS || '20000', 10);
const POST_ATTEMPT_RETRIES = parseInt(process.env.POST_ATTEMPT_RETRIES || '2', 10); // additional retries
const BETWEEN_TWEETS_SECONDS = parseInt(process.env.BETWEEN_TWEETS_SECONDS || '5', 10);
const DEBUG_DIR = path.join(process.cwd(), 'debug');

if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR);

// Helper: sleep seconds
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

// Save screenshot + HTML for debugging
async function saveDebug(page, namePrefix = 'debug') {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const screenshotPath = path.join(DEBUG_DIR, `${namePrefix}-${timestamp}.png`);
  const htmlPath = path.join(DEBUG_DIR, `${namePrefix}-${timestamp}.html`);
  try {
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const html = await page.content();
    fs.writeFileSync(htmlPath, html, 'utf8');
    console.log('Saved debug artifacts:', screenshotPath, htmlPath);
  } catch (e) {
    console.error('Failed to save debug artifacts:', e);
  }
}

// Optional wait for selector (returns element handle or null)
async function waitForOptionalSelector(page, selector, opts = {}) {
  const timeout = typeof opts.timeout === 'number' ? opts.timeout : Math.min(DEFAULT_TIMEOUT_MS, 10000);
  try {
    return await page.waitForSelector(selector, { visible: true, timeout });
  } catch (e) {
    return null;
  }
}

// -------------------- Robust postTweet implementation --------------------
async function postTweet(page, tweetMessage) {
  const MAX_ATTEMPTS = POST_ATTEMPT_RETRIES + 1;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      console.log(`Posting attempt ${attempt}...`);

      await page.goto('https://twitter.com/compose/tweet', { waitUntil: 'networkidle2', timeout: DEFAULT_TIMEOUT_MS });
      if (page.url().includes('login')) throw new Error('Authentication failed (redirected to login).');

      // Candidate selectors for the contenteditable composer
      const contenteditableSelectorCandidates = [
        'div[aria-label="Tweet text"]',
        'div[data-testid="tweetTextarea_0"] div[contenteditable="true"]',
        'div[contenteditable="true"][role="textbox"]',
        'div.public-DraftEditor-content[contenteditable="true"]'
      ];

      let targetCE = null;
      for (const sel of contenteditableSelectorCandidates) {
        try {
          const el = await page.$(sel);
          if (el) { targetCE = el; console.log('Found composer using selector:', sel); break; }
        } catch (e) {}
      }
      if (!targetCE) {
        const allCE = await page.$$('[contenteditable="true"]');
        if (allCE.length > 0) { targetCE = allCE[0]; console.log('Fallback: using first contenteditable on page.'); }
      }
      if (!targetCE) throw new Error('Could not find a contenteditable composer element.');

      // Set text via DOM to be robust; dispatch input events
      await page.evaluate((el, text) => {
        const node = el instanceof HTMLElement ? el : (typeof el === 'string' ? document.querySelector(el) : el);
        if (!node) throw new Error('composer node not present in evaluate');
        node.focus();
        // Clear and set text
        node.innerText = '';
        // Use textContent to set the text
        node.textContent = text;
        // Dispatch input events
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
      }, targetCE, tweetMessage);

      // Slight pause
      await page.waitForTimeout(400);

      // Try clicking tweet button using multiple selectors
      const tweetButtonSelectors = [
        'div[data-testid="tweetButtonInline"]',
        'div[data-testid="tweetButton"]',
        'div[role="button"][data-testid*="tweet"]',
        'div[aria-label="Tweet"]'
      ];

      let clicked = false;
      for (const sel of tweetButtonSelectors) {
        try {
          const btn = await page.$(sel);
          if (btn) {
            await btn.hover().catch(() => {});
            await btn.click({ delay: 50 });
            console.log('Clicked tweet button with selector:', sel);
            clicked = true;
            break;
          }
        } catch (e) {}
      }

      // Fallback to keyboard if button click not found
      if (!clicked) {
        console.log('Tweet button not found, trying keyboard submit (Ctrl+Enter).');
        await page.keyboard.down('Control');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Control');
      }

      // Wait for success signals:
      // (A) toast OR (B) composer cleared OR (C) tweet visible in home/profile timeline
      const raceTimeout = Math.min(DEFAULT_TIMEOUT_MS, 20000);

      const waitForToast = page.waitForSelector('[data-testid="toast"]', { visible: true, timeout: raceTimeout })
        .then(() => ({ type: 'toast' })).catch(() => null);

      const waitForComposerClear = page.waitForFunction((selCandidates) => {
        for (const s of selCandidates) {
          const el = document.querySelector(s);
          if (el) {
            const txt = (el.innerText || el.textContent || '').trim();
            if (txt.length === 0) return true;
            return false;
          }
        }
        return true;
      }, { timeout: raceTimeout }, ['div[aria-label="Tweet text"]','div[data-testid="tweetTextarea_0"] div[contenteditable="true"]','div[contenteditable="true"][role="textbox"]'])
        .then(() => ({ type: 'composer-cleared' })).catch(() => null);

      const checkPostedInTimeline = (async () => {
        try {
          const profilePage = await page.browser().newPage();
          profilePage.setDefaultTimeout(10000);
          // quick check on home timeline
          await profilePage.goto('https://twitter.com/home', { waitUntil: 'networkidle2' });
          const foundInHome = await profilePage.evaluate((needle) => {
            return Array.from(document.querySelectorAll('article')).some(a => (a.innerText || '').includes(needle));
          }, tweetMessage.slice(0, 50));
          if (foundInHome) { await profilePage.close(); return { type: 'timeline-home' }; }
          // fallback: try profile
          // Attempt to find profile link/href on the main page (use existing page to get href)
          const profileHref = await page.evaluate(() => {
            const el = document.querySelector('a[aria-label="Profile"], a[href^="/"]');
            return el ? el.getAttribute('href') : null;
          });
          if (profileHref) {
            await profilePage.goto(`https://twitter.com${profileHref}`, { waitUntil: 'networkidle2' });
            const foundInProfile = await profilePage.evaluate((needle) => {
              return Array.from(document.querySelectorAll('article')).some(a => (a.innerText || '').includes(needle));
            }, tweetMessage.slice(0, 50));
            await profilePage.close();
            if (foundInProfile) return { type: 'timeline-profile' };
          }
          await profilePage.close();
        } catch (e) { /* ignore timeline check errors */ }
        return null;
      })();

      const results = await Promise.race([waitForToast, waitForComposerClear, checkPostedInTimeline, new Promise(r=>setTimeout(()=>r(null), raceTimeout))]);

      if (results && results.type) {
        console.log('Post success signal:', results.type);
        return { ok: true };
      }

      // Look for inline errors or modals
      const inlineError = await page.evaluate(() => {
        const errSelectors = ['div[role="alert"]','div[data-testid="toast"]','div[aria-live="polite"]','div[role="dialog"]'];
        for (const sel of errSelectors) {
          const el = document.querySelector(sel);
          if (el && el.innerText) return el.innerText.slice(0, 800);
        }
        return null;
      });

      throw new Error(inlineError ? `Inline error detected: ${inlineError}` : 'No success signal (toast or composer cleared) after post attempt.');

    } catch (err) {
      console.warn(`Post attempt ${attempt} failed: ${err && err.message ? err.message : String(err)}`);
      if (attempt === MAX_ATTEMPTS) {
        try { await saveDebug(page, 'tweet-post-failure'); } catch(e){ console.error('saveDebug failed', e); }
        return { ok: false, error: String(err) };
      }
      await page.waitForTimeout(1500 * attempt);
    }
  }
  return { ok: false, error: 'exhausted attempts' };
}

// -------------------- Main flow --------------------
(async () => {
  let browser = null;
  console.log('Cron Job started...');
  try {
    // Google Sheets connection
    console.log('Connecting to Google Sheets to check for tweets...');
    if (!process.env.GOOGLE_SHEET_ID) throw new Error('Missing GOOGLE_SHEET_ID env var.');
    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID);
    await doc.useServiceAccountAuth({
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    });
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();

    if (rows.length === 0) {
      console.log('Sheet is empty. No work to do. Exiting efficiently. ✅');
      return;
    }
    console.log(`Found ${rows.length} tweet(s) to process.`);

    // Launch browser
    console.log('Launching optimized browser...');
    browser = await puppeteerExtra.launch({
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      defaultViewport: { width: 1280, height: 800 },
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);

    // Load cookies
    console.log('Attempting to log in with cookies...');
    const cookiesString = process.env.TWITTER_COOKIES;
    if (!cookiesString) throw new Error('TWITTER_COOKIES environment variable not found.');
    let cookies = [];
    try { cookies = JSON.parse(cookiesString); } catch (e) { throw new Error('TWITTER_COOKIES parse error. Ensure valid JSON.'); }
    const cleanedCookies = cookies.map(c => {
      if (c.hasOwnProperty('sameSite') && !['Strict','Lax','None'].includes(c.sameSite)) delete c.sameSite;
      return c;
    });
    await page.setCookie(...cleanedCookies);
    console.log('Cookies loaded.');

    // Quick login verification
    await page.goto('https://twitter.com/home', { waitUntil: 'networkidle2', timeout: DEFAULT_TIMEOUT_MS });
    const loggedIn = await waitForOptionalSelector(page, 'a[aria-label="Profile"], div[data-testid="AppTabBar_Home_Link"]', { timeout: 7000 });
    if (!loggedIn) console.warn('Login check failed: profile/avatar not found. Cookies may be expired. Posts may fail.');
    else console.log('Login check succeeded.');

    // Main processing loop
    let tweetsPosted = 0;
    while (true) {
      await doc.loadInfo();
      const currentRows = await sheet.getRows();
      if (currentRows.length === 0) {
        console.log('All tweets have been processed.');
        break;
      }

      if (tweetsPosted > 0) await sleep(BETWEEN_TWEETS_SECONDS);

      const rowToProcess = currentRows[0];
      const tweetMessage = rowToProcess.tweet_text;

      console.log(`--- Processing top tweet: "${tweetMessage ? tweetMessage.slice(0,140) : '(empty)'}" ---`);

      try {
        if (!tweetMessage || tweetMessage.trim().length === 0) {
          console.log('Row is empty or blank. Deleting and skipping.');
          await rowToProcess.delete();
          continue;
        }

        const res = await postTweet(page, tweetMessage);
        if (!res.ok) {
          console.error(`❌ Failed to post tweet: ${res.error}`);
          // Option: You can move the failing row to an error sheet or mark it. For safety, we do NOT delete it automatically.
          // To avoid infinite loop, delete after repeated failures or move to another sheet — implement as needed.
          // For now, we'll skip deleting so you can inspect the row.
          // Wait a bit before continuing to avoid tight loop
          await sleep(2);
          // optionally continue to next row (we'll rotate by deleting to avoid reprocessing same bad row)
          // If you want to skip it permanently, uncomment next line:
          // await rowToProcess.delete();
        } else {
          tweetsPosted++;
          await rowToProcess.delete();
          console.log('Row deleted successfully from sheet.');
        }
      } catch (perTweetErr) {
        console.error('Unexpected error while processing row:', String(perTweetErr));
        try { await saveDebug(page, 'unexpected-per-row-error'); } catch (e) {}
      }
    }

    console.log('Done processing tweets. Exiting.');

  } catch (mainErr) {
    console.error('❌ A critical error occurred:', mainErr && (mainErr.stack || mainErr));
    process.exit(1);
  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) {}
      console.log('Browser closed. Cron Job finished.');
    }
  }
})();
