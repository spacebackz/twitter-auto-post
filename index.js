const browser = await puppeteer.launch({
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage", // This is a common requirement on cloud platforms
  ],
  executablePath: "/usr/bin/google-chrome-stable", // Or '/usr/bin/chromium-browser'
});
const { GoogleSpreadsheet } = require("google-spreadsheet");

(async () => {
  // 1. Get tweet text from Google Sheet
  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID);
  await doc.useServiceAccountAuth({
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g, '\n'),
  });

  await doc.loadInfo();
  const sheet = doc.sheetsByIndex[0]; // Assumes the data is in the first sheet
  const rows = await sheet.getRows();

  if (rows.length === 0) {
    console.log("No tweets found in the Google Sheet.");
    return;
  }

  const tweetMessage = rows[0].tweet_text; // Assumes a column named 'tweet_text'

  // 2. Puppeteer logic to post the tweet (your existing code)
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();

  await page.goto("https://twitter.com/login", { waitUntil: "networkidle2" });
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
})();
