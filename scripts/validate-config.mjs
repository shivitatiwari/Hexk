import fs from 'node:fs';

const raw = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
if (!raw.includes('"binding": "DB"')) throw new Error('wrangler.jsonc is missing the DB binding');
if (!raw.includes('00000000-0000-0000-0000-000000000000')) {
  console.log('Config check: D1 database ID appears configured.');
} else {
  console.log('Config check: D1 database ID still needs to be filled before remote deployment.');
}
if (!fs.existsSync(new URL('../migrations/0001_init.sql', import.meta.url))) throw new Error('D1 migration missing');
console.log('Static config checks passed.');
