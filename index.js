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
    // --- STEP 1: CONNECT TO GOOGLE SHEETS AND CHECK FOR WORK FIRST ---
    console.log("Connecting to Google Sheets to check for tweets...");
    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID);
    await doc.useServiceAccountAuth({
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g, '\n'),
    });
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();

    // --- STEP 2: EXIT EARLY IF THE SHEET IS EMPTY ---
    if (rows.length === 0) {
      console.log("Sheet is empty. No work to do. Exiting efficiently. ✅");
      return; // Exit the script immediately
    }
    console.log(`Found ${rows.length} tweet(s) to process.`);
    
    // --- STEP 3: LAUNCH BROWSER AND LOGIN (ONLY IF THERE'S WORK) ---
    console.log("Launching optimized browser...");
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-dbus'],
      // Note: executablePath is correctly REMOVED
    });
    const page = await browser.newPage();
    
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

    // --- STEP 4: PROCESS ALL TWEETS USING THE ROBUST WHILE LOOP ---
    let tweetsPosted = 0;
    while (true) {
      // Re-fetch rows inside the loop to prevent deletion errors
      await doc.loadInfo(); 
      const currentRows = await sheet.getRows();

      if (currentRows.length === 0) {
        console.log("All tweets have been processed.");
        break; // Exit the while loop
      }

      if (tweetsPosted > 0) {
        await sleep(5);
      }
      
      const rowToProcess = currentRows[0]; 
      const tweetMessage = rowToProcess.tweet_text; 
      
      console.log(`--- Processing top tweet: "${tweetMessage}" ---`);
      
      try {
        if (!tweetMessage) {
          console.log("Row is empty, deleting and skipping.");
          await rowToProcess.delete();
          continue; 
        }

        await page.goto("https://twitter.com/compose/tweet", { waitUntil: "networkidle2", timeout: 60000 });
        if (page.url().includes("login")) throw new Error("Authentication failed. Cookies might be expired.");

        const tweetTextAreaSelector = 'div[data-testid="tweetTextarea_0"]';
        await page.waitForSelector(tweetTextAreaSelector, { timeout: 20000 });
        await page.type(tweetTextAreaSelector, tweetMessage, { delay: 15 });
        
        await page.keyboard.down('Control');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Control');
        
        await page.waitForSelector('[data-testid="toast"]', { timeout: 20000 });
        console.log("✅ Tweet posted successfully!");
        tweetsPosted++;
        
        await rowToProcess.delete();
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
