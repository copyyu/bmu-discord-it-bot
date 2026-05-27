/**
 * BMU Discord IT Bot
 *
 * Listens to PostgreSQL NOTIFY channels and forwards events to Discord:
 *   - new_it_ticket       → POST new embed to Discord
 *   - it_ticket_resolved  → DELETE existing Discord message when status = resolved/closed
 *
 * No coupling with the web app — the only contract is the DB triggers in setup.sql
 *
 * Required env:
 *   DATABASE_URL              postgres:// connection string
 *   DISCORD_WEBHOOK_IT_TICKET https://discord.com/api/webhooks/...
 *
 * Optional env:
 *   PORT                      if set, starts HTTP server with /health endpoint
 *                             (used by Render + UptimeRobot keep-alive trick)
 *   BOT_NAME                  override displayed username (default "BMU IT Bot")
 *   MENTION                   '@everyone' (default), '@here', '<@&ROLE_ID>', or '' to disable
 *   RECONNECT_DELAY_MS        ms before reconnect on DB drop (default 5000)
 */

import pg from 'pg'
import { createServer } from 'http'

const { Client } = pg

const NEW_CHANNEL = 'new_it_ticket'
const RESOLVED_CHANNEL = 'it_ticket_resolved'
const BOT_NAME = process.env.BOT_NAME || 'BMU IT Bot'
const RECONNECT_DELAY_MS = Number(process.env.RECONNECT_DELAY_MS) || 5000
// MENTION = '@everyone' (ปลุกทุกคน), '@here' (เฉพาะ online), '<@&ROLE_ID>' (เฉพาะ role)
// ปล่อยว่าง = ไม่ tag ใครเลย
const MENTION = process.env.MENTION ?? '@everyone'

const CATEGORY_META = {
    system_issue: { emoji: '⚙️', label: 'ปัญหาระบบ', color: 0xff4d4f },
    equipment_issue: { emoji: '🖥️', label: 'ปัญหาอุปกรณ์', color: 0xfa8c16 },
    feature_request: { emoji: '✨', label: 'ขอฟีเจอร์ใหม่', color: 0x1890ff },
    nas_issue: { emoji: '💾', label: 'ปัญหา NAS', color: 0x722ed1 },
}

const STATUS_BADGE = {
    open: '🟢 รอดำเนินการ',
    in_progress: '🟡 กำลังดำเนินการ',
    resolved: '✅ แก้ไขแล้ว',
    closed: '⚫ ปิดแล้ว',
}

const DEFAULT_META = { emoji: '❓', label: 'อื่นๆ', color: 0xff6b35 }

function requireEnv(key) {
    const value = process.env[key]
    if (!value) {
        console.error(`❌ Missing required env: ${key}`)
        process.exit(1)
    }
    return value
}

const DATABASE_URL = requireEnv('DATABASE_URL')
const WEBHOOK_URL = requireEnv('DISCORD_WEBHOOK_IT_TICKET')
// stripped query params for building /messages/{id} URL
const WEBHOOK_BASE = WEBHOOK_URL.split('?')[0]

function buildEmbed(ticket) {
    const meta = CATEGORY_META[ticket.category] || DEFAULT_META
    const rawDesc = (ticket.description || '(ไม่มีรายละเอียด)').slice(0, 1800)
    const quotedDesc = rawDesc.split('\n').map((line) => `> ${line}`).join('\n')
    const createdUnix = ticket.created_at
        ? Math.floor(new Date(ticket.created_at).getTime() / 1000)
        : Math.floor(Date.now() / 1000)

    return {
        author: { name: '🎫 มี IT Ticket ใหม่เข้ามา' },
        title: `${meta.emoji}  ${ticket.ticket_no}`,
        description: `${quotedDesc}\n​`,
        color: meta.color,
        fields: [
            { name: '📁 หมวดหมู่', value: `**${meta.label}**`, inline: true },
            { name: '👤 ผู้แจ้ง', value: `**${ticket.reporter_name || '-'}**`, inline: true },
            { name: '🚦 สถานะ', value: STATUS_BADGE[ticket.status] || `\`${ticket.status}\``, inline: true },
            { name: '​', value: `🕐 แจ้งเมื่อ <t:${createdUnix}:R>  •  <t:${createdUnix}:f>`, inline: false },
        ],
        footer: { text: 'BMU Work Management  •  IT Support System' },
        timestamp: new Date(createdUnix * 1000).toISOString(),
    }
}

/**
 * Send embed to Discord and return the created message id.
 * Uses ?wait=true so Discord returns the message object (with id).
 */
async function sendToDiscord(ticket) {
    const url = `${WEBHOOK_BASE}?wait=true`
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: BOT_NAME,
                content: MENTION || undefined,
                embeds: [buildEmbed(ticket)],
                allowed_mentions: { parse: ['everyone', 'roles', 'users'] },
            }),
        })

        if (!response.ok) {
            const text = await response.text().catch(() => '')
            console.error(`⚠️ Discord ${response.status}: ${text.slice(0, 200)}`)
            return null
        }

        const message = await response.json()
        console.log(`✅ Sent ticket ${ticket.ticket_no} → message id ${message.id}`)
        return message.id
    } catch (error) {
        console.error('⚠️ Discord send failed:', error.message)
        return null
    }
}

/**
 * Delete a Discord message previously sent by this webhook.
 * 404 is treated as "already gone" — safe to ignore.
 */
async function deleteDiscordMessage(messageId, ticketNo) {
    if (!messageId) {
        console.log(`ℹ️ No message id for ${ticketNo} — nothing to delete (skip)`)
        return
    }
    const url = `${WEBHOOK_BASE}/messages/${messageId}`
    try {
        const response = await fetch(url, { method: 'DELETE' })
        if (response.ok || response.status === 404) {
            console.log(`🗑️  Deleted Discord message for ${ticketNo}${response.status === 404 ? ' (already gone)' : ''}`)
            return
        }
        const text = await response.text().catch(() => '')
        console.error(`⚠️ Discord DELETE ${response.status}: ${text.slice(0, 200)}`)
    } catch (error) {
        console.error('⚠️ Discord delete failed:', error.message)
    }
}

async function handleNewTicket(client, msg) {
    let ticket
    try {
        ticket = JSON.parse(msg.payload)
    } catch (e) {
        console.error('⚠️ Failed to parse new_it_ticket payload:', e.message)
        return
    }
    console.log(`📬 new_it_ticket: ${ticket.ticket_no}`)

    const messageId = await sendToDiscord(ticket)
    if (!messageId) return

    // Save message id so we can delete it later when resolved/closed
    try {
        await client.query(
            `UPDATE it_tickets SET discord_message_id = $1 WHERE id = $2`,
            [messageId, ticket.id]
        )
    } catch (error) {
        console.error('⚠️ Failed to save message id to DB:', error.message)
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

    await deleteDiscordMessage(payload.discord_message_id, payload.ticket_no)
}

async function connectAndListen() {
    const client = new Client({
        connectionString: DATABASE_URL,
        ssl: DATABASE_URL.includes('railway') || DATABASE_URL.includes('render') || DATABASE_URL.includes('amazonaws')
            ? { rejectUnauthorized: false }
            : false,
    })

    client.on('notification', async (msg) => {
        if (msg.channel === NEW_CHANNEL) {
            await handleNewTicket(client, msg)
        } else if (msg.channel === RESOLVED_CHANNEL) {
            await handleTicketResolved(msg)
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
        await client.query(`LISTEN ${NEW_CHANNEL}`)
        await client.query(`LISTEN ${RESOLVED_CHANNEL}`)
        console.log(`👂 Listening on channels "${NEW_CHANNEL}" + "${RESOLVED_CHANNEL}"`)
    } catch (error) {
        console.error('💥 Failed to connect/listen:', error.message)
        setTimeout(connectAndListen, RECONNECT_DELAY_MS)
    }
}

/**
 * Optional HTTP server for keep-alive ping
 * Only starts if PORT env is set (Render injects it; local PM2 does not)
 * UptimeRobot pings /health every 5 min to prevent Render free tier sleep
 */
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
