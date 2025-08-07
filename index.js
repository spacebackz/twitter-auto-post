const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { GoogleSpreadsheet } = require("google-spreadsheet");

puppeteer.use(StealthPlugin());

// A helper function for creating a delay in SECONDS
const sleep = (seconds) => {
  console.log(`Waiting for ${seconds} second(s) before the next post...`);
  return new Promise(res => setTimeout(res, seconds * 1000));
};

(async () => {
  let browser = null;
  console.log("Cron Job started...");
  try {
    // --- 1. GET ALL TWEETS FROM GOOGLE SHEETS ---
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
    console.log(`Found ${rows.length} tweet(s) to post.`);

    // --- 2. LAUNCH BROWSER ---
    console.log("Launching optimized browser...");
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote', '--single-process', '--disable-gpu'],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    });
    const page = await browser.newPage();
    
    // --- 3. LOGIN USING COOKIES ---
    console.log("Attempting to log in with cookies...");
    const cookiesString = process.env.TWITTER_COOKIES;
    if (!cookiesString) throw new Error("TWITTER_COOKIES environment variable not found.");
    const cookies = JSON.parse(cookiesString);
    const cleanedCookies = cookies.map(c => {
      if (c.hasOwnProperty('sameSite') && !["Strict", "Lax", "None"].includes(c.sameSite)) delete c.sameSite;
      return c;
    });
    await page.setCookie(...cleanedCookies);
    console.log("Cookies loaded.");

    // --- 4. LOOP THROUGH EACH ROW AND POST ---
    for (const [index, row] of rows.entries()) {
      console.log(`--- Processing Tweet ${index + 1} of ${rows.length} ---`);
      try {
        const tweetMessage = row.tweet_text;
        if (!tweetMessage) {
          console.log("Row is empty, skipping.");
          continue; 
        }
        console.log(`Posting: "${tweetMessage}"`);

        await page.goto("https://twitter.com/compose/tweet", { waitUntil: "networkidle2", timeout: 60000 });
        if (page.url().includes("login")) throw new Error("Authentication failed. Cookies might be expired.");

        const tweetTextAreaSelector = 'div[data-testid="tweetTextarea_0"]';
        await page.waitForSelector(tweetTextAreaSelector, { timeout: 20000 });
        await page.type(tweetTextAreaSelector, tweetMessage, { delay: 50 });
        
        console.log("Using keyboard shortcut (Ctrl+Enter) to post...");
        await page.keyboard.down('Control');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Control');
        
        await page.waitForSelector('[data-testid="toast"]', { timeout: 20000 });
        console.log("✅ Tweet posted successfully!");
        
        await row.delete();
        console.log("Row deleted from sheet.");

        // IMPORTANT: Add a delay unless it's the very last tweet
        if (index < rows.length - 1) {
          await sleep(30); // Waits for 30 seconds
        }

      } catch (error) {
        console.error(`❌ Failed to process tweet "${row.tweet_text}". Error: ${error.message}`);
        console.log("Moving to the next tweet...");
      }
    }

  } catch (error) {
    console.error("❌ A critical error occurred:", error);
    process.exit(1);
  } finally {
    if (browser) {
      await browser.close();
      console.log("Browser closed. All tweets processed. Cron Job finished.");
    }
  }
})();
