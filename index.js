const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { GoogleSpreadsheet } = require("google-spreadsheet");

puppeteer.use(StealthPlugin());

// The main function that runs the entire process
(async () => {
  let browser = null; // Define browser here to access it in the finally block
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
      console.log("No tweets found in the Google Sheet. Exiting.");
      return;
    }
    const tweetMessage = rows[0].tweet_text;
    console.log(`Found tweet to post: "${tweetMessage}"`);

    // --- 2. LAUNCH BROWSER ---
    console.log("Launching browser...");
    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--single-process", // May help in constrained environments
        "--disable-gpu",
      ],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // --- 3. LOG IN TO TWITTER / X ---
    console.log("Navigating to login page...");
    await page.goto("https://twitter.com/login", { waitUntil: "networkidle2", timeout: 60000 });

    console.log("Typing username...");
    await page.waitForSelector('input[name="text"]', { timeout: 20000 });
    await page.type('input[name="text"]', process.env.TWITTER_USERNAME, { delay: 100 });
    await page.keyboard.press('Enter');

    console.log("Waiting for password input to appear...");
    await page.waitForSelector('input[name="password"]', { timeout: 20000 });
    await page.type('input[name="password"]', process.env.TWITTER_PASSWORD, { delay: 100 });
    
    console.log("Submitting login form...");
    await page.keyboard.press('Enter');

    console.log("Waiting for successful login confirmation...");
    // A good way to confirm login is to wait for the "Home" timeline link to be visible.
    await page.waitForSelector('a[data-testid="AppTabBar_Home_Link"]', { timeout: 60000 });
    console.log("Login successful!");

    // --- 4. COMPOSE AND POST TWEET ---
    console.log("Navigating to compose tweet page...");
    await page.goto("https://twitter.com/compose/tweet", { waitUntil: "networkidle2", timeout: 60000 });

    console.log("Typing the tweet...");
    const tweetTextAreaSelector = 'div[data-testid="tweetTextarea_0"]';
    await page.waitForSelector(tweetTextAreaSelector, { timeout: 20000 });
    await page.type(tweetTextAreaSelector, tweetMessage, { delay: 50 });

    console.log("Clicking the post button...");
    const postButtonSelector = 'div[data-testid="tweetButtonInline"]';
    await page.waitForSelector(postButtonSelector, { timeout: 20000 });
    await page.click(postButtonSelector);

    console.log("Waiting for post confirmation...");
    // Wait for the "Your Post was sent" toast message to appear
    await page.waitForSelector('[data-testid="toast"]', { timeout: 20000 });
    
    console.log("✅ Tweet posted successfully!");
    
    // --- 5. CLEAN UP GOOGLE SHEET ---
    console.log("Deleting posted tweet from Google Sheet...");
    await rows[0].delete();
    console.log("Row deleted.");

  } catch (error) {
    console.error("❌ An error occurred during the process:", error);
    // Exit with an error code to make sure Render logs it as a failed run
    process.exit(1);
  } finally {
    if (browser) {
      await browser.close();
      console.log("Browser closed.");
    }
  }
})();
