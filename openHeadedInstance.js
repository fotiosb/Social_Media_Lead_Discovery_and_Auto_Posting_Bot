'use strict';
/**
 * openHeadedInstance.js  (FIXED)
 * Opens a headed (visible) browser at a given URL for manual inspection.
 *
 * Fixes applied:
 *  #1  Credentials removed from source — load from .env via dotenv
 *  #4  page.waitForTimeout() → sleep()
 */

require('dotenv').config();

const puppeteer = require('puppeteer');
const { sleep } = require('./utils/puppeteer');

async function open(URL) {
  const browser = await puppeteer.launch({ headless: false, args: ['--no-sandbox'] });
  const page    = await browser.newPage();
  page.setDefaultNavigationTimeout(0);

  try {
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 90000 });
    console.log(`Opened: ${URL}`);
    // Browser left open for manual inspection — close it manually when done.
  } catch (e) {
    console.error(`Error opening ${URL}: ${e}`);
  }
}

// Change URL as needed before running
open('https://www.google.com');
