'use strict';
/**
 * utils/filters.js
 * Centralised exclusion keywords and name-sanitisation helpers.
 */
const EXCLUDED_SUBSTRINGS = [
  'm.d.','m.d',' md','md ','md-','-md','doctor','doc ','doc.','doc-',
  'dc-','dc ','surgical','surgery','plastic','clinic','clinik','medical',
  'medicine','aesthetic','esthetic','cosmetic','wellness','skin','care',
  'derm','nurse','nutra','laser','botox','filler','massage','anti-aging',
  'antiaging','rejuvenat','transplant','hair','therap','salon','spa',
  'treatment','train','academ','renew','center','centre','fitness','shop',
  'machine','marketplace','ozempic','dr ','dr.','dr-',
];

function isExcluded(text) {
  const lc = text.toLowerCase();
  return EXCLUDED_SUBSTRINGS.some(kw => lc.includes(kw));
}

function sanitiseName(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let name = raw.replace(/[\\.,\-0-9]/g, ' ').replace(/['"` \\]/g, '').replace(/-/gi, ' ').trim();
  return name.length > 1 ? name : null;
}

function sanitiseText(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw.replace(/['"` \\]/g, '').trim();
}

module.exports = { EXCLUDED_SUBSTRINGS, isExcluded, sanitiseName, sanitiseText };
