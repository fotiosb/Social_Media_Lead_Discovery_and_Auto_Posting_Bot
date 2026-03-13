'use strict';
/**
 * utils/puppeteer.js
 * Shared Puppeteer helpers.
 * Fixes: #4 (no waitForTimeout), #11 (retry on navigate)
 */
const fs     = require('fs').promises;
const logger = require('../config/logger');

const DELAY_MIN   = parseInt(process.env.DELAY_MIN_SEC       || '10',     10) * 1000;
const DELAY_MAX   = parseInt(process.env.DELAY_MAX_SEC       || '20',     10) * 1000;
const MAX_SCROLL  = parseInt(process.env.MAX_SCROLL_PX       || '150000', 10);
const NAV_RETRIES = parseInt(process.env.NAV_RETRY_ATTEMPTS  || '3',      10);

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function randomDelay() {
  const ms = Math.floor(Math.random() * (DELAY_MAX - DELAY_MIN + 1)) + DELAY_MIN;
  return sleep(ms);
}

async function navigateTo(page, url, opts = { waitUntil: 'networkidle2' }, retries = NAV_RETRIES) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try { await page.goto(url, opts); return; }
    catch (err) {
      lastErr = err;
      logger.warn(`Nav attempt ${attempt}/${retries} failed for ${url}: ${err.message}`);
      if (attempt < retries) await sleep(attempt * 3000);
    }
  }
  throw lastErr;
}

async function autoScroll(page) {
  await page.evaluate(async (maxScroll) => {
    await new Promise(resolve => {
      let totalHeight = 0;
      const timer = setInterval(() => {
        window.scrollBy(0, 100);
        totalHeight += 100;
        if (totalHeight >= document.body.scrollHeight || totalHeight > maxScroll) {
          clearInterval(timer); resolve();
        }
      }, 100);
    });
  }, MAX_SCROLL);
}

async function loadAllCookies(page) {
  const files = [
    { path: './google_cookies.json',   name: 'Google'   },
    { path: './quora_cookies.json',    name: 'Quora'    },
    { path: './facebook_cookies.json', name: 'Facebook' },
  ];
  for (const { path, name } of files) {
    try {
      const cookies = JSON.parse(await fs.readFile(path, 'utf8'));
      await page.setCookie(...cookies);
      logger.debug(`${name} cookies loaded`);
    } catch (err) {
      logger.warn(`Could not load ${name} cookies: ${err.message}`);
    }
  }
}

async function setViewport(page) {
  await page.setViewport({ width: 1200, height: 800 });
}

module.exports = { sleep, randomDelay, navigateTo, autoScroll, loadAllCookies, setViewport };
