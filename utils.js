async function detectChallengePage(page) {
  try {
    return await page.evaluate(() => {
      // Cloudflare
      if (document.title === 'Just a moment...' ||
          window._cf_chl_opt ||
          document.querySelector('script[src*="/cdn-cgi/challenge-platform/"]') ||
          (document.querySelector('meta[http-equiv="refresh"]') && document.title.includes('Just a moment'))) {
        return 'cloudflare';
      }

      // SiteGround
      if (document.title === 'Robot Challenge Screen' ||
          window.sgchallenge ||
          Array.from(document.querySelectorAll('script')).some(script =>
            script.textContent.includes('sgchallenge'))) {
        return 'siteground';
      }

      return false;
    });
  } catch (err) {
    return false;
  }
}

async function waitForChallengeBypass(page, maxWaitSeconds = 8) {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitSeconds * 1000) {
    const challenge = await detectChallengePage(page);
    if (!challenge) {
      return true;
    }
    await page.waitForTimeout(100);
  }

  return false;
}

// Automatically dismisses modals and other UI elements
async function dismissModals(page) {

  // blind fire an Escape keypress
  await page.keyboard.press('Escape');

  // look for close buttons to press
  const selectors = [
    '[data-dismiss="modal"]',  // bootstrap
    '[aria-label="Close dialog"]',
    '[aria-label="Close"]',
    '[aria-label="button.close"]',
    '[aria-modal="true"] [aria-label="Close"]',
    '[aria-modal="true"] [title="Close"]',
    '[aria-modal="true"] [data-action="close"]',
    '.popup .close-button',
    '.modal .close',
    'a.close-popup',
    '[role="dialog"] .close-btn',
    '[role="dialog"] .close-button',
    '[role="dialog"] .close',
    '[role="dialog"] [aria-label="Close"]',
    'button[data-testid="close-welcome-modal"]',
    'button.spu-close-popup',
    '#campaign_modal_wrapper #continue_to_site',
    '.close-footer-btn'
  ].join(', ');
  const maxWaitTime = 2500;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitTime) {
    const closeButton = await page.$(selectors);
    if (!closeButton) {
      break;
    }

    if (await closeButton.isVisible().catch(() => false)) {
      await closeButton.click().catch(() => {});
    }

    await page.waitForTimeout(500);
  }
}

async function initAdblocker() {
  const { PlaywrightBlocker } = require('@ghostery/adblocker-playwright');
  const fetch = require('cross-fetch');
  const fs = require('fs');

  const base = process.env.BR_ADBLOCK_BASE || 'adsandtrackers';
  const additionalLists = process.env.BR_ADBLOCK_LISTS;

  let blocker;
  switch (base) {
    case 'none':
      blocker = PlaywrightBlocker.empty();
      console.log('Ad blocking enabled (no base filters)');
      break;
    case 'full':
      blocker = await PlaywrightBlocker.fromPrebuiltFull(fetch);
      console.log('Ad blocking enabled (full: ads + tracking + annoyances + cookies)');
      break;
    case 'ads':
      blocker = await PlaywrightBlocker.fromPrebuiltAdsOnly(fetch);
      console.log('Ad blocking enabled (ads only)');
      break;
    case 'adsandtrackers':
    default:
      blocker = await PlaywrightBlocker.fromPrebuiltAdsAndTracking(fetch);
      console.log('Ad blocking enabled (ads + tracking)');
      break;
  }

  if (additionalLists) {
    const customLists = additionalLists.split(',').map(s => s.trim());

    for (const listPath of customLists) {
      let listContent;
      if (listPath.startsWith('http://') || listPath.startsWith('https://')) {
        const response = await fetch(listPath);
        listContent = await response.text();
      } else {
        listContent = fs.readFileSync(listPath, 'utf8');
      }

      const filters = listContent
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('!'));

      console.log(`Loaded ${listContent.split('\n').length} lines (${filters.length} active rules) from ${listPath}`);

      blocker.updateFromDiff({ added: filters });

      console.log(`Successfully applied custom list ${listPath}`);
    }
  }

  return blocker;
}

module.exports = {
  detectChallengePage,
  waitForChallengeBypass,
  dismissModals,
  initAdblocker
};
