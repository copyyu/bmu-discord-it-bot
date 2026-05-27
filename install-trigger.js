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

    const result = await client.query(
        `SELECT tgname FROM pg_trigger
         WHERE tgname IN ('it_tickets_notify_insert', 'it_tickets_notify_update')`
    )
    const found = result.rows.map((r) => r.tgname)
    const expected = ['it_tickets_notify_insert', 'it_tickets_notify_update']
    const missing = expected.filter((t) => !found.includes(t))

    if (missing.length === 0) {
        console.log('✅ Verified — triggers installed:')
        expected.forEach((t) => console.log(`     • ${t}`))
    } else {
        console.error('⚠️ Missing triggers:', missing.join(', '))
        process.exit(1)
    }

    const col = await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'it_tickets' AND column_name = 'discord_message_id'`
    )
    if (col.rows.length > 0) {
        console.log('✅ Verified — column "discord_message_id" exists')
    } else {
        console.error('⚠️ Column discord_message_id not found')
        process.exit(1)
    }
} catch (error) {
    console.error('💥 Failed to install trigger:', error.message)
    process.exit(1)
} finally {
    await client.end()
}
