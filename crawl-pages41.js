'use strict';
/**
 * crawl-pages41.js  (FIXED — v2: adds 24-hour Quora answer rate-limit gate)
 *
 * Fixes applied vs original:
 *  #1  Credentials moved to .env
 *  #2  Parameterised SQL (mysql2)
 *  #3  Migrated from `mysql` to `mysql2/promise`
 *  #4  page.waitForTimeout() → sleep()
 *  #5  pickQueue() truly random (removed `return 3` override)
 *  #6  eta_tags loaded before crawl query (await, not callbacks)
 *  #8  quoraLinks null-crash guarded with || []
 *  #9  *** KEY FIX: Quora 24-hr gate now properly awaited ***
 *      In the original the DB callback set `goun` but `goun` was checked
 *      synchronously before the callback could fire, so answering was
 *      always skipped. Now the check is await-ed before the gate.
 *  #10 Structured logging (winston)
 *  #11 gotoWithRetry() navigation with exponential back-off
 *  #12 page.setDefaultNavigationTimeout(0) set consistently
 *
 * NOTE: Use crawl-pages42.js for the canonical full-featured version.
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
const SQL_UNANSWERED  = 'SELECT id, page_url, depth FROM ETA_Marketing.Discovered_ETA_Relevant_Unanswered_Quora_Pages WHERE depth < 4 AND answered = 0 LIMIT 1;';
const SQL_ETA_TAGS    = 'SELECT tag FROM ETA_Marketing.ETA_Tags;';
const AI_URL          = process.env.AI_CHATBOT_URL || 'https://eta.yaitec.dev/?q=';

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickQueue() {
  // FIX #5: truly random 1-3 (original had `return 3` making it always 3)
  return randomInt(1, 3);
}

// ── Quora unanswered answering with properly awaited 24-hr gate ──────────────
async function answerQuoraQuestion(page, URL) {
  logger.info('Will try to answer unanswered Quora question');

  // FIX #9: await DB query before checking gate — in original this was
  // a callback so `goun` was always 0 when the if-block was evaluated
  let goun = 0;
  try {
    const rows = await db.query(
      'SELECT TIMESTAMPDIFF(SECOND, last_quora_answer_datetime, NOW()) AS qsecs FROM ETA_Marketing.params;'
    );
    const qsecs = rows.length > 0 ? parseInt(rows[0].qsecs) : 0;
    logger.info(`Seconds since last Quora answer: ${qsecs}`);
    if (qsecs > 86400) goun = 1;
  } catch (e) {
    logger.error(`Error checking last_quora_answer_datetime: ${e}`);
  }

  logger.info(`goun = ${goun}`);
  if (!goun) {
    logger.info('Less than 24 h since last Quora answer. Skipping.');
    return;
  }

  logger.info('Quora answering will proceed...');

  try {
    await page.evaluate(() => {
      document.querySelectorAll('button[tabindex="0"]').forEach(ab => {
        if (ab.innerText.toLowerCase().trim() === 'answer') ab.click();
      });
    });
    logger.info('"Answer" button clicked');
    await sleep(10000);

    const data2 = await page.evaluate(() => {
      const q1 = Array.from(document.querySelectorAll('div[class*="QuestionTitle"]')).map(d => d.innerText);
      const q2 = Array.from(document.querySelectorAll('div[class*="question_title"]')).map(d => d.innerText);
      return { q1, q2 };
    });

    const qtoanswer = (data2.q1[0] || data2.q2[0] || '').trim();
    logger.info(`Scraped question text: ${qtoanswer}`);
    if (!qtoanswer) return;

    // Get answer from AI
    await navigateTo(page, `${AI_URL}${encodeURIComponent(qtoanswer)}`);
    await sleep(15000);
    const botAnswer = await page.evaluate(() => document.documentElement.innerText);
    logger.info(`AI answer received (${botAnswer.length} chars)`);

    // Navigate back and post
    await navigateTo(page, URL);
    await sleep(5000);

    await page.evaluate(() => {
      document.querySelectorAll('button[tabindex="0"]').forEach(ab => {
        if (ab.innerText.toLowerCase().trim() === 'answer') ab.click();
      });
    });
    await sleep(5000);

    await page.evaluate((ans) => {
      document.querySelectorAll('div[contenteditable="true"]').forEach(ab => {
        ab.innerHTML = `<p>${ans}</p>`;
      });
    }, botAnswer);

    await sleep(2000);
    await page.click('text=Post');
    logger.info('Answer posted');
    await sleep(5000);

    // FIX #2: parameterised updates
    await db.query(
      'UPDATE ETA_Marketing.Discovered_ETA_Relevant_Unanswered_Quora_Pages SET answered = 1 WHERE page_url = ?',
      [URL]
    );
    await db.query('UPDATE ETA_Marketing.params SET last_quora_answer_datetime = NOW();');
    logger.info('Quora question marked answered in DB');

  } catch (e) {
    logger.error(`Error answering Quora question: ${e}`);
  }
}

async function crawlQuoraPage(page, URL) {
  logger.info('In Quora lead-extraction module');
  const data = await page.evaluate(() => ({ pageHTML: document.documentElement.outerHTML }));

  // FIX #8: null guard
  const quoraLinks = (data.pageHTML.match(/https:\/\/www\.quora\.com\/profile\/[a-z,A-Z,\-,0-9]+/gi) || []);
  logger.info(`Found ${quoraLinks.length} Quora profile links`);

  for (const qLink of quoraLinks) {
    if (!qLink.startsWith('https://www.quora.com/profile/') || qLink.length < 30) continue;

    let sName = qLink.replace('https://www.quora.com/profile/', '');
    const slash = sName.indexOf('/');
    if (slash > 0) sName = sName.substring(0, slash);

    if (isExcluded(sName)) continue;

    const answerer_profile = `https://www.quora.com/profile/${sName}`;
    const final_name       = sanitiseName(sName);

    try {
      // FIX #2
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

async function crawl(URL, pageDepth, whichQ, etaTags) {
  logger.info(`Will crawl: ${URL}`);

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-notifications'] });
  const page    = await browser.newPage();
  page.setDefaultNavigationTimeout(0);  // FIX #12

  try {
    await loadAllCookies(page);
    await sleep(randomInt(10, 20) * 1000);

    await navigateTo(page, URL);  // FIX #11
    await setViewport(page);
    if (whichQ !== 3) await autoScroll(page);

    if (URL.length > 30 && (URL.startsWith('https://www.quora.com') || URL.startsWith('https://quora.com'))) {
      if (URL.toLowerCase().includes('/unanswered/')) {
        await answerQuoraQuestion(page, URL);
      } else {
        await crawlQuoraPage(page, URL);
      }
    }

    // FIX #2: parameterised update
    const table = whichQ === 1 ? 'Discovered_ETA_Relevant_Pages'
                : whichQ === 2 ? 'Discovered_ETA_Relevant_Quora_Pages'
                :                'Discovered_ETA_Relevant_Unanswered_Quora_Pages';
    await db.query(`UPDATE ETA_Marketing.${table} SET ETA_Affinity = ? WHERE page_url = ?`, [5, URL]);

  } catch (e) {
    logger.error(`crawl() error: ${e}`);
  } finally {
    try { await browser.close(); } catch (_) {}
  }
}

// ── entry point ───────────────────────────────────────────────────────────────
async function main() {
  // FIX #6: tags loaded before queue selection
  const tagRows = await db.query(SQL_ETA_TAGS);
  const etaTags = tagRows || [];
  logger.info(`Loaded ${etaTags.length} ETA tags`);

  // FIX #5: truly random 1-3
  const whichQ = pickQueue();
  logger.info(`Selected queue: ${whichQ}`);

  const sql  = whichQ === 1 ? SQL_FB_QUEUE : whichQ === 2 ? SQL_QUORA_QUEUE : SQL_UNANSWERED;
  const rows = await db.query(sql);

  if (!rows || rows.length === 0) {
    logger.info('No rows to process. Exiting.');
    await db.close();
    return;
  }

  const row   = rows[0];
  const table = whichQ === 1 ? 'Discovered_ETA_Relevant_Pages'
              : whichQ === 2 ? 'Discovered_ETA_Relevant_Quora_Pages'
              :                'Discovered_ETA_Relevant_Unanswered_Quora_Pages';

  await db.query(
    `UPDATE ETA_Marketing.${table} SET crawled = 1, last_crawl_date = now() WHERE id = ?`,
    [row.id]
  );

  await crawl(row.page_url, row.depth, whichQ, etaTags);
  await db.close();
  logger.info('Session finished.');
}

main().catch(e => {
  logger.error(`Fatal: ${e}`);
  process.exit(1);
});
