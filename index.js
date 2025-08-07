const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { GoogleSpreadsheet } = require("google-spreadsheet");

puppeteer.use(StealthPlugin());

// This is the simple, self-executing script.
(async () => {
  let browser = null;
  console.log("Cron Job started...");
  try {
    // --- 1. CONNECT TO GOOGLE SHEETS ---
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

    // --- 2. LAUNCH BROWSER WITH MEMORY OPTIMIZATIONS ---
    console.log("Launching optimized browser...");
    //
    // THIS IS THE ONLY CHANGE: Adding arguments to reduce memory usage.
    //
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process', // Crucial for memory reduction
        '--disable-gpu'
      ],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    });
    const page = await browser.newPage();

    // --- 3. LOG IN AND POST ---
    console.log("Navigating to login page...");
    await page.goto("https://twitter.com/login", { waitUntil: "networkidle2", timeout: 60000 });

    console.log("Entering username...");
    await page.waitForSelector('input[name="text"]', { timeout: 20000 });
    await page.type('input[name="text"]', process.env.TWITTER_USERNAME, { delay: 100 });
    await page.keyboard.press('Enter');

    console.log("Waiting for password field...");
    await page.waitForSelector('input[name="password"]', { timeout: 20000 });
    await page.type('input[name="password"]', process.env.TWITTER_PASSWORD, { delay: 100 });
    await page.keyboard.press('Enter');
    
    await page.waitForSelector('a[data-testid="AppTabBar_Home_Link"]', { timeout: 60000 });
    console.log("Login successful!");

    await page.goto("https://twitter.com/compose/tweet", { waitUntil: "networkidle2", timeout: 60000 });

    const tweetTextAreaSelector = 'div[data-testid="tweetTextarea_0"]';
    await page.waitForSelector(tweetTextAreaSelector, { timeout: 20000 });
    await page.type(tweetTextAreaSelector, tweetMessage, { delay: 50 });

    const postButtonSelector = 'div[data-testid="tweetButtonInline"]';
    await page.click(postButtonSelector);
    
    await page.waitForSelector('[data-testid="toast"]', { timeout: 20000 });
    console.log("✅ Tweet posted successfully!");
    
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
