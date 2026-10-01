'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

let _db;
function db() {
  if (!_db) {
    const file = process.env.MINUTES_DB || path.join(__dirname, '../../../data/minutes.db');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    _db = new Database(file);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    _db.pragma('busy_timeout = 5000');
    _db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  }
  return _db;
}

// 测试用内存库
function useMemory(seed = true) {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  if (seed) d.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  _db = d;
  return d;
}

function tx(fn) {
  return db().transaction(fn)();
}

module.exports = { db, useMemory, tx };
