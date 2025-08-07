const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { GoogleSpreadsheet } = require("google-spreadsheet");

puppeteer.use(StealthPlugin());

(async () => {
  let browser = null;
  console.log("Cron Job started...");
  try {
    // --- 1. GET TWEET FROM GOOGLE SHEETS ---
    console.log("Connecting to Google Sheets...");
    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID);
    await doc.useServiceAccountAuth({
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g, '\n'),
    });
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();

    if (rows.length === 0) {
      console.log("Sheet is empty. No tweets to post. Exiting.");
      return;
    }
    const tweetMessage = rows[0].tweet_text;
    if (!tweetMessage) {
      console.error("❌ Error: 'tweet_text' column is missing or empty in your sheet.");
      return;
    }
    console.log(`Found tweet to post: "${tweetMessage}"`);

    // --- 2. LAUNCH BROWSER ---
    console.log("Launching optimized browser...");
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote', '--single-process', '--disable-gpu'],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    });
    const page = await browser.newPage();
    
    // --- 3. LOGIN METHOD: COOKIES ---
    console.log("Attempting to log in with cookies...");
    const cookiesString = process.env.TWITTER_COOKIES;
    if (!cookiesString) {
        throw new Error("TWITTER_COOKIES environment variable not found or empty.");
    }
    const cookies = JSON.parse(cookiesString);

    //
    // NEW & IMPROVED: A much stricter cleaning function for the cookies.
    //
    console.log("Performing strict cleaning of cookies...");
    const validSameSiteValues = ["Strict", "Lax", "None"];
    const cleanedCookies = cookies.map(cookie => {
      // Check if the sameSite key exists and if its value is not valid.
      if (cookie.hasOwnProperty('sameSite') && !validSameSiteValues.includes(cookie.sameSite)) {
        // If the key exists but the value is invalid (e.g., null, "Unspecified"),
        // we delete the key entirely to prevent errors.
        delete cookie.sameSite;
      }
      return cookie;
    });

    await page.setCookie(...cleanedCookies);
    console.log("Cookies loaded into browser.");

    // --- 4. GO TO COMPOSE PAGE AND POST ---
    console.log("Navigating directly to compose tweet page...");
    await page.goto("https://twitter.com/compose/tweet", { waitUntil: "networkidle2", timeout: 60000 });

    if (page.url().includes("login")) {
      throw new Error("Authentication with cookies failed. Your cookies may be expired. Please export and add them again.");
    }
    console.log("Successfully authenticated using cookies.");

    const tweetTextAreaSelector = 'div[data-testid="tweetTextarea_0"]';
    await page.waitForSelector(tweetTextAreaSelector, { timeout: 20000 });
    await page.type(tweetTextAreaSelector, tweetMessage, { delay: 50 });

    const postButtonSelector = 'div[data-testid="tweetButtonInline"]';
    await page.click(postButtonSelector);
    
    await page.waitForSelector('[data-testid="toast"]', { timeout: 20000 });
    console.log("✅ Tweet posted successfully!");
    
    // --- 5. CLEAN UP ---
    await rows[0].delete();
    console.log("Row deleted from sheet.");

  } catch (error) {
    console.error("❌ An error occurred during the cron job run:", error);
    process.exit(1);
  } finally {
    if (browser) {
      await browser.close();
      console.log("Browser closed. Cron Job finished.");
    }
  }
})();
