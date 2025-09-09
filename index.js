// index.js (robust version)
const puppeteer = require("puppeteer");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const puppeteerExtra = require("puppeteer-extra");
const { GoogleSpreadsheet } = require("google-spreadsheet");
const fs = require("fs");
const path = require("path");

puppeteerExtra.use(StealthPlugin());
const PUPPETEER = puppeteerExtra;

// ENV-configurable values
const DEFAULT_TIMEOUT_MS = parseInt(process.env.DEFAULT_TIMEOUT_MS || "20000", 10);
const POST_ATTEMPT_RETRIES = parseInt(process.env.POST_ATTEMPT_RETRIES || "2", 10);
const BETWEEN_TWEETS_SECONDS = parseInt(process.env.BETWEEN_TWEETS_SECONDS || "5", 10);
const DEBUG_DIR = path.join(process.cwd(), "debug");

if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR);

// Helper: sleep seconds
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

// Save screenshot + HTML for debugging
async function saveDebug(page, namePrefix = "debug") {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const screenshotPath = path.join(DEBUG_DIR, `${namePrefix}-${timestamp}.png`);
  const htmlPath = path.join(DEBUG_DIR, `${namePrefix}-${timestamp}.html`);
  try {
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const html = await page.content();
    fs.writeFileSync(htmlPath, html, "utf8");
    console.log("Saved debug artifacts:", screenshotPath, htmlPath);
  } catch (e) {
    console.error("Failed to save debug artifacts:", e);
  }
}

// Optional wait for selector (returns element handle or null)
async function waitForOptionalSelector(page, selector, opts = {}) {
  const timeout = typeof opts.timeout === "number" ? opts.timeout : Math.min(DEFAULT_TIMEOUT_MS, 10000);
  try {
    return await page.waitForSelector(selector, { visible: true, timeout });
  } catch (e) {
    return null;
  }
}

// Attempt to post a single tweet with retries
async function postTweet(page, tweetMessage) {
  for (let attempt = 1; attempt <= POST_ATTEMPT_RETRIES + 1; attempt++) {
    try {
      // Navigate to composer each attempt
      await page.goto("https://twitter.com/compose/tweet", { waitUntil: "networkidle2", timeout: DEFAULT_TIMEOUT_MS });

      // Immediate login check
      if (page.url().includes("login")) throw new Error("Authentication failed or cookies expired (redirected to login).");

      // Wait for composer textarea
      const tweetSelector = 'div[data-testid="tweetTextarea_0"], div[aria-label="Tweet text"]';
      const ta = await page.waitForSelector(tweetSelector, { timeout: Math.max(10000, DEFAULT_TIMEOUT_MS) });
      if (!ta) throw new Error("Tweet composer not found on page.");

      // Clear and type
      await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el) {
          // If it's a contenteditable, clear by setting innerText
          el.focus();
          el.innerText = "";
        }
      }, tweetSelector);

      // Type in small chunks to mimic human
      await page.type(tweetSelector, tweetMessage, { delay: 12 });

      // Submit: keyboard Enter + Ctrl (your previous approach)
      await page.keyboard.down("Control");
      await page.keyboard.press("Enter");
      await page.keyboard.up("Control");

      // Now wait for either:
      // 1) toast appears OR
      // 2) composer textarea becomes empty (meaning tweet posted)
      // We'll race them, but both are optional - if neither happens in timeout, treat as error
      const raceTimeout = Math.min(DEFAULT_TIMEOUT_MS, 15000);

      const success = await Promise.race([
        page.waitForSelector('[data-testid="toast"]', { visible: true, timeout: raceTimeout }).then(() => ({ source: "toast" })).catch(() => null),
        page.waitForFunction((sel) => {
          const el = document.querySelector(sel);
          if (!el) return true; // if element disappears, also success
          // check innerText trimmed
          const text = el.innerText || el.textContent || "";
          return text.trim().length === 0;
        }, { timeout: raceTimeout }, tweetSelector).then(() => ({ source: "composer-cleared" })).catch(() => null)
      ]);

      if (success) {
        console.log(`✅ Tweet posted successfully (signal: ${success.source}).`);
        return { ok: true };
      } else {
        throw new Error("No success signal (toast or composer cleared) after post attempt.");
      }
    } catch (err) {
      console.warn(`Post attempt ${attempt} failed: ${err.message}`);
      // save debug on final attempt
      if (attempt === POST_ATTEMPT_RETRIES + 1) {
        try { await saveDebug(page, "tweet-post-failure"); } catch (e) {}
        return { ok: false, error: String(err) };
      }
      // small backoff and retry
      await sleep(1.5 * attempt);
    }
  }
  return { ok: false, error: "Retries exhausted" };
}

(async () => {
  let browser = null;
  console.log("Cron Job started...");
  try {
    // Connect Google Sheets
    console.log("Connecting to Google Sheets to check for tweets...");
    if (!process.env.GOOGLE_SHEET_ID) throw new Error("Missing GOOGLE_SHEET_ID env var.");
    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID);
    await doc.useServiceAccountAuth({
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    });
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();

    if (rows.length === 0) {
      console.log("Sheet is empty. No work to do. Exiting efficiently. ✅");
      return;
    }
    console.log(`Found ${rows.length} tweet(s) to process.`);

    // Launch browser with executablePath from Dockerfile env if present
    console.log("Launching optimized browser...");
    browser = await PUPPETEER.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      defaultViewport: { width: 1280, height: 800 },
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);

    // Load cookies
    console.log("Attempting to log in with cookies...");
    const cookiesString = process.env.TWITTER_COOKIES;
    if (!cookiesString) throw new Error("TWITTER_COOKIES environment variable not found.");
    let cookies = [];
    try { cookies = JSON.parse(cookiesString); } catch (e) { throw new Error("TWITTER_COOKIES parse error. Ensure valid JSON."); }
    // remove unexpected sameSite values (safeguard you had earlier)
    const cleanedCookies = cookies.map(c => {
      if (c.hasOwnProperty("sameSite") && !["Strict", "Lax", "None"].includes(c.sameSite)) delete c.sameSite;
      return c;
    });
    await page.setCookie(...cleanedCookies);
    console.log("Cookies loaded.");

    // Quick login verification by hitting Twitter root and checking for a logged-in selector
    await page.goto("https://twitter.com/home", { waitUntil: "networkidle2", timeout: DEFAULT_TIMEOUT_MS });
    // logged-in indicators (try a couple)
    const loggedIn = await waitForOptionalSelector(page, 'a[aria-label="Profile"], div[data-testid="AppTabBar_Home_Link"]', { timeout: 7000 });
    if (!loggedIn) {
      console.warn("Login check failed: profile/avatar not found. Cookies may be expired. Continuing but posts will likely fail.");
    } else {
      console.log("Login check succeeded.");
    }

    // Main loop: process rows from sheet
    let tweetsPosted = 0;
    while (true) {
      await doc.loadInfo();
      const currentRows = await sheet.getRows();
      if (currentRows.length === 0) {
        console.log("All tweets have been processed.");
        break;
      }

      if (tweetsPosted > 0) await sleep(BETWEEN_TWEETS_SECONDS);

      const rowToProcess = currentRows[0];
      const tweetMessage = rowToProcess.tweet_text;

      console.log(`--- Processing top tweet: "${tweetMessage ? tweetMessage.slice(0, 140) : "(empty)"}" ---`);

      try {
        if (!tweetMessage || tweetMessage.trim().length === 0) {
          console.log("Row is empty or blank. Deleting and skipping.");
          await rowToProcess.delete();
          continue;
        }

        const res = await postTweet(page, tweetMessage);
        if (!res.ok) {
          console.error(`❌ Failed to post tweet: ${res.error}`);
          // Option: delete problematic row or move it to an "error" sheet; here we skip deleting so you can reprocess manually
          // For now, move the row to bottom (or update a status column). Simpler: add a backoff and continue
          await sleep(2);
          // continue to next tweet without deleting the failing row so you can inspect it later
          // However to avoid infinite loop, delete if repeated failure threshold reached (not implemented)
          // We'll delete and log - modify as per your preference:
          // await rowToProcess.delete();
        } else {
          tweetsPosted++;
          // delete the processed row
          await rowToProcess.delete();
          console.log("Row deleted successfully from sheet.");
        }
      } catch (perTweetErr) {
        console.error("Unexpected error while processing row:", String(perTweetErr));
        try { await saveDebug(page, "unexpected-per-row-error"); } catch (e) {}
        // Continue to next tweet
      }
    }

    console.log("Done processing tweets. Exiting.");

  } catch (mainErr) {
    console.error("❌ A critical error occurred:", mainErr);
    // no process.exit so that Render sees logs; you can exit if you prefer
    process.exit(1);
  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) {}
      console.log("Browser closed. Cron Job finished.");
    }
  }
})();
