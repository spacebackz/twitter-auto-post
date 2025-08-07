const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { GoogleSpreadsheet } = require("google-spreadsheet");

puppeteer.use(StealthPlugin());

(async () => {
  try {
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

    const browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    });

    const page = await browser.newPage();

    // Increase the timeout to 60 seconds (60000 ms)
    await page.goto("https://twitter.com/login", { 
      waitUntil: "networkidle2",
      timeout: 60000 // Set timeout to 60 seconds
    });

    await page.type('input[name="text"]', process.env.TWITTER_USERNAME, { delay: 50 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);
    await page.type('input[name="password"]', process.env.TWITTER_PASSWORD, { delay: 50 });
    await page.keyboard.press('Enter');
    await page.waitForNavigation({ waitUntil: "networkidle2" });

    await page.goto("https://twitter.com/compose/tweet", { waitUntil: "networkidle2" });
    await page.waitForSelector("div[aria-label='Tweet text']");
    await page.type("div[aria-label='Tweet text']", tweetMessage, { delay: 50 });
    await page.waitForTimeout(1000);
    await page.click("div[data-testid='tweetButtonInline']");
    await page.waitForTimeout(3000);

    await browser.close();
    console.log("Tweet posted successfully!");

  } catch (error) {
    console.error("An error occurred:", error);
  }
})();
