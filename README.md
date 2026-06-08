# BMU Discord IT Bot

Standalone Discord bot ที่ฟัง PostgreSQL NOTIFY และส่งแจ้งเตือนแบบ real-time เข้า Discord channel

**ไม่ผูกกับ web app เลย** — bot นี้รันแยก ดูแลแยก ลบ/แก้ได้โดยไม่กระทบระบบหลัก สื่อกลางคือ PostgreSQL trigger ที่ติดตั้งครั้งเดียวด้วย `setup.sql`

## Notification channels

| Event | NOTIFY channel | Webhook env | บังคับ? |
|-------|----------------|-------------|---------|
| IT ticket ใหม่ / resolve | `new_it_ticket`, `it_ticket_resolved` | `DISCORD_WEBHOOK_IT_TICKET` | ✅ จำเป็น |
| ขอยืมอุปกรณ์ / อนุมัติ | `new_equipment_borrowing`, `equipment_borrowing_resolved` | `DISCORD_WEBHOOK_EQUIPMENT` | ปิดได้ |
| เช็คอิน/เอาท์ (allowlist) | `gps_checkin_event` | `DISCORD_WEBHOOK_CHECKIN` | ปิดได้ |
| **Error log (500 / crash)** | **`new_error_log`** | **`DISCORD_WEBHOOK_ERROR_LOG`** | ปิดได้ |
| **API error ตามพนักงาน (4xx/5xx)** | **`new_api_error`** | **`DISCORD_WEBHOOK_API_ERROR`** | ปิดได้ |

> **Error log** = แจ้งเตือนเมื่อ backend เกิด error ที่ถูกเขียนลงตาราง `error_logs` (หน้า System Status → "บันทึกข้อผิดพลาด") — มาจาก Express 500 handler / `uncaughtException` / `unhandledRejection`. มี **dedup** (error ตัวเดิมซ้ำใน 60 วิ → ข้าม) + **rate cap** (≤15/นาที, เกินจะสรุปเป็น 1 ข้อความ) กัน error storm ท่วม channel. ไม่ ping โดย default (ตั้ง `ERROR_LOG_MENTION=@everyone` เพื่อเปิด)
>
> **API error** = แจ้งเตือนเมื่อ "พนักงานเรียก API แล้ว error 4xx/5xx" (ตาราง `api_access_logs`, หน้า System Status → "การเรียก API ที่ error ตามพนักงาน"). บอก: ใคร / method+endpoint / status / หน้าที่เรียก / IP. **volume สูงกว่า error log** → กรองด้วย `API_ERROR_MIN_STATUS` (**default 500 = เฉพาะ 5xx**; ตั้ง 400 เพื่อรวม 4xx) + dedup 5 นาที + cap 10/นาที. ⚠️ 5xx จะเด้งทั้ง channel นี้ **และ** error log (คนละมุม: "ใครเจอ" vs "error อะไร")

## How it works

```
[User สร้าง ticket]
       ↓
[Backend INSERT it_tickets]
       ↓
[PostgreSQL trigger ยิง NOTIFY 'new_it_ticket' พร้อม JSON payload]
       ↓
[Bot ที่ LISTEN อยู่รับ event ผ่าน DB connection]
       ↓
[POST → Discord webhook]
```

## Setup (3 ขั้นตอน)

### 1) ติดตั้ง DB trigger (ครั้งเดียว)

รัน `setup.sql` บน production database

**วิธี A — psql จาก local:**
```bash
psql "postgresql://user:pass@host:5432/dbname" -f setup.sql
```

**วิธี B — Railway dashboard:**
- เปิด Railway project → Postgres service → Data → Query
- Paste เนื้อหา `setup.sql` ทั้งหมด → Run

ทดสอบว่าติดตั้งสำเร็จ:
```sql
SELECT tgname FROM pg_trigger WHERE tgname = 'it_tickets_notify_insert';
-- ควรเจอ 1 row
```

### 2) เตรียม Discord webhook

- ไป Discord channel ที่ต้องการ → Edit Channel → Integrations → Webhooks → New Webhook
- Copy Webhook URL

### 3) Deploy bot

เลือกหนึ่งใน 3 ทางด้านล่าง

---

## Deploy Options

### Option A: ทดสอบบน local ก่อน (แนะนำให้ลองก่อน deploy)

```bash
cd discord-bot
npm install
cp .env.example .env
# แก้ .env ใส่ DATABASE_URL + DISCORD_WEBHOOK_IT_TICKET
npm start
```

ควรเห็น log:
```
👂 Listening on channel "new_it_ticket"
```

ลองสร้าง IT ticket ผ่านระบบ → ภายใน 1 วินาทีจะเห็น:
```
📬 received new_it_ticket: {"id":...
✅ Sent ticket IT-202605-001 to Discord
```

### Option B: Fly.io (free tier — แนะนำ)

Fly.io free tier มี 3 shared VMs (256MB RAM แต่ละตัว) — bot ตัวเล็กแบบนี้ใช้ฟรีได้สบาย

```bash
# ติดตั้ง flyctl (Windows PowerShell)
iwr https://fly.io/install.ps1 -useb | iex

# เข้าสู่ระบบ
fly auth login

# จาก discord-bot/ folder
cd discord-bot
fly launch --no-deploy
# ตอบ prompt: ชื่อ app, region (sin = สิงคโปร์ใกล้ที่สุด), ไม่ต้อง Postgres, ไม่ต้อง Redis

# ตั้ง secrets (ห้าม commit ลง git)
fly secrets set DATABASE_URL="postgresql://..." \
                DISCORD_WEBHOOK_IT_TICKET="https://discord.com/api/webhooks/..."

# Deploy
fly deploy

# ดู log แบบ real-time
fly logs
```

### Option C: Render Free Web Service + UptimeRobot (ฟรีจริง ไม่ต้องบัตร) ⭐

Bot มี HTTP `/health` endpoint อยู่แล้ว (เปิดอัตโนมัติเมื่อ `PORT` env ถูกตั้ง) — Render Free Web Service จะ sleep หลัง 15 นาทีไม่มี request เราใช้ UptimeRobot ping `/health` ทุก 5 นาที → ไม่ sleep, ฟรีตลอด

**Step 1 — Deploy บน Render**

1. ไป https://render.com/ → Sign up ด้วย GitHub (ไม่ต้องใส่บัตรเครดิต)
2. Dashboard → **New +** → **Web Service**
3. Connect GitHub repo `bmu-discord-it-bot`
4. ตั้งค่า:
   - **Name:** `bmu-discord-it-bot` (หรือชื่อที่ต้องการ)
   - **Region:** Singapore
   - **Branch:** `main`
   - **Runtime:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** **Free**
5. เลื่อนลง **Environment Variables** → กด **Add Environment Variable**:
   | Key | Value |
   |-----|-------|
   | `DATABASE_URL` | (postgres connection string) |
   | `DISCORD_WEBHOOK_IT_TICKET` | (Discord webhook URL) |
   | `MENTION` | `@everyone` (หรือเว้น) |
6. กด **Create Web Service** → Render จะ build + deploy (~3 นาที)
7. เมื่อ deploy เสร็จ จะได้ URL เช่น `https://bmu-discord-it-bot.onrender.com` — ทดสอบ: เปิด `https://<your-url>/health` ใน browser ควรเห็น JSON `{"status":"ok",...}`

**Step 2 — ตั้ง UptimeRobot ping ไม่ให้ sleep**

1. ไป https://uptimerobot.com/ → Sign up ฟรี (ไม่ต้องบัตร)
2. Dashboard → **+ New Monitor**
3. ตั้งค่า:
   - **Monitor Type:** `HTTP(s)`
   - **Friendly Name:** `BMU Discord Bot Keep-Alive`
   - **URL:** `https://<your-render-url>/health`
   - **Monitoring Interval:** `5 minutes` (free tier minimum)
4. **Create Monitor**
5. รอ ~10 นาที — UptimeRobot จะ ping bot ทุก 5 นาที ทำให้ Render ไม่ sleep

**Step 3 — Update flow ในอนาคต**

แก้โค้ด → `git push origin main` → Render auto re-deploy อัตโนมัติ (เห็น log ใน Render dashboard)

**ข้อจำกัด:**
- Render free: 750 ชม./เดือน, 512MB RAM (เพียงพอสำหรับ bot นี้)
- ถ้าไม่มี ping เข้ามา 15 นาที → sleep + ใช้เวลา ~30 วิ wake up ครั้งแรก
- ช่วง 30 วิ wake up: ถ้ามี ticket เข้ามาตอนนั้น = **อาจพลาด** (เพราะ DB LISTEN ขาด)
- UptimeRobot ป้องกัน sleep ได้ ≥99% ของเวลา

### Option D: รันบน PC ตัวเอง (ฟรี แต่ PC ต้องเปิด)

ทำตาม Option A แล้วใช้ PM2 หรือ Windows Task Scheduler เพื่อรันเป็น background service:

```bash
npm install -g pm2
pm2 start index.js --name bmu-discord-bot
pm2 save
pm2 startup  # ทำตาม instruction เพื่อ auto-start เมื่อบูต PC
```

---

## Troubleshooting

| อาการ | สาเหตุ / วิธีแก้ |
|-------|-----------------|
| Bot ไม่ได้รับ event | เช็คว่า trigger ติดตั้งแล้ว: `SELECT tgname FROM pg_trigger WHERE tgname = 'it_tickets_notify_insert'` |
| `Connection terminated unexpectedly` | DB หลุด — bot จะ reconnect อัตโนมัติทุก 5 วินาที (ดู `RECONNECT_DELAY_MS`) |
| `Discord 401` | webhook URL ผิดหรือถูกลบ → สร้างใหม่ |
| `Discord 429` | Rate limited — ถ้ายิงเยอะมาก (>30/นาที) ต้องเพิ่ม queue |
| Bot ไม่ start | ดูว่าใส่ `DATABASE_URL` และ `DISCORD_WEBHOOK_IT_TICKET` ครบหรือยัง |
| Error log ไม่เด้ง | (1) ตั้ง `DISCORD_WEBHOOK_ERROR_LOG` แล้วยัง? (2) ติดตั้ง trigger แล้ว: `SELECT tgname FROM pg_trigger WHERE tgname = 'error_logs_notify_insert'` (3) ทดสอบ: `npm run test:error` |
| Error เด้งซ้ำๆ ถี่ | ปกติ — มี dedup 60 วิ + cap 15/นาที. ปรับ `ERROR_LOG_DEDUP_SEC` / `ERROR_LOG_MAX_PER_MIN` ได้ |
| API error ไม่เด้ง | (1) ตั้ง `DISCORD_WEBHOOK_API_ERROR` แล้วยัง? (2) status ต่ำกว่า `API_ERROR_MIN_STATUS` (default 500) — 4xx ถูกกรองทิ้ง ตั้ง `=400` เพื่อรวม (3) trigger: `SELECT tgname FROM pg_trigger WHERE tgname='api_access_logs_notify_insert'` (4) `npm run test:apierror` |
| API error spam เยอะ | ขึ้น `API_ERROR_MIN_STATUS=500` (เฉพาะ 5xx) หรือเพิ่ม `API_ERROR_DEDUP_SEC` / ลด `API_ERROR_MAX_PER_MIN` |

## Uninstall

ถ้าอยากปิดระบบนี้ทั้งหมด:
1. หยุด bot (fly apps destroy / pm2 stop / Ctrl+C)
2. ลบ trigger บน database:
   ```sql
   DROP TRIGGER IF EXISTS it_tickets_notify_insert ON it_tickets;
   DROP FUNCTION IF EXISTS notify_new_it_ticket();
   DROP TRIGGER IF EXISTS error_logs_notify_insert ON error_logs;
   DROP FUNCTION IF EXISTS notify_new_error_log();
   DROP TRIGGER IF EXISTS api_access_logs_notify_insert ON api_access_logs;
   DROP FUNCTION IF EXISTS notify_new_api_error();
   -- (และ trigger อื่นๆ ที่ไม่ใช้: equipment_borrowings_*, gps_checkins_notify_insert)
   ```

## Architecture notes

- **ทำไมใช้ LISTEN/NOTIFY ไม่ใช้ polling?** — Real-time (latency หลักสิบ ms vs polling 30 วินาที) และไม่โหลด DB
- **ทำไมไม่ใช้ Discord bot token?** — Webhook ง่ายกว่า ไม่ต้องดูแล bot session, ไม่ต้อง implement Gateway protocol
- **ถ้า bot ดับตอนมี ticket เข้า?** — ticket นั้นจะหายไป (NOTIFY ไม่ได้ persist) เพราะออกแบบให้ bot dispensable. ถ้าต้องการ guaranteed delivery ต้องเก็บ outbox table เพิ่ม
