require('/root/.openclaw/skills/agentbox-willoughby/node_modules/dotenv').config({ path: '/root/.openclaw/.env' });
const fs = require('fs');
const Database = require('/root/.openclaw/node_modules/better-sqlite3');

const db = new Database('/root/.openclaw/workspace/jarvis.db');
const raw = fs.readFileSync('/root/.openclaw/workspace/willoughby-contacts.json', 'utf8');
const data = JSON.parse(raw);
const contacts = data.contacts;
const total = Object.keys(contacts).length;

console.log(`Importing ${total} contacts...`);

const insert = db.prepare(`
  INSERT OR REPLACE INTO agentbox_contacts
  (id, name, mobile, email, address, suburb, state, postcode, contact_class, do_not_call, last_modified)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const importAll = db.transaction(() => {
  let count = 0;
  for (let i = 0; i < total; i++) {
    const c = contacts[String(i)];
    if (!c || !c.id) continue;
    insert.run(
      String(c.id),
      c.name || null,
      c.mobile || null,
      c.email || null,
      c.address || null,
      c.suburb || null,
      c.state || null,
      c.postcode || null,
      c.contactClass || null,
      c.doNotCall || null,
      c.lastModified || null
    );
    count++;
    if (count % 10000 === 0) console.log(`  ${count}/${total}...`);
  }
  return count;
});

const count = importAll();
console.log(`Done — ${count} contacts imported.`);

const stats = db.prepare(`
  SELECT
    COUNT(*) as total,
    COUNT(mobile) as with_mobile,
    COUNT(CASE WHEN do_not_call IS NULL OR do_not_call = '' OR do_not_call != 'YES' THEN 1 END) as callable
  FROM agentbox_contacts
`).get();
console.log('Stats:', JSON.stringify(stats));

const topSuburbs = db.prepare(`
  SELECT suburb, COUNT(*) as n FROM agentbox_contacts
  WHERE suburb IS NOT NULL AND suburb != ''
  GROUP BY suburb ORDER BY n DESC LIMIT 10
`).all();
console.log('Top suburbs:', topSuburbs.map(r => r.suburb + ':' + r.n).join(', '));

db.close();
