'use strict';
/**
 * crawl-pages40.js  (FIXED — v1 basic FB + Quora crawler)
 *
 * Fixes applied vs original:
 *  #1  Credentials moved to .env
 *  #2  Parameterised SQL (mysql2)
 *  #3  Migrated from `mysql` to `mysql2/promise`
 *  #4  page.waitForTimeout() → sleep()
 *  #5  getOneOrTwo() truly random (was already correct in this version)
 *  #6  eta_tags loaded before crawl query (await, not callbacks)
 *  #7  getBotAnswer() call removed from page.evaluate() — it cannot run in
 *      browser context; this version simply doesn't answer questions
 *  #8  quoraLinks null-crash guarded with || []
 *  #10 Structured logging (winston)
 *  #11 gotoWithRetry() navigation with exponential back-off
 *  #12 page.setDefaultNavigationTimeout(0) set consistently
 *
 * NOTE: This is the earliest version; it does NOT answer unanswered Quora
 *       questions. Use crawl-pages42.js for the full pipeline.
 */

require('dotenv').config();

const puppeteer = require('puppeteer');
const db        = require('./config/db');
const logger    = require('./config/logger');
const { sleep, randomDelay, navigateTo, autoScroll, loadAllCookies, setViewport } = require('./utils/puppeteer');
const { isExcluded, sanitiseName } = require('./utils/filters');
const fs        = require('fs').promises;

// ── SQL ──────────────────────────────────────────────────────────────────────
const SQL_FB_QUEUE    = 'SELECT id, page_url, depth FROM ETA_Marketing.Discovered_ETA_Relevant_Pages WHERE depth < 4 AND (crawled = 0 OR last_crawl_date IS NULL OR DATEDIFF(now(), last_crawl_date) > 15) LIMIT 1;';
const SQL_QUORA_QUEUE = 'SELECT id, page_url, depth FROM ETA_Marketing.Discovered_ETA_Relevant_Quora_Pages WHERE depth < 4 AND (crawled = 0 OR last_crawl_date IS NULL OR DATEDIFF(now(), last_crawl_date) > 15) LIMIT 1;';
const SQL_ETA_TAGS    = 'SELECT tag FROM ETA_Marketing.ETA_Tags;';

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// FIX #5: truly random 1 or 2 (was already random in v40, but kept for parity)
function getOneOrTwo() {
  return randomInt(1, 2);
}

async function crawl(URL, pageDepth, whichQ, etaTags) {
  logger.info(`Will crawl: ${URL}`);

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-notifications'] });
  const page    = await browser.newPage();
  page.setDefaultNavigationTimeout(0);  // FIX #12

  try {
    await loadAllCookies(page);
    await sleep(randomInt(10, 20) * 1000);

    await navigateTo(page, URL);  // FIX #11: retry logic
    await setViewport(page);

    if (whichQ !== 3) await autoScroll(page);

    // ── Quora ──────────────────────────────────────────────────────────────
    if (URL.length > 30 && (URL.startsWith('https://www.quora.com') || URL.startsWith('https://quora.com'))) {
      logger.info('In Quora module');

      const data = await page.evaluate(() => ({ pageHTML: document.documentElement.outerHTML }));

      // FIX #8: guard null from .match()
      const quoraLinks = (data.pageHTML.match(/https:\/\/www\.quora\.com\/profile\/[a-z,A-Z,\-,0-9]+/gi) || []);
      logger.info(`Found ${quoraLinks.length} Quora profile links`);

      for (const qLink of quoraLinks) {
        if (!qLink.startsWith('https://www.quora.com/profile/') || qLink.length < 30) continue;

        let sName = qLink.replace('https://www.quora.com/profile/', '');
        const slash = sName.indexOf('/');
        if (slash > 0) sName = sName.substring(0, slash);

        const answerer_profile = `https://www.quora.com/profile/${sName}`;
        if (isExcluded(sName)) continue;

        const final_name = sanitiseName(sName);

        try {
          // FIX #2: parameterised query
          await db.query(
            'INSERT INTO ETA_Marketing.Discovered_Client_Leads(Full_Name, Profile_Page, Page_Discovered_In) VALUES (?, ?, ?)',
            [final_name, answerer_profile, URL]
          );
          logger.info(`Added Quora lead: ${final_name}`);
        } catch (err) {
          logger.debug(`Quora lead already in DB: ${err.message}`);
        }
      }
    }

    // ── Facebook ───────────────────────────────────────────────────────────
    else if (URL && URL.length > 20 &&
             (URL.startsWith('https://www.facebook.com') || URL.startsWith('https://facebook.com'))) {
      logger.info('In FB module...');

      const data = await page.evaluate(() => {
        const a1 = Array.from(document.querySelectorAll('div.x78zum5.xdt5ytf')).map(d => d.innerHTML);
        const a2 = Array.from(document.querySelectorAll('div[aria-label*="Comment by"]')).map(d => d.outerHTML);
        return { AllAnswerDivsHTML: [...a1, ...a2] };
      });

      const foundProfiles = [];

      for (const a of data.AllAnswerDivsHTML) {
        if (!a || a.length < 100) continue;

        let answerer_name = '';
        if (a.includes('aria-label="Comment by ')) {
          const ni = a.indexOf('aria-label="Comment by ') + 'aria-label="Comment by '.length;
          let nameText = a.substring(ni);
          nameText = nameText.substring(0, nameText.lastIndexOf(' ', nameText.indexOf(' ago')));
          answerer_name = nameText;
        }

        if (!a.includes('?comment_id=') && !a.includes('href="/groups/') &&
            !a.includes('https://www.facebook.com/profile.php?id=') &&
            !a.includes('https://www.facebook.com/')) continue;

        // Extract profile URL (simplified — full logic in crawl-pages42.js)
        let answerer_profile = '';
        if (a.indexOf('https://www.facebook.com/profile.php?id=') > -1) {
          const start = a.indexOf('https://www.facebook.com/profile.php?id=');
          const rest  = a.substring(start + 'https://www.facebook.com/profile.php?id='.length);
          const end   = rest.indexOf('&') > -1 && rest.indexOf('&') < 20 ? rest.indexOf('&') : rest.indexOf('"');
          answerer_profile = `https://www.facebook.com/profile.php?id=${rest.substring(0, end)}`;
        } else if (a.indexOf('?comment_id=') > -1) {
          const myHTML = a.substring(Math.max(0, a.indexOf('?comment_id=') - 60));
          const start  = myHTML.indexOf('https://www.facebook.com/');
          if (start !== -1) {
            const rest = myHTML.substring(start + 'https://www.facebook.com/'.length);
            answerer_profile = 'https://www.facebook.com/' + rest.substring(0, rest.indexOf('?comment_id='));
          }
        }

        if (!answerer_profile || answerer_profile.length < 26) continue;
        if (foundProfiles.includes(answerer_profile)) continue;
        foundProfiles.push(answerer_profile);

        if (isExcluded(answerer_name)) continue;
        const final_name = sanitiseName(answerer_name);

        try {
          await db.query(
            'INSERT INTO ETA_Marketing.Discovered_Client_Leads(Full_Name, Profile_Page, Page_Discovered_In) VALUES (?, ?, ?)',
            [final_name, answerer_profile, URL]
          );
          logger.info(`Added FB lead: ${final_name}`);
        } catch (err) {
          logger.debug(`FB lead already in DB: ${err.message}`);
        }
      }
    }

    // FIX #2: parameterised affinity update
    const table = whichQ === 1 ? 'Discovered_ETA_Relevant_Pages' : 'Discovered_ETA_Relevant_Quora_Pages';
    await db.query(`UPDATE ETA_Marketing.${table} SET ETA_Affinity = ? WHERE page_url = ?`, [5, URL]);
    logger.info('Updated DB record for crawled URL');

  } catch (e) {
    logger.error(`crawl() error for ${URL}: ${e}`);
  } finally {
    try { await browser.close(); } catch (_) {}
  }
}

// ── entry point ───────────────────────────────────────────────────────────────
async function main() {
  // FIX #6: load tags FIRST, then pick queue
  const tagRows = await db.query(SQL_ETA_TAGS);
  const etaTags = tagRows || [];
  logger.info(`Loaded ${etaTags.length} ETA tags`);

  const whichQ = getOneOrTwo();
  logger.info(`Selected queue: ${whichQ} (1=FB, 2=Quora)`);

  const sql  = whichQ === 1 ? SQL_FB_QUEUE : SQL_QUORA_QUEUE;
  const rows = await db.query(sql);

  if (!rows || rows.length === 0) {
    logger.info('No rows to process. Exiting.');
    await db.close();
    return;
  }

  const row   = rows[0];
  const table = whichQ === 1 ? 'Discovered_ETA_Relevant_Pages' : 'Discovered_ETA_Relevant_Quora_Pages';

  await db.query(
    `UPDATE ETA_Marketing.${table} SET crawled = 1, last_crawl_date = now() WHERE id = ?`,
    [row.id]
  );

  logger.info(`Will crawl: ${row.page_url}`);
  await crawl(row.page_url, row.depth, whichQ, etaTags);

  await db.close();
  logger.info('Session finished.');
}

main().catch(e => {
  logger.error(`Fatal: ${e}`);
  process.exit(1);
});
