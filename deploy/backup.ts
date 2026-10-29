// A consistent copy of the database, taken while the app runs (VACUUM INTO
// reads a snapshot and never blocks the writers for long). The newest copies
// are kept. Run it in the container: deploy/backup.sh.
import { Database } from '@db/sqlite'
import { dirname, join } from 'jsr:@std/path'

const KEEP = 30
const source = Deno.env.get('DATABASE_PATH') ?? '/data/defendable.db'
const folder = join(dirname(source), 'backups')
Deno.mkdirSync(folder, { recursive: true })

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const target = join(folder, `defendable-${stamp}.db`)

const db = new Database(source)
try {
  db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`)
} finally {
  db.close()
}
console.log(`backup: ${target}`)

// the oldest copies go: the names sort by date
const copies = [...Deno.readDirSync(folder)].map((f) => f.name)
  .filter((name) => /^defendable-.*\.db$/.test(name)).sort()
for (const name of copies.slice(0, Math.max(0, copies.length - KEEP))) {
  Deno.removeSync(join(folder, name))
  console.log(`removed: ${name}`)
}
