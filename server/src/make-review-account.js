// Makes the App Review login: an account that lives in the demo world (demo.js). Safe to run again: it only updates the
// password. Run as the service's user:  REVIEW_EMAIL=… REVIEW_PASSWORD=… DATA_DIR=… node src/make-review-account.js
import { get, now, run } from './db.js';
import { hashPassword } from './auth.js';

const email = process.env.REVIEW_EMAIL, password = process.env.REVIEW_PASSWORD;
if (!email || !password) throw new Error('REVIEW_EMAIL and REVIEW_PASSWORD are needed');
const id = 'dz-review';
const t = now();
if (get('SELECT 1 AS x FROM users WHERE id = ?', id)) {
  run('UPDATE users SET email = ?, password_hash = ?, is_demo = 1, deleted_at = NULL WHERE id = ?', email, hashPassword(password), id);
  console.log('Updated the review account.');
} else {
  run('INSERT INTO users (id, name, email, password_hash, is_demo, last_seen_at, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)', id, 'App Review', email, hashPassword(password), t, t);
  console.log('Made the review account.');
}
process.exit(0);
