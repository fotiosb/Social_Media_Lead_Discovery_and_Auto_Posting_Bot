'use strict';
/**
 * discover-pages8.js
 * Discovery Phase — Quora search URL harvesting.
 *
 * Reads tags from ETA_Tags, searches Quora for each tag, and stores
 * discovered Quora URLs in Discovered_ETA_Relevant_Quora_Pages or
 * Discovered_ETA_Relevant_Unanswered_Quora_Pages.
 *
 * Fixes applied vs original:
 *  #1  Credentials moved to .env
 *  #2  Parameterised SQL (mysql2)
 *  #3  Migrated from `mysql` to `mysql2/promise`
 *  #4  page.waitForTimeout() → sleep()
 *  #6  Race condition: eta_tags and search rows now loaded with await (no callbacks)
 *  #8  quoraLinks null-crash guarded with || []
 *  #10 Structured logging (winston)
 *  #11 navigateTo() with retry logic
 */

require('dotenv').config();

const puppeteer = require('puppeteer');
const db        = require('./config/db');
const logger    = require('./config/logger');
const { sleep, navigateTo, loadAllCookies } = require('./utils/puppeteer');

const SQL_TAGS_TO_SEARCH = `
  SELECT id, tag
  FROM ETA_Tags
  WHERE searched = 0
     OR Last_Datetime_Searched IS NULL
     OR DATEDIFF(NOW(), Last_Datetime_Searched) > 7
  LIMIT 1
`;
const SQL_ALL_TAGS = 'SELECT tag FROM ETA_Tags';

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Fix #6: load both queries with await — no callback race condition
  const [tagRows]    = await db.query(SQL_ALL_TAGS);
  const eta_tags     = tagRows;

  const [searchRows] = await db.query(SQL_TAGS_TO_SEARCH);

  if (searchRows.length === 0) {
    logger.info('No Quora search tags to process. Exiting.');
    await db.end();
    return;
  }

  for (const row of searchRows) {
    // Mark as searched immediately to avoid duplicates on crash
    await db.query(
      'UPDATE ETA_Tags SET searched = 1, Last_Datetime_Searched = NOW() WHERE id = ?',
      [row.id]
    );

    const quoraSearchUrl = `https://www.quora.com/search?q=${encodeURIComponent(row.tag)}`;
    logger.info(`Quora search: ${quoraSearchUrl}`);
    await grab(quoraSearchUrl, eta_tags);
  }

  await db.end();
  logger.info('discover-pages8.js finished.');
}

// ─── Grab ────────────────────────────────────────────────────────────────────

async function grab(URL, eta_tags) {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page    = await browser.newPage();
  page.setDefaultNavigationTimeout(0);

  try {
    await loadAllCookies(page);
    await sleep(5000);

    await navigateTo(page, URL);

    const data = await page.evaluate(() => {
      const pageText = document.body.innerText.toLowerCase();
      const pageHTML = document.documentElement.outerHTML;
      return { pageHTML, pageText };
    });

    // Fix #8: .match() can return null — guard with || []
    const alinks = data.pageHTML.match(/https:\/\/www\.quora\.com\/[a-zA-Z\-0-9]+/gi) || [];
    const ulinks = data.pageHTML.match(/https:\/\/www\.quora\.com\/unanswered\/[a-zA-Z\-0-9]+/gi) || [];
    const links  = ulinks.length ? [...alinks, ...ulinks] : alinks;

    logger.info(`Found ${links.length} links`);

    for (let myurl of links) {
      myurl = myurl.trim();

      if (myurl.length === 0 || myurl.length < 40 || !myurl.includes('.quora.com/')) {
        logger.debug(`Rejected URL: ${myurl}`);
        continue;
      }

      logger.debug(`Storing URL: ${myurl}`);

      // Compute affinity score
      const lc = data.pageText;
      const affinityScore = eta_tags.reduce(
        (hits, t) => hits + (lc.includes(t.tag.toLowerCase()) ? 1 : 0), 0
      );

      const isUnanswered = myurl.toLowerCase().includes('/unanswered/');
      const table = isUnanswered
        ? 'Discovered_ETA_Relevant_Unanswered_Quora_Pages'
        : 'Discovered_ETA_Relevant_Quora_Pages';

      try {
        // Fix #2: parameterised INSERT
        await db.query(
          `INSERT INTO ${table} (page_url, ETA_Affinity) VALUES (?, ?)`,
          [myurl, affinityScore]
        );
        logger.debug('URL stored in DB');
      } catch {
        logger.debug(`Already in DB: ${myurl}`);
      }
    }
  } catch (err) {
    logger.error(`Error in grab(${URL}): ${err.message}`);
  } finally {
    await browser.close();
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

main().catch(err => {
  logger.error(`Fatal: ${err.message}`, err);
  process.exit(1);
});
