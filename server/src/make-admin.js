// Sets who can log in to the admin panel, also when the password is forgotten. The password is only to get in: the
// panel asks for a new one straight away. Run as the service's user:  ADMIN_EMAIL=… ADMIN_PASSWORD=… DATA_DIR=… node src/make-admin.js
import { setMeta } from './db.js';
import { hashPassword } from './auth.js';

const email = process.env.ADMIN_EMAIL?.trim().toLowerCase(), password = process.env.ADMIN_PASSWORD;
if (!email || !password) throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD are needed');
setMeta('admin:email', email);
setMeta('admin:password', hashPassword(password));
setMeta('admin:must_change', '1');
console.log(`Admin login set for ${email}.`);
process.exit(0);
