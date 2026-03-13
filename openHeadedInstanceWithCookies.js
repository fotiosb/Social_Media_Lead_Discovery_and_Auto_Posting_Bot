'use strict';
/**
 * openHeadedInstanceWithCookies.js  (FIXED)
 * Opens a headed browser at a given URL with all site cookies pre-loaded.
 * Useful for manual inspection of authenticated sessions.
 *
 * Fixes applied:
 *  #1  Credentials removed from source — load from .env via dotenv
 *  #4  page.waitForTimeout() → sleep()
 */

require('dotenv').config();

const puppeteer = require('puppeteer');
const fs        = require('fs').promises;
const { sleep } = require('./utils/puppeteer');

async function open(URL) {
  const browser = await puppeteer.launch({ headless: false, args: ['--no-sandbox'] });
  const page    = await browser.newPage();
  page.setDefaultNavigationTimeout(0);

  // Load all available cookies
  try {
    const gc = JSON.parse(await fs.readFile('./google_cookies.json'));
    await page.setCookie(...gc);
  } catch (e) { console.warn(`Could not load Google cookies: ${e.message}`); }

  try {
    const qc = JSON.parse(await fs.readFile('./quora_cookies.json'));
    await page.setCookie(...qc);
  } catch (e) { console.warn(`Could not load Quora cookies: ${e.message}`); }

  try {
    const fc = JSON.parse(await fs.readFile('./facebook_cookies.json'));
    const ctx = browser.defaultBrowserContext();
    ctx.overridePermissions('https://www.facebook.com', ['geolocation', 'notifications']);
    await page.setCookie(...fc);
  } catch (e) { console.warn(`Could not load Facebook cookies: ${e.message}`); }

  try {
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 90000 });
    console.log(`Opened with cookies: ${URL}`);
    // Browser left open for manual inspection.
  } catch (e) {
    console.error(`Error: ${e}`);
  }
}

// Change URL as needed before running
open('https://www.google.com');
