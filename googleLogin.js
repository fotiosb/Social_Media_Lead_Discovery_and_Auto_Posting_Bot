'use strict';
/**
 * googleLogin.js
 * Headed browser utility — opens a URL with Google session cookies,
 * saving / refreshing them in the process.
 *
 * Usage:  node googleLogin.js
 * (edit the `open()` call at the bottom if you need a different URL)
 *
 * Fixes applied vs original:
 *  #1  Hardcoded email/password replaced with process.env values (from .env)
 *  #4  page.waitForTimeout() replaced with sleep()
 */

require('dotenv').config();

const puppeteer = require('puppeteer');
const fs        = require('fs').promises;
const { sleep } = require('./utils/puppeteer');

const GOOGLE_EMAIL = process.env.GOOGLE_EMAIL || '';
const GOOGLE_PASS  = process.env.GOOGLE_PASS  || '';

async function open(URL) {
  const browser = await puppeteer.launch({ headless: false, args: ['--no-sandbox'] });
  const page    = await browser.newPage();

  try {
    const context = browser.defaultBrowserContext();
    context.overridePermissions('https://www.facebook.com', ['geolocation', 'notifications']);

    let cookies;
    try {
      cookies = JSON.parse(await fs.readFile('./google_cookies.json', 'utf8'));
      await page.setCookie(...cookies);
      await page.goto(URL, { timeout: 90000 });
      cookies = await page.cookies();
      await fs.writeFile('google_cookies.json', JSON.stringify(cookies));
      console.log('Navigated with existing Google cookies — cookies refreshed.');
    } catch {
      console.log('No Google cookies — performing fresh login.');

      await page.goto('https://accounts.google.com', { timeout: 90000 });
      await page.waitForSelector('[type="email"]');
      await page.type('[type="email"]', GOOGLE_EMAIL);
      await page.click('#identifierNext');
      await page.waitForSelector('[type="password"]', { visible: true });
      await page.type('[type="password"]', GOOGLE_PASS);
      await page.click('#passwordNext');
      await sleep(10000);

      cookies = await page.cookies();
      await fs.writeFile('google_cookies.json', JSON.stringify(cookies));
      console.log('Google login successful — cookies saved.');
    }
  } catch (err) {
    console.error('Error:', err.message);
  }
}

open('https://www.google.com');
