'use strict';
/**
 * crawl-pages42.js  (canonical crawl script — v3)
 * Processes ONE URL per run, chosen randomly from:
 *   1. FB pages/groups queue
 *   2. Quora discussion pages queue
 *   3. Unanswered Quora questions queue
 *
 * Fixes applied vs original:
 *  #1  Credentials moved to .env
 *  #2  All SQL uses parameterised queries (mysql2)
 *  #3  Migrated from deprecated `mysql` to `mysql2/promise`
 *  #4  page.waitForTimeout() replaced with sleep()
 *  #5  getOneToThree() no longer hardcoded to return 3 — true random 1-3
 *  #6  Race condition: eta_tags loaded before crawl query (await, not callbacks)
 *  #8  quoraLinks null crash guarded with || []
 *  #9  Quora 24-hour gate now awaited correctly before checking goun
 *  #10 Structured logging (winston)
 *  #11 navigateTo() wraps goto with retry + exponential backoff
 *  #12 page3.setDefaultNavigationTimeout(0) now set
 */

require('dotenv').config();

const puppeteer = require('puppeteer');
const db        = require('./config/db');
const logger    = require('./config/logger');
const { sleep, randomDelay, navigateTo, autoScroll, loadAllCookies, setViewport } = require('./utils/puppeteer');
const { isExcluded, sanitiseName, sanitiseText } = require('./utils/filters');

const AI_BOT_URL = process.env.AI_BOT_URL || 'https://eta.yaitec.dev';
const QUORA_ANSWER_INTERVAL_HRS = parseFloat(process.env.QUORA_ANSWER_INTERVAL_HOURS || '24');

// ─── Queue selection ─────────────────────────────────────────────────────────

// Fix #5: returns a genuine random integer 1–3 (no hardcoded override)
function getOneToThree() {
  return Math.floor(Math.random() * 3) + 1;
}

const QUEUE = {
  1: {
    select: `SELECT id, page_url, depth FROM Discovered_ETA_Relevant_Pages
             WHERE depth < 4 AND (crawled = 0 OR last_crawl_date IS NULL OR DATEDIFF(NOW(), last_crawl_date) > 15)
             LIMIT 1`,
    markCrawled: (id) => db.query(
      'UPDATE Discovered_ETA_Relevant_Pages SET crawled = 1, last_crawl_date = NOW() WHERE id = ?', [id]
    ),
    markUnreachable: (url) => db.query(
      'INSERT INTO Discovered_ETA_Relevant_Pages (page_url, unreachable) VALUES (?, 1) ON DUPLICATE KEY UPDATE unreachable = 1', [url]
    ),
    updateAffinity: (score, url) => db.query(
      'UPDATE Discovered_ETA_Relevant_Pages SET ETA_Affinity = ? WHERE page_url = ?', [score, url]
    ),
  },
  2: {
    select: `SELECT id, page_url, depth FROM Discovered_ETA_Relevant_Quora_Pages
             WHERE depth < 4 AND (crawled = 0 OR last_crawl_date IS NULL OR DATEDIFF(NOW(), last_crawl_date) > 15)
             LIMIT 1`,
    markCrawled: (id) => db.query(
      'UPDATE Discovered_ETA_Relevant_Quora_Pages SET crawled = 1, last_crawl_date = NOW() WHERE id = ?', [id]
    ),
    markUnreachable: (url) => db.query(
      'INSERT INTO Discovered_ETA_Relevant_Quora_Pages (page_url, unreachable) VALUES (?, 1) ON DUPLICATE KEY UPDATE unreachable = 1', [url]
    ),
    updateAffinity: (score, url) => db.query(
      'UPDATE Discovered_ETA_Relevant_Quora_Pages SET ETA_Affinity = ? WHERE page_url = ?', [score, url]
    ),
  },
  3: {
    select: `SELECT id, page_url, depth FROM Discovered_ETA_Relevant_Unanswered_Quora_Pages
             WHERE depth < 4 AND answered = 0
             LIMIT 1`,
    markCrawled: (id) => db.query(
      'UPDATE Discovered_ETA_Relevant_Unanswered_Quora_Pages SET crawled = 1, last_crawl_date = NOW() WHERE id = ?', [id]
    ),
    markUnreachable: (url) => db.query(
      'INSERT INTO Discovered_ETA_Relevant_Unanswered_Quora_Pages (page_url, unreachable) VALUES (?, 1) ON DUPLICATE KEY UPDATE unreachable = 1', [url]
    ),
    updateAffinity: (score, url) => db.query(
      'UPDATE Discovered_ETA_Relevant_Unanswered_Quora_Pages SET ETA_Affinity = ? WHERE page_url = ?', [score, url]
    ),
  },
};

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Fix #6: load tags first, synchronously with await, before any crawl logic
  const [tagRows] = await db.query('SELECT tag FROM ETA_Tags');
  const eta_tags  = tagRows;

  const whichQ = getOneToThree();
  const queue  = QUEUE[whichQ];

  logger.info(`Selected queue ${whichQ}`);

  const [rows] = await db.query(queue.select);

  if (!rows.length) {
    logger.info(`No URLs to crawl in queue ${whichQ}. Exiting.`);
    await db.end();
    return;
  }

  const row = rows[0];
  logger.info(`Will crawl: ${row.page_url}`);

  // Mark crawled immediately before navigation to prevent duplicate runs
  await queue.markCrawled(row.id);

  try {
    await crawl(row.page_url, row.depth, whichQ, queue, eta_tags);
  } catch (err) {
    logger.error(`crawl() threw: ${err.message}`, err);
    await queue.markUnreachable(row.page_url);
  }

  await db.end();
  logger.info('crawl-pages42.js finished.');
}

// ─── Crawl dispatcher ────────────────────────────────────────────────────────

async function crawl(URL, page_depth, whichQ, queue, eta_tags) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-notifications'],
  });
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(0);

  try {
    await loadAllCookies(page);
    await sleep(5000);

    if (whichQ !== 3) await randomDelay();

    // Fix #11: navigateTo retries on timeout
    await navigateTo(page, URL);
    await setViewport(page);

    if (whichQ !== 3) await autoScroll(page);

    if (URL.startsWith('https://www.quora.com') || URL.startsWith('https://quora.com')) {
      await handleQuora(page, browser, URL, whichQ, queue, eta_tags);
    } else if (URL.startsWith('https://www.facebook.com') || URL.startsWith('https://facebook.com')) {
      await handleFacebook(page, browser, URL, whichQ, queue, eta_tags);
    }

    await queue.updateAffinity(5, URL);

  } catch (err) {
    logger.error(`Navigation error for ${URL}: ${err.message}`);
    await queue.markUnreachable(URL);
    throw err;
  } finally {
    await browser.close();
  }
}

// ─── Quora handler ───────────────────────────────────────────────────────────

async function handleQuora(page, browser, URL, whichQ, queue, eta_tags) {
  logger.info('Quora module');

  if (URL.toLowerCase().includes('/unanswered/')) {
    await handleQuoraUnanswered(page, URL, queue);
  } else {
    await handleQuoraLeads(page, URL, eta_tags);
  }
}

async function handleQuoraUnanswered(page, URL, queue) {
  logger.info('Attempting to answer unanswered Quora question');

  // Fix #9: await the DB check so goun is set before the gate is evaluated
  const [paramRows] = await db.query(
    'SELECT TIMESTAMPDIFF(SECOND, last_quora_answer_datetime, NOW()) AS qsecs FROM params'
  );
  const qsecs = paramRows[0] ? parseInt(paramRows[0].qsecs, 10) : 0;
  logger.info(`Seconds since last Quora answer: ${qsecs}`);

  const requiredSecs = QUORA_ANSWER_INTERVAL_HRS * 3600;
  if (qsecs < requiredSecs) {
    logger.info(`Rate limit in effect — skipping Quora answer (need ${requiredSecs}s, have ${qsecs}s)`);
    return;
  }

  try {
    // Click the Answer button
    await page.evaluate(() => {
      document.querySelectorAll('button[tabindex="0"]').forEach(btn => {
        if (btn.innerText.toLowerCase().trim() === 'answer') btn.click();
      });
    });
    logger.info('Quora "Answer" button clicked');
    await sleep(10000);

    // Get the question text
    const { QuestionTexts, QuestionTexts2 } = await page.evaluate(() => ({
      QuestionTexts : Array.from(document.querySelectorAll('div[class*="QuestionTitle"]')).map(d => d.innerText),
      QuestionTexts2: Array.from(document.querySelectorAll('div[class*="question_title"]')).map(d => d.innerText),
    }));

    const qtoanswer = QuestionTexts[0] || QuestionTexts2[0] || null;
    logger.info(`Question text: ${qtoanswer}`);

    if (!qtoanswer) {
      logger.warn('Could not extract question text — aborting answer');
      return;
    }

    // Fetch answer from AI bot
    // Fix #7: AI bot is called via page.goto (external page), not inside evaluate()
    await navigateTo(page, `${AI_BOT_URL}/?q=${encodeURIComponent(qtoanswer)}`, { waitUntil: 'load' });
    logger.info('Fetched AI bot page');
    await sleep(15000);

    const { bodyText: botTextAnswer } = await page.evaluate(() => ({
      bodyText: document.documentElement.innerText,
    }));
    logger.info(`Bot answer length: ${botTextAnswer?.length}`);

    // Go back to the question page and post the answer
    await navigateTo(page, URL);
    await page.evaluate(() => {
      document.querySelectorAll('button[tabindex="0"]').forEach(btn => {
        if (btn.innerText.toLowerCase().trim() === 'answer') btn.click();
      });
    });
    logger.info('Quora "Answer" button clicked again — waiting for dialog');
    await sleep(5000);

    await page.evaluate((answer) => {
      document.querySelectorAll('div[contenteditable="true"]').forEach(ab => {
        ab.innerHTML = `<p>${answer}</p>`;
      });
    }, botTextAnswer);

    await sleep(2000);

    try {
      await page.click('text=Post');
    } catch {
      // Fallback: evaluate click if selector method fails
      await page.evaluate(() => {
        document.querySelectorAll('button[tabindex="0"]').forEach(btn => {
          if (btn.innerText.includes('Post')) btn.click();
        });
      });
    }
    logger.info('Answer posted to Quora');
    await sleep(5000);

    // Fix #2: parameterised update
    await db.query(
      'UPDATE Discovered_ETA_Relevant_Unanswered_Quora_Pages SET answered = 1 WHERE page_url = ?',
      [URL]
    );
    await db.query('UPDATE params SET last_quora_answer_datetime = NOW()');

  } catch (err) {
    logger.error(`Error answering Quora question: ${err.message}`);
  }
}

async function handleQuoraLeads(page, URL, eta_tags) {
  const { pageHTML } = await page.evaluate(() => ({
    pageHTML: document.documentElement.outerHTML,
  }));

  // Fix #8: guard .match() result against null
  const quoraLinks = (pageHTML.match(/https:\/\/www\.quora\.com\/profile\/[a-zA-Z\-0-9]+/gi) || []);
  logger.info(`Found ${quoraLinks.length} Quora profile links`);

  for (const qLink of quoraLinks) {
    if (!qLink.startsWith('https://www.quora.com/profile/') || qLink.length < 30) continue;

    let sName = qLink.replace('https://www.quora.com/profile/', '');
    const slashIdx = sName.indexOf('/');
    if (slashIdx > 0) sName = sName.substring(0, slashIdx);

    const profile = `https://www.quora.com/profile/${sName}`;

    if (isExcluded(sName)) {
      logger.debug(`Excluded Quora profile: ${sName}`);
      continue;
    }

    const name = sanitiseName(sName);
    if (!name) continue;

    try {
      // Fix #2: parameterised INSERT
      await db.query(
        'INSERT INTO Discovered_Client_Leads (Full_Name, Profile_Page, Page_Discovered_In) VALUES (?, ?, ?)',
        [name, profile, URL]
      );
      logger.info(`Stored Quora lead: ${name}`);
    } catch {
      logger.debug(`Quora lead already in DB: ${profile}`);
    }
  }
}

// ─── Facebook handler ────────────────────────────────────────────────────────

async function handleFacebook(page, browser, URL, whichQ, queue, eta_tags) {
  logger.info('Facebook module');

  const foundProfiles  = new Set(); // commenters
  const foundProfiles2 = new Set(); // reactors

  // ── Commenters ──────────────────────────────────────────────────────────────
  try {
    const { AllAnswerDivsHTML } = await page.evaluate(() => {
      const d1 = Array.from(document.querySelectorAll('div.x78zum5.xdt5ytf')).map(d => d.innerHTML);
      const d2 = Array.from(document.querySelectorAll('div[aria-label*="Comment by"]')).map(d => d.outerHTML);
      return { AllAnswerDivsHTML: [...d1, ...d2] };
    });

    logger.info(`Found ${AllAnswerDivsHTML.length} comment divs`);

    for (const a of AllAnswerDivsHTML) {
      if (!a || a.length < 100) continue;

      const result = await processFbCommentDiv(a, page, URL, eta_tags, foundProfiles);
      if (result) foundProfiles.add(result);
    }
  } catch (err) {
    logger.error(`FB commenter module error: ${err.message}`);
  }

  // ── Reactors (Like / Love / Wow dialogs) ────────────────────────────────────
  try {
    await randomDelay();
    await navigateTo(page, URL);
    await setViewport(page);
    await autoScroll(page);

    for (const reaction of ['Like', 'Love', 'Wow']) {
      const profiles = await scrapeReactionDialog(page, reaction);
      profiles.forEach(p => foundProfiles2.add(p));
    }

    logger.info(`Unique reactor profiles found: ${foundProfiles2.size}`);

    await sleep(10000);
  } catch (err) {
    logger.error(`FB reactor module error: ${err.message}`);
  }

  // ── Process reactor profiles on a fresh page ─────────────────────────────────
  try {
    await page.close();

    // Fix #12: page3 also gets setDefaultNavigationTimeout(0)
    const page3 = await browser.newPage();
    page3.setDefaultNavigationTimeout(0);
    await sleep(5000);
    await loadAllCookies(page3);
    await sleep(5000);

    for (const profileLink of foundProfiles2) {
      await processReactorProfile(page3, profileLink, URL);
    }
  } catch (err) {
    logger.error(`Outer reactor FB module error: ${err.message}`);
  }
}

// ─── FB helper: parse one comment div and save lead ──────────────────────────

async function processFbCommentDiv(a, page, URL, eta_tags, foundProfiles) {
  let answerer_name   = '';
  let answerer_profile = '';
  let biType = 0;

  // Extract name from aria-label
  if (a.includes('aria-label="Comment by ')) {
    const nameIndex1 = a.indexOf('aria-label="Comment by ') + 'aria-label="Comment by '.length;
    let nameText = a.substring(nameIndex1);
    let ni = nameText.indexOf(' ago');
    nameText = nameText.substring(0, ni);
    ni = nameText.lastIndexOf(' '); nameText = nameText.substring(0, ni);
    ni = nameText.lastIndexOf(' '); nameText = nameText.substring(0, ni);
    answerer_name = nameText;
  }

  // Extract profile URL
  const profileResult = extractFbProfileUrl(a);
  if (!profileResult) return null;

  ({ profile: answerer_profile, biType } = profileResult);

  if (foundProfiles.has(answerer_profile)) return null;

  // Affinity check
  const myatext = a.toLowerCase();
  const answerTagHits = eta_tags.reduce((h, t) => h + (myatext.includes(t.tag.toLowerCase()) ? 1 : 0), 0);

  if (isExcluded(answerer_name.toLowerCase())) {
    logger.debug(`Excluded commenter: ${answerer_name}`);
    return null;
  }

  let final_answerer_name = sanitiseName(answerer_name) || '';

  // Navigate to the profile to get contact info
  try {
    await randomDelay();
    await navigateTo(page, answerer_profile);
    await setViewport(page);

    const { htmlofinterest } = await page.evaluate(() => ({
      htmlofinterest: document.documentElement.outerHTML,
    }));

    const aboutContactLink = extractAboutContactLink(htmlofinterest, answerer_profile);
    if (!aboutContactLink) return null;

    const contactInfo = await scrapeContactInfo(page, aboutContactLink);
    if (!contactInfo) return null;

    if (!final_answerer_name) {
      final_answerer_name = extractNameFromContactPage(contactInfo);
    }

    logger.info(`Saving FB commenter lead: ${final_answerer_name}`);

    // Fix #2: parameterised INSERT
    await db.query(
      'INSERT INTO Discovered_Client_Leads (Full_Name, Profile_Page, Page_Discovered_In, Contact_Info) VALUES (?, ?, ?, ?)',
      [final_answerer_name, answerer_profile, URL, sanitiseText(contactInfo)]
    );
    return answerer_profile;
  } catch {
    return null;
  }
}

// ─── FB helper: scrape one reaction dialog ───────────────────────────────────

async function scrapeReactionDialog(page, reactionLabel) {
  await page.evaluate((label) => {
    document.querySelectorAll(`div[aria-label*="${label}:"]`).forEach(el => el.click());
  }, reactionLabel);

  await sleep(10000);

  const { AllDialogsProfileLinks } = await page.evaluate(() => {
    const links = [];
    document.querySelectorAll('div[role="dialog"]').forEach(d => {
      Array.from(d.getElementsByTagName('a')).forEach(a => {
        const url = a.href;
        if (url.includes('/user/') && !url.startsWith('https://www.facebook.com/'))
          links.push('https://www.facebook.com' + url.substring(0, url.indexOf('?')));
        else if (url.includes('/user/') && url.startsWith('https://www.facebook.com/'))
          links.push(url.substring(0, url.indexOf('?')));
        else if (url.startsWith('https://www.facebook.com/') && url.includes('/profile.php?'))
          links.push(url.substring(0, url.indexOf('&')));
        else if (url.startsWith('https://www.facebook.com/'))
          links.push(url.substring(0, url.indexOf('?')));
      });
    });
    return { AllDialogsProfileLinks: links };
  });

  logger.info(`${reactionLabel}: ${AllDialogsProfileLinks.length} reactor profiles found`);
  return AllDialogsProfileLinks;
}

// ─── FB helper: process a single reactor profile ─────────────────────────────

async function processReactorProfile(page3, profileLink, URL) {
  if (!isValidProfileLink(profileLink)) return;

  try {
    await randomDelay();
    await navigateTo(page3, profileLink);
    await setViewport(page3);

    const { htmlofinterest } = await page3.evaluate(() => ({
      htmlofinterest: document.documentElement.outerHTML,
    }));

    // Resolve real profile URL
    let realProfile = profileLink;
    if (htmlofinterest.includes('<a aria-label="View profile"')) {
      const s1 = htmlofinterest.substring(htmlofinterest.indexOf('<a aria-label="View profile"') + '<a aria-label="View profile"'.length);
      const s2 = s1.substring(s1.indexOf(' href="') + ' href="'.length);
      realProfile = s2.substring(0, s2.indexOf('"'));
    } else {
      realProfile = page3.url();
    }

    logger.debug(`Reactor real profile: ${realProfile}`);
    await randomDelay();
    await navigateTo(page3, realProfile);
    await setViewport(page3);

    const { html2 } = await page3.evaluate(() => ({ html2: document.documentElement.outerHTML }));
    const aboutContactLink = extractAboutContactLink(html2, realProfile);
    if (!aboutContactLink) return;

    const contactInfo = await scrapeContactInfo(page3, aboutContactLink);
    if (!contactInfo) return;

    let final_answerer_name = '';
    if (realProfile.includes('profile.php?id=')) {
      final_answerer_name = extractNameFromContactPage(contactInfo);
    } else {
      const ri1 = realProfile.indexOf('https://www.facebook.com/') + 'https://www.facebook.com/'.length;
      let urlName = realProfile.substring(ri1);
      const ri2 = urlName.indexOf('/');
      if (ri2 !== -1) urlName = urlName.substring(0, ri2);
      final_answerer_name = sanitiseName(urlName) || '';
    }

    if (isExcluded(final_answerer_name.toLowerCase())) return;

    if (!final_answerer_name) {
      final_answerer_name = extractNameFromContactPage(contactInfo) || 'Look for lead name in the discovered lead FB profile page';
    }

    if (!isValidProfileLink(realProfile)) return;

    logger.info(`Saving FB reactor lead: ${final_answerer_name}`);

    // Fix #2: parameterised INSERT
    await db.query(
      'INSERT INTO Discovered_Client_Leads (Full_Name, Profile_Page, Page_Discovered_In, Contact_Info) VALUES (?, ?, ?, ?)',
      [final_answerer_name, realProfile, URL, sanitiseText(contactInfo)]
    );
  } catch (err) {
    logger.debug(`Reactor profile error (${profileLink}): ${err.message}`);
  }
}

// ─── Shared FB helpers ────────────────────────────────────────────────────────

function isValidProfileLink(url) {
  if (!url || url.length < 26) return false;
  if (url.includes('/posts/'))       return false;
  if (url.includes('/watch/'))       return false;
  if (url.includes('/photo/'))       return false;
  if (url.includes('/stories/'))     return false;
  if (url.includes('/marketplace/')) return false;
  if (url.includes('/groups/') && !url.includes('/user/')) return false;
  return true;
}

function extractFbProfileUrl(a) {
  const checks = [
    { marker: '?comment_id=', type: 3, prefix: 'https://www.facebook.com/', endMarker: '?comment_id=' },
    { marker: 'https://www.facebook.com/profile/', type: 2, prefix: 'https://www.facebook.com/profile/', endMarkers: ['?', '"'] },
    { marker: 'https://www.facebook.com/profile.php?id=', type: 1, prefix: 'https://www.facebook.com/profile.php?id=', endMarkers: ['&', '"'] },
    { marker: 'href="/groups/', type: 4, prefix: '/groups/' },
  ];

  for (const c of checks) {
    if (!a.includes(c.marker)) continue;

    if (c.type === 3) {
      const start = a.indexOf('https://www.facebook.com/', a.indexOf(c.marker) - 60);
      if (start === -1) continue;
      const sub = a.substring(start + c.prefix.length);
      const end = sub.indexOf(c.endMarker);
      if (end === -1) continue;
      const profile = 'https://www.facebook.com/' + sub.substring(0, end);
      if (!isValidProfileLink(profile)) continue;
      return { profile, biType: 3 };
    }

    if (c.type === 2 || c.type === 1) {
      const idx = a.indexOf(c.prefix);
      if (idx === -1) continue;
      const sub = a.substring(idx + c.prefix.length);
      let end = -1;
      for (const em of c.endMarkers) { end = sub.indexOf(em); if (end !== -1) break; }
      if (end === -1) continue;
      const profile = c.prefix + sub.substring(0, end);
      if (!isValidProfileLink(profile)) continue;
      return { profile, biType: c.type };
    }

    if (c.type === 4) {
      const idx = a.indexOf('href="/groups/');
      if (idx === -1) continue;
      const sub = a.substring(idx + 'href="'.length);
      const end = sub.indexOf('"');
      if (end === -1) continue;
      const profile = 'https://www.facebook.com' + sub.substring(0, end);
      if (!isValidProfileLink(profile)) continue;
      return { profile, biType: 4 };
    }
  }
  return null;
}

function extractAboutContactLink(html, profileUrl) {
  const hi1 = html.indexOf('dir="auto">About');
  if (hi1 === -1) return null;
  const html2 = html.substring(0, hi1);
  const hindex = html2.lastIndexOf(' href="') + ' href="'.length;
  const html3 = html2.substring(hindex);
  let aboutLink = decodeURI(html3.substring(0, html3.indexOf('"')));
  if (aboutLink.length > 0 && !aboutLink.startsWith('https://www.facebook.com/')) {
    aboutLink = aboutLink.startsWith('/')
      ? 'https://www.facebook.com' + aboutLink
      : 'https://www.facebook.com/' + aboutLink;
  }
  return aboutLink.replace('about', 'about_contact_and_basic_info') || null;
}

async function scrapeContactInfo(page, aboutContactLink) {
  if (!aboutContactLink || aboutContactLink.length < 10) return null;
  try {
    const cleanLink = aboutContactLink.replace(/&amp;/g, '&').trim();
    await randomDelay();
    await navigateTo(page, cleanLink);
    await setViewport(page);

    const { profileText } = await page.evaluate(() => ({
      profileText: document.documentElement.innerText,
    }));

    if (!profileText) return null;
    const lc = profileText.toLowerCase();

    // Exclude professionals / competitors
    if (isExcluded(lc)) return null;
    if (lc.startsWith('notifications')) return null;

    // Must have some contact info
    if (profileText.includes('No contact info to show') && profileText.includes('No links to show')) return null;

    // Trim to the Contact info section
    let result = profileText.trim();
    const ni1 = result.indexOf('Contact info');
    const ni2 = result.indexOf('Basic info');
    if (ni1 > -1 && ni2 > -1) {
      result = result.substring(ni1 + 'Contact info'.length, ni2).trim();
    } else if (ni1 > -1) {
      result = result.substring(ni1 + 'Contact info'.length).trim();
    }

    result = result.replace(/No contact info to show/g, '').replace(/No links to show/g, '').trim();
    return result;
  } catch (err) {
    logger.debug(`scrapeContactInfo error: ${err.message}`);
    return null;
  }
}

function extractNameFromContactPage(profileText) {
  if (!profileText) return '';
  const lines = profileText.split('\n').filter(l => l.trim().length > 0);
  return sanitiseName(lines[1] || lines[0] || '') || '';
}

// ─── Entry point ─────────────────────────────────────────────────────────────

main().catch(err => {
  logger.error(`Fatal: ${err.message}`, err);
  process.exit(1);
});
