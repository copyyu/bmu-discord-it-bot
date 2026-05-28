/**
 * Test helper — ส่ง fake NOTIFY event เข้า database เพื่อทดสอบ bot end-to-end
 * โดยไม่ต้องแตะข้อมูลจริง / ไม่ต้องใช้ GPS / ไม่ต้องรอ cooldown
 *
 * วิธีทำงาน: ยิง pg_notify เข้า DB ที่ bot กำลัง LISTEN อยู่ →
 *            bot (จะรันที่ local หรือ Render ก็ได้) รับ event → โพสต์เข้า Discord
 *
 * ⚠️ ต้องให้ bot รันอยู่ + ตั้ง env (webhook + CHECKIN_USERNAMES) ก่อน
 *
 * Usage:
 *   node --env-file=.env test-notify.js checkin   # ทดสอบเช็คอิน
 *   node --env-file=.env test-notify.js checkout  # ทดสอบเช็คเอาท์
 *   node --env-file=.env test-notify.js ticket    # ทดสอบ IT ticket
 *   node --env-file=.env test-notify.js borrow    # ทดสอบยืมอุปกรณ์
 */

import pg from 'pg'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
    console.error('❌ Missing DATABASE_URL in .env')
    process.exit(1)
}

const which = process.argv[2] || 'checkin'

const FIXTURES = {
    checkin: {
        channel: 'gps_checkin_event',
        payload: {
            id: 999999,
            user_id: 'test-user',
            username: 'Chayapol.jit', // ต้องอยู่ใน CHECKIN_USERNAMES ไม่งั้น bot กรองทิ้ง
            name: 'ชยพล(ต้นปาล์ม) [TEST]',
            type: 'check_in',
            distance_meters: 12,
            event_time: '08:45',
        },
    },
    checkout: {
        channel: 'gps_checkin_event',
        payload: {
            id: 999999,
            user_id: 'test-user',
            username: 'Chayapol.jit',
            name: 'ชยพล(ต้นปาล์ม) [TEST]',
            type: 'check_out',
            distance_meters: 8,
            event_time: '18:30',
        },
    },
    ticket: {
        channel: 'new_it_ticket',
        payload: {
            id: 999999,
            ticket_no: 'IT-TEST-001',
            category: 'system_issue',
            description: 'นี่คือ ticket ทดสอบ [TEST] — ลบทิ้งได้',
            status: 'open',
            reporter_id: 'test',
            reporter_name: 'ทดสอบ ระบบ',
            created_at: new Date().toISOString(),
        },
    },
    borrow: {
        channel: 'new_equipment_borrowing',
        payload: {
            id: 999999,
            equipment_id: 1,
            equipment_name: 'จอมอนิเตอร์ทดสอบ [TEST]',
            equipment_asset_tag: 'BMU-TEST-001',
            equipment_category: 'monitor',
            borrower_id: 'test',
            borrower_name: 'ทดสอบ ระบบ',
            borrower_nick: 'เทส',
            borrow_date: '2026-05-28',
            expected_return_date: '2026-05-29',
            purpose: 'ทดสอบระบบแจ้งเตือน',
            status: 'pending',
        },
    },
}

const fixture = FIXTURES[which]
if (!fixture) {
    console.error(`❌ ไม่รู้จัก "${which}" — ใช้ได้: checkin | checkout | ticket | borrow`)
    process.exit(1)
}

const client = new pg.Client({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('railway') || DATABASE_URL.includes('render') || DATABASE_URL.includes('amazonaws')
        ? { rejectUnauthorized: false }
        : false,
})

try {
    await client.connect()
    await client.query(`SELECT pg_notify($1, $2)`, [fixture.channel, JSON.stringify(fixture.payload)])
    console.log(`✅ ส่ง test NOTIFY บน channel "${fixture.channel}" แล้ว`)
    console.log('   → เช็ค Discord channel ที่เกี่ยวข้องว่าเด้งมั้ย (ภายใน 1-2 วินาที)')
    console.log('   → ดู bot log: ควรเห็น "📬 ..." ตามด้วย "✅ Sent ..."')
    if (which === 'ticket' || which === 'borrow') {
        console.log('   หมายเหตุ: message นี้จะไม่ถูกลบอัตโนมัติ (id 999999 ไม่มีจริงใน DB) — ลบเองได้')
    }
} catch (error) {
    console.error('💥 ส่ง notify ไม่สำเร็จ:', error.message)
    process.exit(1)
} finally {
    await client.end()
}
