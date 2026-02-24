require('dotenv').config({ path: '/root/.openclaw/.env' });
const { ImapFlow } = require('imapflow');

const client = new ImapFlow({
  host: 'imap.gmail.com',
  port: 993,
  secure: true,
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD
  },
  logger: false,
  tls: { rejectUnauthorized: false }
});

console.log('GMAIL_USER:', process.env.GMAIL_USER);
console.log('APP_PASS set:', !!process.env.GMAIL_APP_PASSWORD);

const kill = setTimeout(() => {
  console.error('TIMEOUT - credentials wrong or port 993 blocked');
  process.exit(1);
}, 15000);

client.connect()
  .then(() => {
    clearTimeout(kill);
    console.log('Connected! Logging out...');
    return client.logout();
  })
  .then(() => {
    console.log('Gmail IMAP connected OK!');
  })
  .catch(e => {
    clearTimeout(kill);
    console.error('Connection failed:', e.message);
  });
