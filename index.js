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
    // --- 1. CONNECT TO GOOGLE SHEETS ---
    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID);
    await doc.useServiceAccountAuth({
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g, '\n'),
    });
    
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

    // --- 4. NEW LOGIC: Use a while loop to process one tweet at a time ---
    let tweetsPosted = 0;
    while (true) {
      await doc.loadInfo(); // Re-load sheet info each time
      const sheet = doc.sheetsByIndex[0];
      const rows = await sheet.getRows();

      if (rows.length === 0) {
        console.log("Sheet is empty. All tweets have been processed.");
        break; // Exit the while loop
      }

      if (tweetsPosted > 0) {
        await sleep(30);
      }
      
      const row = rows[0]; // Always get the top row
      
      //
      // THIS IS THE CORRECTED LINE:
      //
      const tweetMessage = row.tweet_text;
      
      console.log(`--- Processing top tweet: "${tweetMessage}" ---`);
      
      try {
        if (!tweetMessage) {
          console.log("Row is empty, deleting and skipping.");
          await row.delete();
          continue; 
        }

        await page.goto("https://twitter.com/compose/tweet", { waitUntil: "networkidle2", timeout: 60000 });
        if (page.url().includes("login")) throw new Error("Authentication failed. Cookies might be expired.");

        const tweetTextAreaSelector = 'div[data-testid="tweetTextarea_0"]';
        await page.waitForSelector(tweetTextAreaSelector, { timeout: 20000 });
        await page.type(tweetTextAreaSelector, tweetMessage, { delay: 50 });
        
        await page.keyboard.down('Control');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Control');
        
        await page.waitForSelector('[data-testid="toast"]', { timeout: 20000 });
        console.log("✅ Tweet posted successfully!");
        tweetsPosted++;
        
        await row.delete();
        console.log("Row deleted successfully from sheet.");

      } catch (error) {
        console.error(`❌ Failed to process tweet "${tweetMessage}". Error: ${error.message}`);
        break;
      }
    }

  } catch (error) {
    console.error("❌ A critical error occurred:", error);
    process.exit(1);
  } finally {
    if (browser) {
      await browser.close();
      console.log("Browser closed. Cron Job finished.");
    }
  }
})();
