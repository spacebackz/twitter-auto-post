// robust postTweet replacement
async function postTweet(page, tweetMessage) {
  const MAX_ATTEMPTS = POST_ATTEMPT_RETRIES + 1;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      console.log(`Posting attempt ${attempt}...`);

      await page.goto("https://twitter.com/compose/tweet", { waitUntil: "networkidle2", timeout: DEFAULT_TIMEOUT_MS });
      if (page.url().includes("login")) throw new Error("Authentication failed (redirected to login).");

      // Find a contenteditable area inside the composer (try a few common patterns)
      const contenteditableSelectorCandidates = [
        'div[aria-label="Tweet text"]',
        'div[data-testid="tweetTextarea_0"] div[contenteditable="true"]',
        'div[contenteditable="true"][role="textbox"]',
        'div.public-DraftEditor-content[contenteditable="true"]' // older drafts
      ];

      let targetCE = null;
      for (const sel of contenteditableSelectorCandidates) {
        try {
          targetCE = await page.$(sel);
          if (targetCE) { 
            console.log("Found composer using selector:", sel);
            break;
          }
        } catch (e) {}
      }
      if (!targetCE) {
        // As fallback look for any contenteditable on page that's visible inside the compose area
        const allCE = await page.$$('[contenteditable="true"]');
        if (allCE.length > 0) {
          targetCE = allCE[0];
          console.log("Fallback: using first contenteditable on page.");
        }
      }
      if (!targetCE) throw new Error("Could not find a contenteditable composer element.");

      // Focus and set text via DOM to avoid fragile typing issues
      await page.evaluate((el, text) => {
        // el is element handle; we receive selector string or element; to be safe:
        const node = (typeof el === 'string') ? document.querySelector(el) : el;
        if (!node) throw new Error('composer node not present in evaluate');
        // Clear it
        // Some contenteditable elements expect innerText, others expect textContent or child nodes
        node.focus();
        // For robust clearing, set innerHTML and dispatch input events
        node.innerText = '';
        node.textContent = text;
        // dispatch input & keyup events
        const evInput = new Event('input', { bubbles: true });
        node.dispatchEvent(evInput);
        const evKeyUp = new KeyboardEvent('keyup', { bubbles: true });
        node.dispatchEvent(evKeyUp);
      }, targetCE, tweetMessage);

      // Wait briefly for any UI updates
      await page.waitForTimeout(400);

      // Try clicking tweet button using multiple selectors
      const tweetButtonSelectors = [
        'div[data-testid="tweetButtonInline"]',
        'div[data-testid="tweetButton"]',
        'div[role="button"][data-testid*="tweet"]',
        'div[aria-label="Tweet"]',
        'div[role="button"]:has(span:contains("Tweet"))' // note: :contains not supported in puppeteer directly; used as conceptual fallback
      ];

      let clicked = false;
      for (const sel of tweetButtonSelectors) {
        try {
          const btn = await page.$(sel);
          if (btn) {
            await btn.hover().catch(()=>{});
            await btn.click({ delay: 50 }); // human-like click
            console.log("Clicked tweet button with selector:", sel);
            clicked = true;
            break;
          }
        } catch (e) {
          // ignore and try next selector
        }
      }

      // Fallback to keyboard if button not found
      if (!clicked) {
        console.log("Tweet button not found, trying keyboard submit (Ctrl+Enter).");
        await page.keyboard.down("Control");
        await page.keyboard.press("Enter");
        await page.keyboard.up("Control");
      }

      // Now wait for success signals:
      // (A) toast OR (B) composer cleared OR (C) tweet visible in home/profile timeline
      const raceTimeout = Math.min(DEFAULT_TIMEOUT_MS, 20000);

      // helper promises
      const waitForToast = page.waitForSelector('[data-testid="toast"]', { visible: true, timeout: raceTimeout }).then(()=>({type:'toast'})).catch(()=>null);
      const waitForComposerClear = page.waitForFunction(() => {
        const selCandidates = [
          'div[aria-label="Tweet text"]',
          'div[data-testid="tweetTextarea_0"] div[contenteditable="true"]',
          'div[contenteditable="true"][role="textbox"]'
        ];
        for (const s of selCandidates) {
          const el = document.querySelector(s);
          if (el) {
            const txt = (el.innerText || el.textContent || '').trim();
            if (txt.length === 0) return true;
            return false;
          }
        }
        // If no composer found, treat as cleared
        return true;
      }, { timeout: raceTimeout }).then(()=>({type:'composer-cleared'})).catch(()=>null);

      // Verify by searching in your profile or home timeline for the string (safer)
      const checkPostedInTimeline = (async () => {
        try {
          // open profile in a new tab to avoid replacing current page
          const profilePage = await page.browser().newPage();
          profilePage.setDefaultTimeout(10000);
          // first try home timeline search for the exact text (less reliable because other users might have same text)
          await profilePage.goto('https://twitter.com/home', { waitUntil: 'networkidle2' });
          // search for an element that contains the tweetMessage substring
          const foundInHome = await profilePage.evaluate((needle) => {
            const matches = Array.from(document.querySelectorAll('article')).some(a => (a.innerText || '').includes(needle));
            return matches;
          }, tweetMessage.slice(0, 50)); // use a unique prefix to speed up
          if (foundInHome) {
            await profilePage.close();
            return { type: 'timeline-home' };
          }
          // fallback: open your profile and look for tweet there
          // attempt to get current logged-in username from meta or profile link
          const profileLink = await page.evaluate(() => {
            const el = document.querySelector('a[aria-label^="Profile"], a[role="link"][href^="/"]');
            if (el && el.getAttribute) return el.getAttribute('href');
            return null;
          });
          if (profileLink) {
            const usernamePath = profileLink.startsWith('/') ? profileLink : '/'+profileLink;
            await profilePage.goto(`https://twitter.com${usernamePath}`, { waitUntil: 'networkidle2' });
            const foundInProfile = await profilePage.evaluate((needle) => {
              return Array.from(document.querySelectorAll('article')).some(a => (a.innerText || '').includes(needle));
            }, tweetMessage.slice(0, 50));
            await profilePage.close();
            if (foundInProfile) return { type: 'timeline-profile' };
          }
          await profilePage.close();
        } catch (e) {
          try { await profilePage && profilePage.close(); } catch(e) {}
        }
        return null;
      })();

      // Race them
      const results = await Promise.race([waitForToast, waitForComposerClear, checkPostedInTimeline, new Promise(r=>setTimeout(()=>r(null), raceTimeout))]);

      if (results && results.type) {
        console.log('Post success signal:', results.type);
        return { ok: true };
      }

      // If we land here, no success signal — inspect for inline error messages or modals
      const inlineError = await page.evaluate(() => {
        const errSelectors = [
          'div[role="alert"]',
          'div[data-testid="toast"]',
          'div[aria-live="polite"]',
          'div[role="dialog"]'
        ];
        for (const sel of errSelectors) {
          const el = document.querySelector(sel);
          if (el && el.innerText) {
            return el.innerText.slice(0, 800);
          }
        }
        return null;
      });

      throw new Error(inlineError ? `Inline error detected: ${inlineError}` : 'No success signal (toast or composer cleared) after post attempt.');
    } catch (err) {
      console.warn(`Post attempt ${attempt} failed: ${err.message || err}`);
      if (attempt === MAX_ATTEMPTS) {
        await saveDebug(page, 'tweet-post-failure');
        return { ok: false, error: err };
      }
      await page.waitForTimeout(1500 * attempt);
    }
  }
  return { ok: false, error: 'exhausted attempts' };
}
