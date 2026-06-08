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
 *   Error logs (optional — only if DISCORD_WEBHOOK_ERROR_LOG set):
 *     - new_error_log               → POST embed via DISCORD_WEBHOOK_ERROR_LOG
 *                                     (backend 500 / crash → System Status page)
 *                                     deduped + rate-capped to survive error storms
 *   API errors (optional — only if DISCORD_WEBHOOK_API_ERROR set):
 *     - new_api_error               → POST embed via DISCORD_WEBHOOK_API_ERROR
 *                                     (per-user 4xx/5xx API calls → System Status page)
 *                                     filtered by API_ERROR_MIN_STATUS, deduped + rate-capped
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
 *   DISCORD_WEBHOOK_ERROR_LOG enable backend error-log notifications
 *   ERROR_LOG_MENTION         mention for errors (default '' = no ping)
 *   ERROR_LOG_LEVELS          comma-separated level allowlist e.g. "error,fatal" (default all)
 *   ERROR_LOG_DEDUP_SEC       suppress identical error within N seconds (default 60)
 *   ERROR_LOG_MAX_PER_MIN     global cap of error posts per minute (default 15)
 *   DISCORD_WEBHOOK_API_ERROR enable per-user API error (4xx/5xx) notifications
 *   API_ERROR_MENTION         mention for API errors (default '' = no ping)
 *   API_ERROR_MIN_STATUS      only notify when status_code >= this (default 500 = 5xx only)
 *   API_ERROR_DEDUP_SEC       suppress same user+endpoint+status within N seconds (default 300)
 *   API_ERROR_MAX_PER_MIN     global cap of API-error posts per minute (default 10)
 *   PORT                      if set, starts HTTP server with /health endpoint
 *   RENDER_EXTERNAL_URL       auto-set on Render → enables self-ping
 *   SELF_PING_URL             manual override if not on Render
 *   SELF_PING_INTERVAL_MIN    self-ping interval in minutes (default 10)
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

// ===== Error log (System Status → บันทึกข้อผิดพลาด) =====
const ERROR_LOG_WEBHOOK = process.env.DISCORD_WEBHOOK_ERROR_LOG?.split('?')[0] || null
// error ไม่ ping โดย default (errorอาจมาเป็นชุด — กัน @everyone spam). ตั้ง @everyone/<@&ROLE> เพื่อเปิด
const ERROR_LOG_MENTION = process.env.ERROR_LOG_MENTION ?? ''
// allowlist level ที่จะแจ้ง (คั่นด้วย comma) — ว่าง = ทุก level ที่ลงใน error_logs
const ERROR_LOG_LEVELS = (process.env.ERROR_LOG_LEVELS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
// dedup: error ตัวเดิม (level+category+code+message) ซ้ำภายใน N วิ → ข้าม (default 60)
const ERROR_LOG_DEDUP_SEC = Number(process.env.ERROR_LOG_DEDUP_SEC) || 60
// global cap: โพสต์ error ได้ไม่เกิน N ครั้ง/นาที (default 15) — กัน flood (Discord limit ~30/นาที)
const ERROR_LOG_MAX_PER_MIN = Number(process.env.ERROR_LOG_MAX_PER_MIN) || 15

// ===== API error (System Status → การเรียก API ที่ error ตามพนักงาน) =====
const API_ERROR_WEBHOOK = process.env.DISCORD_WEBHOOK_API_ERROR?.split('?')[0] || null
const API_ERROR_MENTION = process.env.API_ERROR_MENTION ?? ''
// แจ้งเฉพาะ status_code >= ค่านี้ (default 500 = เฉพาะ 5xx; ตั้ง 400 เพื่อรวม 4xx)
// api_access_logs เก็บ 4xx/5xx อยู่แล้ว แต่ 4xx (401/403/400) เกิดบ่อย — default เลยเอาแค่ 5xx กัน spam
const API_ERROR_MIN_STATUS = Number(process.env.API_ERROR_MIN_STATUS) || 500
// dedup: user+method+endpoint+status เดิมซ้ำภายใน N วิ → ข้าม (default 300 = 5 นาที, ยาวกว่า error_log)
const API_ERROR_DEDUP_SEC = Number(process.env.API_ERROR_DEDUP_SEC) || 300
// global cap ต่อนาที (default 10) — volume สูงกว่า error_log เลยตั้งต่ำกว่า
const API_ERROR_MAX_PER_MIN = Number(process.env.API_ERROR_MAX_PER_MIN) || 10

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

// ============================================================
// ERROR LOG metadata
// ============================================================
const ERRLOG_LEVEL_META = {
    fatal: { emoji: '💀', label: 'FATAL', color: 0x820014 }, // dark red
    error: { emoji: '🔴', label: 'ERROR', color: 0xff4d4f }, // red
    warn: { emoji: '🟠', label: 'WARNING', color: 0xfa8c16 }, // orange
    info: { emoji: '🔵', label: 'INFO', color: 0x1890ff }, // blue
}
const ERRLOG_LEVEL_DEFAULT = { emoji: '⚠️', label: 'ERROR', color: 0xff4d4f }

// "พื้นที่ต้นเหตุ" — ตรงกับ classifyError() ใน backend/utils/errorLogger.js
const ERRLOG_CATEGORY_META = {
    database: { emoji: '🗄️', label: 'ฐานข้อมูล' },
    external: { emoji: '🌐', label: 'ระบบภายนอก / เครือข่าย' },
    auth: { emoji: '🔐', label: 'สิทธิ์ / ยืนยันตัวตน' },
    validation: { emoji: '📋', label: 'ตรวจสอบข้อมูล' },
    server: { emoji: '🖥️', label: 'เซิร์ฟเวอร์' },
    unknown: { emoji: '❓', label: 'ไม่ทราบ' },
}

// source → label อ่านง่าย (ตรงกับ logError ctx.source ใน backend)
const ERRLOG_SOURCE_LABEL = {
    express_handler: 'Express handler (500)',
    uncaught_exception: 'Uncaught Exception',
    unhandled_rejection: 'Unhandled Rejection',
    manual: 'Manual',
}

function errlogCategoryLabel(category) {
    if (!category) return '❓ ไม่ทราบ'
    if (category.startsWith('route:')) return `🧩 Route: ${category.slice(6)}`
    const m = ERRLOG_CATEGORY_META[category]
    return m ? `${m.emoji} ${m.label}` : `📌 ${category}`
}

// ============================================================
// API ERROR (per-user 4xx/5xx) metadata
// ============================================================
const HTTP_STATUS_TH = {
    400: 'Bad Request — ข้อมูลไม่ถูกต้อง',
    401: 'Unauthorized — ไม่ได้ยืนยันตัวตน',
    403: 'Forbidden — ไม่มีสิทธิ์',
    404: 'Not Found — ไม่พบข้อมูล',
    405: 'Method Not Allowed',
    409: 'Conflict — ข้อมูลชนกัน',
    413: 'Payload Too Large — ไฟล์/ข้อมูลใหญ่เกิน',
    422: 'Unprocessable — ข้อมูลไม่ผ่านเงื่อนไข',
    429: 'Too Many Requests — เรียกถี่เกิน',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout',
}
function apiStatusLabel(code) {
    const n = Number(code)
    const txt = HTTP_STATUS_TH[n]
    return txt ? `${n} ${txt}` : `${n}`
}
// 5xx = แดง (เซิร์ฟเวอร์พัง) · 4xx = ส้ม (client/expected) · อื่นๆ = เทา
function apiStatusColor(code) {
    const n = Number(code)
    if (n >= 500) return 0xff4d4f
    if (n >= 400) return 0xfa8c16
    return 0x868e96
}
const METHOD_EMOJI = { GET: '📥', POST: '📤', PUT: '✏️', PATCH: '✏️', DELETE: '🗑️' }

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

function buildErrorLogEmbed(e) {
    const lvl = ERRLOG_LEVEL_META[String(e.level || '').toLowerCase()] || ERRLOG_LEVEL_DEFAULT
    const rawMsg = String(e.message || '(ไม่มีข้อความ)').slice(0, 1500)
    const quotedMsg = rawMsg.split('\n').map((line) => `> ${line}`).join('\n')

    const fields = [
        { name: '🚦 ระดับ', value: `**${lvl.label}**`, inline: true },
        { name: '📍 พื้นที่ต้นเหตุ', value: errlogCategoryLabel(e.category), inline: true },
    ]
    if (e.error_code) fields.push({ name: '🔢 Error code', value: `\`${String(e.error_code).slice(0, 100)}\``, inline: true })
    if (e.endpoint) fields.push({ name: '🔗 Endpoint', value: `\`${String(e.endpoint).slice(0, 200)}\``, inline: false })
    if (e.status_code) fields.push({ name: '📡 HTTP', value: `\`${e.status_code}\``, inline: true })
    if (e.source) fields.push({ name: '🧱 ต้นทาง', value: ERRLOG_SOURCE_LABEL[e.source] || `\`${e.source}\``, inline: true })
    if (e.stack) {
        // field value limit 1024 — stack ถูกตัดเหลือ 600 จาก trigger แล้ว เผื่อ code-fence
        const stack = String(e.stack).slice(0, 900).replace(/```/g, "'''")
        fields.push({ name: '🧵 Stack (ย่อ)', value: '```\n' + stack + '\n```', inline: false })
    }

    return {
        author: { name: '🐞 พบข้อผิดพลาดใหม่ในระบบ' },
        title: `${lvl.emoji}  ${String(e.error_code || lvl.label).slice(0, 240)}`,
        description: `${quotedMsg}\n​`,
        color: lvl.color,
        fields,
        footer: { text: 'BMU Work Management  •  System Status — บันทึกข้อผิดพลาด' },
    }
}

function buildApiErrorEmbed(a) {
    const methodEmoji = METHOD_EMOJI[String(a.method || '').toUpperCase()] || '🔗'
    const who = a.user_name
        ? (a.employee_id ? `${a.user_name} (${a.employee_id})` : a.user_name)
        : (a.employee_id || a.user_id || '-')

    const fields = [
        { name: '👤 พนักงาน', value: `**${String(who).slice(0, 200)}**`, inline: true },
        { name: '📡 สถานะ', value: `**${apiStatusLabel(a.status_code)}**`, inline: true },
    ]
    if (a.page_path) fields.push({ name: '🖥️ หน้าที่เรียก', value: `\`${String(a.page_path).slice(0, 200)}\``, inline: false })
    if (a.response_ms != null) fields.push({ name: '⏱️ ใช้เวลา', value: `${a.response_ms} ms`, inline: true })
    if (a.ip_address) fields.push({ name: '🌐 IP', value: `\`${String(a.ip_address).slice(0, 60)}\``, inline: true })

    return {
        author: { name: '👥 พนักงานเรียก API แล้ว error' },
        title: `${methodEmoji}  ${String(a.method || '').toUpperCase()} ${String(a.endpoint || '-').slice(0, 230)}`,
        color: apiStatusColor(a.status_code),
        fields,
        footer: { text: 'BMU Work Management  •  System Status — API access log' },
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
// Throttle — dedup + per-minute rate cap (shared: error_log + api_error)
// กัน notification storm ท่วม Discord + เลี่ยง Discord rate limit (~30/นาที)
// ============================================================
function createThrottle({ dedupSec, maxPerMin, onSummary }) {
    const dedup = new Map() // signature → last-sent ms
    let minuteStart = 0
    let minuteCount = 0
    let suppressed = 0

    // คืน true ถ้า "ควรโพสต์", false ถ้าโดน dedup หรือเกิน cap
    return function shouldPost(signature, now) {
        // 1) dedup — signature เดิมซ้ำภายใน window → ข้าม
        const last = dedup.get(signature)
        if (last && now - last < dedupSec * 1000) return false
        dedup.set(signature, now)
        if (dedup.size > 500) {
            // กวาด entry เก่ากัน map โตไม่จำกัด
            for (const [k, t] of dedup) {
                if (now - t > dedupSec * 1000) dedup.delete(k)
            }
        }
        // 2) per-minute cap — ขึ้นนาทีใหม่ → สรุปยอดที่ระงับของนาทีก่อน (ถ้ามี)
        if (now - minuteStart >= 60000) {
            if (suppressed > 0 && onSummary) onSummary(suppressed)
            minuteStart = now
            minuteCount = 0
            suppressed = 0
        }
        if (minuteCount >= maxPerMin) {
            suppressed++
            return false
        }
        minuteCount++
        return true
    }
}

// --- error log ---
const errlogThrottle = createThrottle({
    dedupSec: ERROR_LOG_DEDUP_SEC,
    maxPerMin: ERROR_LOG_MAX_PER_MIN,
    onSummary: (n) =>
        postToWebhook(
            ERROR_LOG_WEBHOOK,
            {
                author: { name: '🐞 ข้อผิดพลาดจำนวนมาก' },
                description: `ระงับการแจ้งเตือน **${n}** รายการในนาทีที่ผ่านมา (เกินลิมิต ${ERROR_LOG_MAX_PER_MIN}/นาที)\nดูทั้งหมดที่ **System Status → บันทึกข้อผิดพลาด**`,
                color: 0x820014,
                footer: { text: 'BMU Work Management  •  System Status' },
            },
            `error storm summary (${n})`,
            ERROR_LOG_MENTION
        ),
})

function errlogSignature(e) {
    return [e.level, e.category, e.error_code, String(e.message || '').slice(0, 120)].join('|')
}

async function handleNewErrorLog(msg) {
    let e
    try {
        e = JSON.parse(msg.payload)
    } catch (err) {
        console.error('⚠️ Failed to parse new_error_log payload:', err.message)
        return
    }
    // กรองตาม level allowlist (ว่าง = ทุก level)
    const level = String(e.level || 'error').toLowerCase()
    if (ERROR_LOG_LEVELS.length > 0 && !ERROR_LOG_LEVELS.includes(level)) return
    if (!errlogThrottle(errlogSignature(e), Date.now())) return

    console.log(`📬 new_error_log [${level}] ${e.category} — ${String(e.message || '').slice(0, 80)}`)
    await postToWebhook(ERROR_LOG_WEBHOOK, buildErrorLogEmbed(e), `error #${e.id} (${e.category})`, ERROR_LOG_MENTION)
}

// --- API error (per-user 4xx/5xx) ---
const apiErrorThrottle = createThrottle({
    dedupSec: API_ERROR_DEDUP_SEC,
    maxPerMin: API_ERROR_MAX_PER_MIN,
    onSummary: (n) =>
        postToWebhook(
            API_ERROR_WEBHOOK,
            {
                author: { name: '👥 API error จำนวนมาก' },
                description: `ระงับการแจ้งเตือน **${n}** รายการในนาทีที่ผ่านมา (เกินลิมิต ${API_ERROR_MAX_PER_MIN}/นาที)\nดูทั้งหมดที่ **System Status → การเรียก API ที่ error ตามพนักงาน**`,
                color: 0x820014,
                footer: { text: 'BMU Work Management  •  System Status' },
            },
            `api-error storm summary (${n})`,
            API_ERROR_MENTION
        ),
})

function apiErrorSignature(a) {
    return [a.user_id, a.method, a.endpoint, a.status_code].join('|')
}

async function handleNewApiError(msg) {
    let a
    try {
        a = JSON.parse(msg.payload)
    } catch (err) {
        console.error('⚠️ Failed to parse new_api_error payload:', err.message)
        return
    }
    // กรองตาม status threshold (default 500 = เฉพาะ 5xx; ตั้ง API_ERROR_MIN_STATUS=400 เพื่อรวม 4xx)
    if (Number(a.status_code) < API_ERROR_MIN_STATUS) return
    if (!apiErrorThrottle(apiErrorSignature(a), Date.now())) return

    console.log(`📬 new_api_error ${a.status_code} ${a.method} ${a.endpoint} — ${a.user_name || a.user_id}`)
    await postToWebhook(API_ERROR_WEBHOOK, buildApiErrorEmbed(a), `api-error #${a.id} (${a.status_code})`, API_ERROR_MENTION)
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
            case 'new_error_log':
                if (ERROR_LOG_WEBHOOK) await handleNewErrorLog(msg)
                break
            case 'new_api_error':
                if (API_ERROR_WEBHOOK) await handleNewApiError(msg)
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
        if (ERROR_LOG_WEBHOOK) {
            channels.push('new_error_log')
        }
        if (API_ERROR_WEBHOOK) {
            channels.push('new_api_error')
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
        if (!ERROR_LOG_WEBHOOK) {
            console.log('ℹ️  DISCORD_WEBHOOK_ERROR_LOG not set — error log notifications disabled')
        } else {
            const lvls = ERROR_LOG_LEVELS.length ? `levels: ${ERROR_LOG_LEVELS.join(', ')}` : 'all levels'
            console.log(`✅ Error log notify enabled (${lvls}) — dedup ${ERROR_LOG_DEDUP_SEC}s, cap ${ERROR_LOG_MAX_PER_MIN}/min, mention "${ERROR_LOG_MENTION || '(none)'}"`)
        }
        if (!API_ERROR_WEBHOOK) {
            console.log('ℹ️  DISCORD_WEBHOOK_API_ERROR not set — API error notifications disabled')
        } else {
            console.log(`✅ API error notify enabled (status >= ${API_ERROR_MIN_STATUS}) — dedup ${API_ERROR_DEDUP_SEC}s, cap ${API_ERROR_MAX_PER_MIN}/min, mention "${API_ERROR_MENTION || '(none)'}"`)
        }
    } catch (error) {
        console.error('💥 Failed to connect/listen:', error.message)
        setTimeout(connectAndListen, RECONNECT_DELAY_MS)
    }
}

/**
 * Self-ping — bot ยิง /health ของตัวเองทุก ๆ N นาที
 * เพื่อให้ Render เห็น traffic + ไม่ sleep โดยไม่ต้องพึ่ง UptimeRobot
 *
 * จะทำงานก็ต่อเมื่อมี URL ของตัวเอง:
 *   - บน Render: ใช้ RENDER_EXTERNAL_URL (auto-injected)
 *   - บนที่อื่น: ตั้ง SELF_PING_URL เอง
 *
 * Interval default = 10 นาที (Render sleep ที่ 15 นาที → 10 = safety margin)
 *
 * ⚠️ Caveat: ถ้า bot ดับสนิทไม่ restart → self-ping ตาย → sleep ในที่สุด
 *   (Render ปกติ auto-restart เมื่อ crash → ส่วนใหญ่ self-ping จะกลับมาเอง)
 */
function startSelfPing() {
    const baseUrl = process.env.RENDER_EXTERNAL_URL || process.env.SELF_PING_URL
    if (!baseUrl) {
        console.log('ℹ️  No RENDER_EXTERNAL_URL / SELF_PING_URL — skipping self-ping')
        return
    }
    const pingUrl = baseUrl.replace(/\/$/, '') + '/health'
    const intervalMin = Number(process.env.SELF_PING_INTERVAL_MIN) || 10
    const intervalMs = intervalMin * 60 * 1000

    const ping = async () => {
        try {
            const r = await fetch(pingUrl)
            console.log(`🏓 Self-ping ${r.status}`)
        } catch (e) {
            console.warn(`⚠️ Self-ping failed: ${e.message}`)
        }
    }

    setInterval(ping, intervalMs)
    console.log(`🏓 Self-ping every ${intervalMin} min → ${pingUrl}`)
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
                    error_logs: !!ERROR_LOG_WEBHOOK,
                    api_errors: !!API_ERROR_WEBHOOK,
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
startSelfPing()
connectAndListen()
