const puppeteer = require("puppeteer");

const tweetMessage = process.env.TWEET_TEXT;

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();

  await page.goto("https://twitter.com/login", { waitUntil: "networkidle2" });

  // Login
  await page.type('input[name="text"]', process.env.TWITTER_USERNAME, { delay: 50 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2000);
  await page.type('input[name="password"]', process.env.TWITTER_PASSWORD, { delay: 50 });
  await page.keyboard.press('Enter');

  await page.waitForNavigation({ waitUntil: "networkidle2" });

  // Go to Tweet box
  await page.goto("https://twitter.com/compose/tweet", { waitUntil: "networkidle2" });

  await page.waitForSelector("div[aria-label='Tweet text']");
  await page.type("div[aria-label='Tweet text']", tweetMessage, { delay: 50 });

  await page.waitForTimeout(1000);
  await page.click("div[data-testid='tweetButtonInline']");

  await page.waitForTimeout(3000);

  await browser.close();
})();
