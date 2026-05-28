/**
 * BMU Discord IT Bot
 *
 * Listens to PostgreSQL NOTIFY channels and forwards events to Discord:
 *   IT tickets:
 *     - new_it_ticket               → POST embed via DISCORD_WEBHOOK_IT_TICKET
 *     - it_ticket_resolved          → DELETE message (resolved/closed)
 *   Equipment borrowings (optional — only if DISCORD_WEBHOOK_EQUIPMENT set):
 *     - new_equipment_borrowing     → POST embed via DISCORD_WEBHOOK_EQUIPMENT
 *     - equipment_borrowing_resolved → DELETE message (approved/rejected)
 *   Check-in/out (optional — only if DISCORD_WEBHOOK_CHECKIN set):
 *     - gps_checkin_event           → POST embed via DISCORD_WEBHOOK_CHECKIN
 *                                     filtered by CHECKIN_USERNAMES allowlist
 *
 * No coupling with the web app — the only contract is the DB triggers in setup.sql
 *
 * Required env:
 *   DATABASE_URL              postgres:// connection string
 *   DISCORD_WEBHOOK_IT_TICKET https://discord.com/api/webhooks/...
 *
 * Optional env:
 *   DISCORD_WEBHOOK_EQUIPMENT enable equipment borrowing notifications
 *   DISCORD_WEBHOOK_CHECKIN   enable check-in/out notifications
 *   CHECKIN_USERNAMES         comma-separated usernames to notify on check-in (else none)
 *   CHECKIN_MENTION           mention for check-in (default '' = no ping, avoid spam)
 *   PORT                      if set, starts HTTP server with /health endpoint
 *   BOT_NAME                  override displayed username (default "BMU IT Bot")
 *   MENTION                   '@everyone' (default), '@here', '<@&ROLE_ID>', or '' to disable
 *   RECONNECT_DELAY_MS        ms before reconnect on DB drop (default 5000)
 */

import pg from 'pg'
import { createServer } from 'http'

const { Client } = pg

const BOT_NAME = process.env.BOT_NAME || 'BMU IT Bot'
const RECONNECT_DELAY_MS = Number(process.env.RECONNECT_DELAY_MS) || 5000
const MENTION = process.env.MENTION ?? '@everyone'

function requireEnv(key) {
    const value = process.env[key]
    if (!value) {
        console.error(`❌ Missing required env: ${key}`)
        process.exit(1)
    }
    return value
}

const DATABASE_URL = requireEnv('DATABASE_URL')
const TICKET_WEBHOOK = requireEnv('DISCORD_WEBHOOK_IT_TICKET').split('?')[0]
const EQUIPMENT_WEBHOOK = process.env.DISCORD_WEBHOOK_EQUIPMENT?.split('?')[0] || null
const CHECKIN_WEBHOOK = process.env.DISCORD_WEBHOOK_CHECKIN?.split('?')[0] || null
// รายชื่อ username ที่จะแจ้งเตือน check-in (comma-separated) — ว่าง = ไม่แจ้งใครเลย
const CHECKIN_USERNAMES = (process.env.CHECKIN_USERNAMES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
// check-in ไม่ ping ใครโดย default (เป็น log เฉยๆ — ป้องกัน spam @everyone วันละหลายสิบครั้ง)
const CHECKIN_MENTION = process.env.CHECKIN_MENTION ?? ''

// ============================================================
// IT TICKET metadata
// ============================================================
const TICKET_CATEGORY_META = {
    system_issue: { emoji: '⚙️', label: 'ปัญหาระบบ', color: 0xff4d4f },
    equipment_issue: { emoji: '🖥️', label: 'ปัญหาอุปกรณ์', color: 0xfa8c16 },
    feature_request: { emoji: '✨', label: 'ขอฟีเจอร์ใหม่', color: 0x1890ff },
    nas_issue: { emoji: '💾', label: 'ปัญหา NAS', color: 0x722ed1 },
}
const TICKET_DEFAULT_META = { emoji: '❓', label: 'อื่นๆ', color: 0xff6b35 }

const TICKET_STATUS_BADGE = {
    open: '🟢 รอดำเนินการ',
    in_progress: '🟡 กำลังดำเนินการ',
    resolved: '✅ แก้ไขแล้ว',
    closed: '⚫ ปิดแล้ว',
}

// ============================================================
// EQUIPMENT metadata
// ============================================================
const EQ_CATEGORY_EMOJI = {
    monitor: '🖥️',
    laptop: '💻',
    desktop: '🖥️',
    keyboard: '⌨️',
    mouse: '🖱️',
    headphone: '🎧',
    headset: '🎧',
    cable: '🔌',
    adapter: '🔌',
    server: '🗄️',
    network: '🌐',
    router: '🌐',
    printer: '🖨️',
    camera: '📷',
    phone: '📱',
    tablet: '📱',
}

const BORROW_STATUS_BADGE = {
    pending: '🟡 รออนุมัติ',
    approved: '🟢 อนุมัติแล้ว',
    borrowed: '📤 กำลังยืม',
    rejected: '❌ ปฏิเสธ',
    returned: '✅ คืนแล้ว',
}

// ============================================================
// CHECK-IN metadata
// ============================================================
const CHECKIN_TYPE_META = {
    check_in: { emoji: '🟢', label: 'เช็คอินเข้างาน', color: 0x20c997 },
    check_out: { emoji: '🔴', label: 'เช็คเอาท์ออกงาน', color: 0xfa5252 },
}

function eqEmoji(category) {
    if (!category) return '📦'
    return EQ_CATEGORY_EMOJI[category.toLowerCase()] || '📦'
}

function formatDateRange(start, end) {
    const s = String(start || '').slice(0, 10)
    const e = String(end || '').slice(0, 10)
    if (!s) return '-'
    return s === e ? s : `${s}  →  ${e}`
}

// ============================================================
// Embed builders
// ============================================================
function buildTicketEmbed(ticket) {
    const meta = TICKET_CATEGORY_META[ticket.category] || TICKET_DEFAULT_META
    const rawDesc = (ticket.description || '(ไม่มีรายละเอียด)').slice(0, 1800)
    const quotedDesc = rawDesc.split('\n').map((line) => `> ${line}`).join('\n')

    return {
        author: { name: '🎫 มี IT Ticket ใหม่เข้ามา' },
        title: `${meta.emoji}  ${ticket.ticket_no}`,
        description: `${quotedDesc}\n​`,
        color: meta.color,
        fields: [
            { name: '📁 หมวดหมู่', value: `**${meta.label}**`, inline: true },
            { name: '👤 ผู้แจ้ง', value: `**${ticket.reporter_name || '-'}**`, inline: true },
            { name: '🚦 สถานะ', value: TICKET_STATUS_BADGE[ticket.status] || `\`${ticket.status}\``, inline: true },
        ],
        footer: { text: 'BMU Work Management  •  IT Support System' },
    }
}

function buildBorrowingEmbed(b) {
    const emoji = eqEmoji(b.equipment_category)
    const eqLine = b.equipment_name
        ? (b.equipment_asset_tag ? `${b.equipment_asset_tag}  •  ${b.equipment_name}` : b.equipment_name)
        : (b.equipment_asset_tag || '-')
    const borrower = b.borrower_nick
        ? `${b.borrower_name} (${b.borrower_nick})`
        : (b.borrower_name || '-')
    const purposeLine = b.purpose
        ? (b.purpose).slice(0, 1800).split('\n').map((line) => `> ${line}`).join('\n')
        : '> _(ไม่ระบุเหตุผล)_'

    return {
        author: { name: '📦 มีคำขอยืมอุปกรณ์ใหม่' },
        title: `${emoji}  ${eqLine}`,
        description: `**📝 เหตุผลการยืม**\n${purposeLine}\n​`,
        color: 0xff6b35, // BMU primary orange
        fields: [
            { name: '👤 ผู้ขอยืม', value: `**${borrower}**`, inline: true },
            { name: '📅 ช่วงวันที่', value: formatDateRange(b.borrow_date, b.expected_return_date), inline: true },
            { name: '🚦 สถานะ', value: BORROW_STATUS_BADGE[b.status] || `\`${b.status}\``, inline: true },
        ],
        footer: { text: 'BMU Work Management  •  Equipment Borrowing' },
    }
}

function buildCheckinEmbed(ev) {
    const meta = CHECKIN_TYPE_META[ev.type] || { emoji: '📍', label: ev.type, color: 0xff6b35 }
    const dist = ev.distance_meters != null ? `${Math.round(Number(ev.distance_meters))} ม.` : '-'
    return {
        author: { name: `${meta.emoji}  ${meta.label}` },
        title: ev.name || ev.username || '-',
        color: meta.color,
        fields: [
            { name: '🕐 เวลา', value: `**${ev.event_time || '-'}** น.`, inline: true },
            { name: '📍 ระยะห่างจากออฟฟิศ', value: dist, inline: true },
        ],
        footer: { text: 'BMU Work Management  •  Attendance' },
    }
}

// ============================================================
// Discord HTTP helpers — generic over webhook URL
// ============================================================
async function postToWebhook(webhookBase, embed, logLabel, mention = MENTION) {
    const url = `${webhookBase}?wait=true`
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: BOT_NAME,
                content: mention || undefined,
                embeds: [embed],
                allowed_mentions: { parse: ['everyone', 'roles', 'users'] },
            }),
        })

        if (!response.ok) {
            const text = await response.text().catch(() => '')
            console.error(`⚠️ Discord ${response.status} for ${logLabel}: ${text.slice(0, 200)}`)
            return null
        }

        const message = await response.json()
        console.log(`✅ Sent ${logLabel} → message id ${message.id}`)
        return message.id
    } catch (error) {
        console.error(`⚠️ Discord send failed for ${logLabel}:`, error.message)
        return null
    }
}

async function deleteFromWebhook(webhookBase, messageId, logLabel) {
    if (!messageId) {
        console.log(`ℹ️ No message id for ${logLabel} — nothing to delete (skip)`)
        return
    }
    const url = `${webhookBase}/messages/${messageId}`
    try {
        const response = await fetch(url, { method: 'DELETE' })
        if (response.ok || response.status === 404) {
            console.log(`🗑️  Deleted ${logLabel}${response.status === 404 ? ' (already gone)' : ''}`)
            return
        }
        const text = await response.text().catch(() => '')
        console.error(`⚠️ Discord DELETE ${response.status} for ${logLabel}: ${text.slice(0, 200)}`)
    } catch (error) {
        console.error(`⚠️ Discord delete failed for ${logLabel}:`, error.message)
    }
}

// ============================================================
// Handlers — one per NOTIFY channel
// ============================================================
async function handleNewTicket(client, msg) {
    let ticket
    try {
        ticket = JSON.parse(msg.payload)
    } catch (e) {
        console.error('⚠️ Failed to parse new_it_ticket payload:', e.message)
        return
    }
    console.log(`📬 new_it_ticket: ${ticket.ticket_no}`)

    const messageId = await postToWebhook(TICKET_WEBHOOK, buildTicketEmbed(ticket), `ticket ${ticket.ticket_no}`)
    if (!messageId) return

    try {
        await client.query(
            `UPDATE it_tickets SET discord_message_id = $1 WHERE id = $2`,
            [messageId, ticket.id]
        )
    } catch (error) {
        console.error('⚠️ Failed to save ticket message id:', error.message)
    }
}

async function handleTicketResolved(msg) {
    let payload
    try {
        payload = JSON.parse(msg.payload)
    } catch (e) {
        console.error('⚠️ Failed to parse it_ticket_resolved payload:', e.message)
        return
    }
    console.log(`📬 it_ticket_resolved: ${payload.ticket_no} → ${payload.status}`)
    await deleteFromWebhook(TICKET_WEBHOOK, payload.discord_message_id, `ticket ${payload.ticket_no}`)
}

async function handleNewBorrowing(client, msg) {
    let b
    try {
        b = JSON.parse(msg.payload)
    } catch (e) {
        console.error('⚠️ Failed to parse new_equipment_borrowing payload:', e.message)
        return
    }
    console.log(`📬 new_equipment_borrowing: ${b.equipment_asset_tag || b.equipment_id} by ${b.borrower_name}`)

    const label = `borrow #${b.id} (${b.equipment_asset_tag || b.equipment_id})`
    const messageId = await postToWebhook(EQUIPMENT_WEBHOOK, buildBorrowingEmbed(b), label)
    if (!messageId) return

    try {
        await client.query(
            `UPDATE equipment_borrowings SET discord_message_id = $1 WHERE id = $2`,
            [messageId, b.id]
        )
    } catch (error) {
        console.error('⚠️ Failed to save borrowing message id:', error.message)
    }
}

async function handleBorrowingResolved(msg) {
    let payload
    try {
        payload = JSON.parse(msg.payload)
    } catch (e) {
        console.error('⚠️ Failed to parse equipment_borrowing_resolved payload:', e.message)
        return
    }
    console.log(`📬 equipment_borrowing_resolved: #${payload.id} → ${payload.status}`)
    await deleteFromWebhook(EQUIPMENT_WEBHOOK, payload.discord_message_id, `borrow #${payload.id}`)
}

async function handleCheckinEvent(msg) {
    let ev
    try {
        ev = JSON.parse(msg.payload)
    } catch (e) {
        console.error('⚠️ Failed to parse gps_checkin_event payload:', e.message)
        return
    }

    // กรองตาม allowlist username
    if (CHECKIN_USERNAMES.length === 0) {
        console.log('ℹ️ CHECKIN_USERNAMES ว่าง — ข้าม check-in notify (ตั้ง env เพื่อเปิดใช้)')
        return
    }
    if (!CHECKIN_USERNAMES.includes(ev.username)) {
        return // ไม่อยู่ใน allowlist — ข้ามเงียบๆ
    }

    console.log(`📬 gps_checkin_event: ${ev.username} ${ev.type} @ ${ev.event_time}`)
    // check-in ไม่ ping (CHECKIN_MENTION default = '')
    await postToWebhook(CHECKIN_WEBHOOK, buildCheckinEmbed(ev), `checkin ${ev.username}`, CHECKIN_MENTION)
}

// ============================================================
// DB connection — LISTEN on all enabled channels
// ============================================================
async function connectAndListen() {
    const client = new Client({
        connectionString: DATABASE_URL,
        ssl: DATABASE_URL.includes('railway') || DATABASE_URL.includes('render') || DATABASE_URL.includes('amazonaws')
            ? { rejectUnauthorized: false }
            : false,
    })

    client.on('notification', async (msg) => {
        switch (msg.channel) {
            case 'new_it_ticket':
                await handleNewTicket(client, msg)
                break
            case 'it_ticket_resolved':
                await handleTicketResolved(msg)
                break
            case 'new_equipment_borrowing':
                if (EQUIPMENT_WEBHOOK) await handleNewBorrowing(client, msg)
                break
            case 'equipment_borrowing_resolved':
                if (EQUIPMENT_WEBHOOK) await handleBorrowingResolved(msg)
                break
            case 'gps_checkin_event':
                if (CHECKIN_WEBHOOK) await handleCheckinEvent(msg)
                break
        }
    })

    client.on('error', (err) => {
        console.error('💥 DB client error:', err.message)
    })

    client.on('end', () => {
        console.warn(`🔌 DB connection ended — reconnecting in ${RECONNECT_DELAY_MS}ms`)
        setTimeout(connectAndListen, RECONNECT_DELAY_MS)
    })

    try {
        await client.connect()
        const channels = ['new_it_ticket', 'it_ticket_resolved']
        if (EQUIPMENT_WEBHOOK) {
            channels.push('new_equipment_borrowing', 'equipment_borrowing_resolved')
        }
        if (CHECKIN_WEBHOOK) {
            channels.push('gps_checkin_event')
        }
        for (const ch of channels) {
            await client.query(`LISTEN ${ch}`)
        }
        console.log(`👂 Listening on ${channels.length} channels: ${channels.join(', ')}`)
        if (!EQUIPMENT_WEBHOOK) {
            console.log('ℹ️  DISCORD_WEBHOOK_EQUIPMENT not set — equipment borrowing notifications disabled')
        }
        if (!CHECKIN_WEBHOOK) {
            console.log('ℹ️  DISCORD_WEBHOOK_CHECKIN not set — check-in notifications disabled')
        } else if (CHECKIN_USERNAMES.length === 0) {
            console.log('⚠️  DISCORD_WEBHOOK_CHECKIN set but CHECKIN_USERNAMES empty — no one will be notified')
        } else {
            console.log(`✅ Check-in notify for ${CHECKIN_USERNAMES.length} users: ${CHECKIN_USERNAMES.join(', ')}`)
        }
    } catch (error) {
        console.error('💥 Failed to connect/listen:', error.message)
        setTimeout(connectAndListen, RECONNECT_DELAY_MS)
    }
}

// ============================================================
// Keep-alive HTTP server (only if PORT is set — e.g., Render)
// ============================================================
function startKeepAliveServer() {
    const port = Number(process.env.PORT)
    if (!port) {
        console.log('ℹ️  PORT not set — skipping HTTP server (local mode)')
        return
    }
    const startedAt = Date.now()
    const server = createServer((req, res) => {
        if (req.url === '/health' || req.url === '/') {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
                status: 'ok',
                uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
                bot: BOT_NAME,
                features: {
                    it_tickets: true,
                    equipment_borrowings: !!EQUIPMENT_WEBHOOK,
                    checkins: !!CHECKIN_WEBHOOK && CHECKIN_USERNAMES.length > 0,
                },
            }))
        } else {
            res.writeHead(404)
            res.end()
        }
    })
    server.listen(port, () => {
        console.log(`🌐 Keep-alive server on port ${port} — endpoint: /health`)
    })
    server.on('error', (err) => {
        console.error('⚠️ HTTP server error:', err.message)
    })
}

process.on('SIGINT', () => {
    console.log('\n👋 Shutting down...')
    process.exit(0)
})
process.on('SIGTERM', () => {
    console.log('👋 Received SIGTERM, shutting down...')
    process.exit(0)
})

startKeepAliveServer()
connectAndListen()
