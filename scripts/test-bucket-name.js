/**
 * Test script for getBucketName function.
 *
 * Run: node scripts/test-bucket-name.js
 *
 * This tests the bucket partitioning logic before it's implemented
 * in the production code. Every boundary case is covered.
 */

function getBucketName(id) {
  if (id >= 1000000) return 'other';
  const bucket = Math.floor(id / 1000);
  return String(bucket).padStart(3, '0');
}

// ── Test cases ───────────────────────────────────────────────────────────────
const tests = [
  // ── User's explicit examples ──
  { id: 1,       expected: '000' },  // "1-999 is will be in = 000"
  { id: 2,       expected: '000' },  // "like id 2 anime doesn't exist yet"
  { id: 999,     expected: '000' },  // upper boundary of 000
  { id: 1000,    expected: '001' },  // "1000-1999 will be in 001"
  { id: 1999,    expected: '001' },  // upper boundary of 001
  { id: 2000,    expected: '002' },  // "2000-2999 will be in 002"
  { id: 2999,    expected: '002' },
  { id: 3000,    expected: '003' },  // "3000-3999 will be in 003"
  { id: 5000,    expected: '005' },  // "5000-5999 will be in 005"
  { id: 10000,   expected: '010' },  // "10000-10999 will be in 010"
  { id: 10999,   expected: '010' },
  { id: 11000,   expected: '011' },  // "11000-11999 will be in 011"
  { id: 20000,   expected: '020' },  // "20000-20999 will be in 020"
  { id: 50000,   expected: '050' },  // "50000-50999 will be in 050"
  { id: 99000,   expected: '099' },  // "99000-99999 will be in 099"
  { id: 99999,   expected: '099' },  // upper boundary of 099
  { id: 100000,  expected: '100' },  // "100000-100999 will be in 100"
  { id: 200000,  expected: '200' },  // "200000-200999 will be in 200"
  { id: 999999,  expected: '999' },  // "999999 it'll be on 999"
  { id: 1000000, expected: 'other' }, // "if we get 1000000, it'll be on other"

  // ── Additional boundary / edge cases ──
  { id: 0,       expected: '000' },  // zero edge case
  { id: 3999,    expected: '003' },
  { id: 4000,    expected: '004' },
  { id: 5999,    expected: '005' },
  { id: 6000,    expected: '006' },
  { id: 9000,    expected: '009' },
  { id: 9999,    expected: '009' },
  { id: 10099,   expected: '010' },
  { id: 11999,   expected: '011' },
  { id: 12000,   expected: '012' },
  { id: 20999,   expected: '020' },
  { id: 50999,   expected: '050' },
  { id: 51000,   expected: '051' },
  { id: 98999,   expected: '098' },
  { id: 100999,  expected: '100' },
  { id: 101000,  expected: '101' },
  { id: 500000,  expected: '500' },
  { id: 998999,  expected: '998' },
  { id: 999000,  expected: '999' },
  { id: 999998,  expected: '999' },

  // ── "other" bucket beyond 6 digits ──
  { id: 1000001, expected: 'other' },
  { id: 2000000, expected: 'other' },
  { id: 9999999, expected: 'other' },
  { id: 10000000, expected: 'other' },

  // ── Well-known MAL anime IDs (real-world examples) ──
  { id: 21,      expected: '000' },   // Gintama
  { id: 16498,   expected: '016' },  // Madoka Magica
  { id: 813,     expected: '000' },  // Naruto
  { id: 1,       expected: '000' },   // First MAL entry
  { id: 5114,    expected: '005' },  // Fullmetal Alchemist: Brotherhood
  { id: 28977,   expected: '028' },  // something in 028
  { id: 9969,    expected: '009' },  // near 5-digit boundary
  { id: 10000,   expected: '010' },  // 5-digit boundary
  { id: 50000,   expected: '050' },  // mid 5-digit range
];

// ── Run tests ─────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

for (const { id, expected } of tests) {
  const actual = getBucketName(id);
  const ok = actual === expected;
  if (ok) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL  id=${id}  expected="${expected}"  got="${actual}"`);
  }
}

// ── Visual mapping table ──────────────────────────────────────────────────────
console.log('\n┌─────────────────────────────────────────────────────┐');
console.log('│            Bucket Mapping Visual Table              │');
console.log('├─────────────────────────────────────────────────────┤');
const visualIds = [
  0, 1, 2, 999, 1000, 1001, 1999, 2000, 2999, 3000,
  5000, 9999, 10000, 10999, 11000, 20000, 20999,
  50000, 50999, 99000, 99999, 100000, 100999, 200000,
  500000, 999000, 999999, 1000000, 1000001, 2000000,
];
for (const id of visualIds) {
  const bucket = getBucketName(id);
  const marker = id >= 1000000 ? ' <-- OTHER' : '';
  console.log(`│  id ${String(id).padStart(7)}  →  bucket "${bucket}"${marker}`);
}
console.log('└─────────────────────────────────────────────────────┘');

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n✅ ${passed} passed, ❌ ${failed} failed (out of ${tests.length} tests)`);
if (failed > 0) {
  process.exit(1);
}
