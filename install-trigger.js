/**
 * Install DB trigger from setup.sql
 *
 * รัน script นี้ครั้งเดียวเพื่อสร้าง trigger บน production database
 *
 *   cd discord-bot
 *   cp .env.example .env  (ถ้ายังไม่ได้ทำ)
 *   # แก้ .env ใส่ DATABASE_URL
 *   npm install
 *   npm run install-trigger
 */

import pg from 'pg'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
    console.error('❌ Missing DATABASE_URL in .env')
    process.exit(1)
}

const sql = readFileSync(join(__dirname, 'setup.sql'), 'utf-8')

const client = new pg.Client({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('railway') || DATABASE_URL.includes('render') || DATABASE_URL.includes('amazonaws')
        ? { rejectUnauthorized: false }
        : false,
})

try {
    await client.connect()
    console.log('🔌 Connected to database')

    await client.query(sql)
    console.log('✅ Trigger installed')

    const expected = [
        'it_tickets_notify_insert',
        'it_tickets_notify_update',
        'equipment_borrowings_notify_insert',
        'equipment_borrowings_notify_update',
        'gps_checkins_notify_insert',
    ]
    const result = await client.query(
        `SELECT tgname FROM pg_trigger WHERE tgname = ANY($1::text[])`,
        [expected]
    )
    const found = result.rows.map((r) => r.tgname)
    const missing = expected.filter((t) => !found.includes(t))

    if (missing.length === 0) {
        console.log(`✅ Verified — all ${expected.length} triggers installed:`)
        expected.forEach((t) => console.log(`     • ${t}`))
    } else {
        console.error('⚠️ Missing triggers:', missing.join(', '))
        process.exit(1)
    }

    const cols = await client.query(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE column_name = 'discord_message_id'
           AND table_name IN ('it_tickets', 'equipment_borrowings')`
    )
    const expectedTables = ['it_tickets', 'equipment_borrowings']
    const foundTables = cols.rows.map((r) => r.table_name)
    const missingTables = expectedTables.filter((t) => !foundTables.includes(t))
    if (missingTables.length === 0) {
        console.log('✅ Verified — discord_message_id column exists in:')
        expectedTables.forEach((t) => console.log(`     • ${t}`))
    } else {
        console.error('⚠️ Missing discord_message_id column in:', missingTables.join(', '))
        process.exit(1)
    }
} catch (error) {
    console.error('💥 Failed to install trigger:', error.message)
    process.exit(1)
} finally {
    await client.end()
}
