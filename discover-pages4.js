'use strict';
/**
 * discover-pages4.js
 * PHASE 1 — Discovery: Google → Facebook page/group URL harvesting.
 *
 * Reads search phrases from ETA_Marketing_Relevant_Web_Searches, performs a
 * Google search for each phrase restricted to site:facebook.com, extracts
 * qualifying Facebook URLs, computes an ETA Affinity score, and stores them
 * in Discovered_ETA_Relevant_Pages for later crawling.
 *
 * Fixes applied vs. original:
 *  - Credentials moved to .env (dotenv)
 *  - mysql → mysql2 with parameterized queries (SQL injection fix)
 *  - page.waitForTimeout → sleep() (deprecated API fix)
 *  - Winston structured logging
 *  - gotoWithRetry for transient network failures
 *  - Null-safe URL list handling
 */

require('dotenv').config();
const puppeteer = require('puppeteer');
const { query, close } = require('./db');
const logger = require('./logger');
const { sleep, randomDelay, gotoWithRetry, autoScroll, isExcluded } = require('./helpers');

const SQL_SEARCH_PHRASES = `
  SELECT id, search_phrase
  FROM ETA_Marketing_Relevant_Web_Searches
  WHERE searched = 0
     OR Last_Datetime_Searched IS NULL
     OR DATEDIFF(NOW(), Last_Datetime_Searched) > 7
  LIMIT 10
`;

const SQL_ALL_TAGS = 'SELECT tag FROM ETA_Tags';

async function grab(searchPhrase, etaTags) {
  const googleURL = `https://www.google.com/search?q=${encodeURIComponent(searchPhrase + ' site:facebook.com')}`;
  logger.info(`Searching Google: ${googleURL}`);

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);

    await gotoWithRetry(page, googleURL, { waitUntil: 'domcontentloaded' });
    await sleep(3000);

    const data = await page.evaluate(() => ({
      pageText: (document.body.innerText || '').toLowerCase(),
      links: Array.from(document.querySelectorAll('a')).map(a => a.href),
    }));

    const links = data.links || [];

    for (const rawUrl of links) {
      const myurl = rawUrl.trim();

      // Keep only meaningful Facebook URLs; drop short/video/photo links
      if (
        (myurl.startsWith('https://www.facebook.com') || myurl.startsWith('https://facebook.com')) &&
        (myurl.length < 40 || myurl.includes('/videos/') || myurl.includes('/photos/'))
      ) continue;

      if (
        myurl.length < 60 ||
        (
          !myurl.startsWith('https://www.facebook.com') &&
          !myurl.startsWith('https://facebook.com') &&
          !myurl.startsWith('https://www.quora.com') &&
          !myurl.startsWith('https://quora.com') &&
          !myurl.startsWith('https://www.answers.com') &&
          !myurl.startsWith('https://answers.com') &&
          !myurl.startsWith('https://www.pinterest.com') &&
          !myurl.startsWith('https://pinterest.com') &&
          !myurl.startsWith('https://www.yelp.com') &&
          !myurl.startsWith('https://yelp.com')
        )
      ) continue;

      // Compute affinity score
      const lc = data.pageText;
      const tagHits = etaTags.filter(t => lc.includes(t.toLowerCase())).length;

      try {
        await query(
          'INSERT INTO Discovered_ETA_Relevant_Pages (page_url, ETA_Affinity) VALUES (?, ?)',
          [myurl, tagHits]
        );
        logger.info(`Stored URL: ${myurl} (affinity: ${tagHits})`);
      } catch (e) {
        if (e.code !== 'ER_DUP_ENTRY') logger.error(`DB insert error: ${e.message}`);
      }
    }
  } catch (e) {
    logger.error(`grab() failed for "${searchPhrase}": ${e.message}`);
  } finally {
    await browser.close();
  }
}

async function main() {
  try {
    const [tagRows] = await query(SQL_ALL_TAGS);
    const etaTags = tagRows.map(r => r.tag);

    const [phraseRows] = await query(SQL_SEARCH_PHRASES);
    if (!phraseRows.length) {
      logger.info('No search phrases to process. Exiting.');
      return;
    }

    logger.info(`Processing ${phraseRows.length} search phrase(s)`);

    for (const row of phraseRows) {
      // Mark as searched before fetching (prevents duplicate runs)
      await query(
        'UPDATE ETA_Marketing_Relevant_Web_Searches SET searched = 1, Last_Datetime_Searched = NOW() WHERE id = ?',
        [row.id]
      );
      await grab(row.search_phrase, etaTags);
      await sleep(randomInt(5, 12) * 1000); // polite delay between searches
    }
  } finally {
    await close();
  }
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

main().catch(e => { logger.error(`Fatal: ${e.message}`); process.exit(1); });
