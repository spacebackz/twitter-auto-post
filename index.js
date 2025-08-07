const express = require("express");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { GoogleSpreadsheet } = require("google-spreadsheet");

puppeteer.use(StealthPlugin());
const app = express();
const PORT = process.env.PORT || 3000;

// This function contains the main bot logic
async function runTwitterBot() {
  let browser = null;
  console.log("Bot process started...");
  try {
    // --- 1. CONNECT TO GOOGLE SHEETS AND VALIDATE DATA ---
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
      console.log("Sheet is empty. No tweets to post. Exiting bot run.");
      return;
    }

    // NEW: Improved check for tweet text
    const tweetMessage = rows[0].get('tweet_text'); // Use .get() for safety
    if (!tweetMessage) {
      console.error("❌ Error: Could not find tweet text. Check two things:");
      console.error("1. Your sheet has a column header spelled EXACTLY 'tweet_text'.");
      console.error("2. The first data row has text in that column.");
      return;
    }
    console.log(`Found tweet to post: "${tweetMessage}"`);

    // --- 2. LAUNCH BROWSER WITH MEMORY OPTIMIZATIONS ---
    console.log("Launching optimized browser...");
    browser = await puppeteer.launch({
      headless: true,
      // NEW: Arguments to reduce memory usage on Render's free tier
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

    // --- 3. LOG IN AND POST (No changes to this logic) ---
    console.log("Navigating to login page...");
    await page.goto("https://twitter.com/login", { waitUntil: "networkidle2", timeout: 60000 });

    console.log("Typing username...");
    await page.waitForSelector('input[name="text"]', { timeout: 20000 });
    await page.type('input[name="text"]', process.env.TWITTER_USERNAME, { delay: 100 });
    await page.keyboard.press('Enter');

    console.log("Waiting for password input...");
    await page.waitForSelector('input[name="password"]', { timeout: 20000 });
    await page.type('input[name="password"]', process.env.TWITTER_PASSWORD, { delay: 100 });
    await page.keyboard.press('Enter');
    
    console.log("Waiting for successful login...");
    await page.waitForSelector('a[data-testid="AppTabBar_Home_Link"]', { timeout: 60000 });
    console.log("Login successful!");

    console.log("Navigating to compose page...");
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
    console.error("❌ An error occurred during the bot run:", error);
  } finally {
    if (browser) {
      await browser.close();
      console.log("Browser closed. Bot run finished.");
    }
  }
}

// --- EXPRESS SERVER (No changes here) ---
app.get("/run", (req, res) => {
  res.status(202).send("Accepted. Twitter bot process has been started.");
  runTwitterBot();
});

app.get("/", (req, res) => {
  res.send("Twitter Auto-Post bot is alive!");
});

app.listen(PORT, () => {
  console.log(`Server is running and listening on port ${PORT}`);
});
