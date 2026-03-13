'use strict';
/**
 * config/db.js
 * Shared MySQL2 connection pool.
 */
const mysql = require('mysql2/promise');
let _pool = null;

function pool() {
  if (!_pool) {
    _pool = mysql.createPool({
      host              : process.env.DB_HOST     || 'localhost',
      user              : process.env.DB_USER     || 'eta',
      password          : process.env.DB_PASS     || '',
      database          : process.env.DB_NAME     || 'ETA_Marketing',
      waitForConnections: true,
      connectionLimit   : 10,
      queueLimit        : 0,
    });
  }
  return _pool;
}

async function query(sql, params = []) {
  const [rows, fields] = await pool().execute(sql, params);
  return [rows, fields];
}

async function end() {
  if (_pool) { await _pool.end(); _pool = null; }
}

module.exports = { pool, query, end };
