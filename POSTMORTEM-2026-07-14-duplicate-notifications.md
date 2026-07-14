# Post-mortem: Discord แจ้งเตือนซ้ำ 2 รอบทุก event (14 ก.ค. 2026)

**สถานะ:** แก้ไขแล้ว · **ระยะเวลาที่กระทบ:** 01:08 – ~13:00 น. (≈12 ชม.) · **ผู้เขียน:** IT (ชยพล) + Claude

---

## 1) เกิดอะไรขึ้น

ตั้งแต่ 01:08 น. ของวันที่ 14 ก.ค. 2026 ทุกการแจ้งเตือนในช่อง IT Ticket เด้งซ้ำ **2 ข้อความติดกัน** (@everyone ทั้งคู่) — ผู้ใช้สังเกตเห็นจาก ticket `IT-202607-040` เวลา 11:36 น. และรายงานเข้ามา

### Timeline (เวลาไทย)

| เวลา | เหตุการณ์ |
|------|-----------|
| 27 พ.ค. | Bot ขึ้น production บน Render — โค้ด reconnect มีบั๊กแฝงมาตั้งแต่ commit แรก แต่ยังไม่แสดงอาการ |
| 14 ก.ค. ~01:08:30 | Connection ระหว่าง bot (Render) ↔ PostgreSQL (Railway) **หลุดชั่วคราว** (network/proxy blip — DB ไม่ได้ restart, postmaster ทำงานต่อเนื่องตั้งแต่ 8 พ.ค.) |
| 01:08:38 | Reconnect ครั้งแรกล้มเหลวพอดี → บั๊กทำงาน: เกิด **DB connection ซ้อน 2 เส้น** (ห่างกัน 27ms — pid 732105/732106) ทั้งคู่ LISTEN ครบทุก channel |
| 01:08 – 11:36 | ทุก NOTIFY ถูกประมวลผล 2 ครั้ง → ticket ใหม่ทุกใบโพสต์ซ้ำ 2 ข้อความ (IT-202607-036 → 040 อย่างน้อย 5 ใบ) |
| 11:36 | ผู้ใช้รายงาน ticket `IT-202607-040` เด้งซ้ำ |
| ~12:00 | วินิจฉัยพบ connection ซ้อน 2 เส้นใน `pg_stat_activity` + repro บั๊กได้ในเครื่อง dev |
| ~13:00 | Deploy โค้ดแก้ → Render restart → เหลือ connection เดียว → เหตุการณ์จบ |

## 2) Impact

- **ผู้ใช้ทั้ง Discord server** โดน @everyone ซ้ำ 2 รอบต่อ ticket — วันนี้อย่างน้อย 5 ใบ (10 pings แทนที่จะเป็น 5)
- `discord_message_id` ใน DB ถูกเขียนทับ (2 connections ต่างก็ UPDATE) เหลือเก็บ id เดียว → เมื่อกด resolve/close **bot ลบข้อความได้แค่ 1 ใน 2** — ข้อความซ้ำอีกใบค้างใน channel ต้องลบมือ
- ช่อง Error Log / API error **ไม่เห็นผลกระทบ** — 2 connections อยู่ในโปรเซสเดียวกัน แชร์ dedup ในหน่วยความจำ ข้อความใบที่สองถูกกรองทิ้ง (window 60s/300s) แต่ช่อง ticket/ยืมอุปกรณ์/เช็คอินไม่มี dedup จึงซ้ำเต็มๆ
- **ไม่มี data loss** — ข้อมูลใน DB ถูกต้องครบ (1 ticket = 1 แถวเสมอ)

## 3) Root Cause

### สาเหตุที่แท้จริง: race ในลอจิก reconnect ของ `index.js`

`connectAndListen()` ตั้ง reconnect ได้ **2 ทางอิสระโดยไม่มีตัวกันซ้อน**:

```js
// ทาง A — handler 'end'
client.on('end', () => setTimeout(connectAndListen, RECONNECT_DELAY_MS))

// ทาง B — catch ของ connect ล้มเหลว
catch (error) { setTimeout(connectAndListen, RECONNECT_DELAY_MS) }
```

จุดตาย: ใน library `pg` เมื่อ **socket ถูกปิดระหว่างกำลัง connect** (`lib/client.js` — `con.once('end')` ปิดท้ายด้วย `process.nextTick(() => this.emit('end'))` แบบไม่มีเงื่อนไข) จะเกิด **ทั้งสองทางพร้อมกัน** จาก client ตัวเดียว:
promise ของ `connect()` reject (→ ทาง B) **และ** emit `'end'` (→ ทาง A) → ตั้ง timer 2 ตัว → 5 วินาทีต่อมาได้ client **2 ตัวถาวร** ต่างคน LISTEN ครบทุก channel → ทุก event โพสต์ซ้ำ

เงื่อนไขที่ทำให้บั๊กแสดงอาการ = "หลุดแล้ว **reconnect ครั้งแรกก็ยังล้มเหลวอีก**" — drop ปกติที่ต่อติดในครั้งเดียวจะไม่ double (มีแต่ทาง A) จึงอยู่เงียบมา 7 สัปดาห์

### หลักฐานที่ใช้ปิดเคส

1. `pg_stat_activity` บน production: connection 2 เส้น เกิดพร้อมกัน (ห่าง 27ms, 01:08:38) ทั้งคู่ last query = `UPDATE it_tickets SET discord_message_id...` ซึ่งมีแต่ bot รันหลังโพสต์สำเร็จ
2. Ticket `IT-202607-040` มี 1 แถว, trigger ตารางละ 1 ตัว → ตัดสมมติฐาน INSERT ซ้ำ / trigger ซ้ำ
3. Bot local (PM2) crash-loop ตลอด ไม่เคย connect → ไม่ใช่ผู้ส่ง; web app ไม่มีโค้ดยิง Discord
4. **Repro ได้ deterministic ในเครื่อง dev**: TCP proxy จำลอง "หลุด + reject ตอน reconnect" 1 จังหวะ → โค้ดเดิมเกิด 2 connections, 1 NOTIFY → 2 POST ทุกครั้ง

## 4) การแก้ไขและการทดสอบ

### แก้ (commit นี้) — `index.js`

เปลี่ยน reconnect เป็น **single-flight + generation guard**:

- `scheduleReconnect()` ตัวเดียว มี guard `if (reconnectTimer) return` — ตั้ง timer ซ้อนไม่ได้ไม่ว่าจะถูกเรียกจากกี่ทาง
- `generation` counter — event `'end'` จาก client รุ่นเก่าถูกเมิน ไม่ปลุก reconnect ผี
- `activeClient` — notification จาก client ที่ไม่ใช่ตัว active ถูกทิ้ง + log เตือน (ตาข่ายกันซ้ำชั้นสุดท้าย ต่อให้เกิด client ซ้อนด้วยเหตุไม่คาดคิด)
- `catch` เก็บซาก client (`client.end()`) กัน socket รั่ว
- log เลข generation ทุกครั้งที่ต่อ/หลุด → ดูความถี่ reconnect ได้จาก Render logs

### ทดสอบ

- **Repro บั๊กเดิมก่อนแก้** (โค้ดเก่า): จำลองหลุด + reconnect ล้มเหลว → เกิด 2 connections, NOTIFY เด้ง 2 POST ✗
- **โค้ดใหม่ สถานการณ์เดียวกัน 3 รอบติด**: เหลือ 1 connection ทุกรอบ, NOTIFY เด้ง 1 POST ✓
- **Regression ครบทุก channel**: ticket / borrow / checkin / checkout / error log / API error → อย่างละ 1 ข้อความเป๊ะ + flow resolve/approve ยิง DELETE ถูกต้อง ✓
- **Production หลัง deploy**: `pg_stat_activity` เหลือ bot connection 1 เส้น ✓

## 5) ป้องกันไม่ให้เกิดซ้ำ (Preventive Actions)

| # | มาตรการ | สถานะ |
|---|---------|-------|
| 1 | Single-flight reconnect + generation guard ใน `index.js` | ✅ ทำแล้ว (commit นี้) |
| 2 | Notification guard — client ที่ไม่ active ห้ามโพสต์ (กันซ้ำแม้มี client ซ้อนจากเหตุอื่น) | ✅ ทำแล้ว (commit นี้) |
| 3 | ลบ PM2 entry ค้างบนเครื่อง dev (`pm2 delete` + `pm2 save --force`) — ตัวนี้ crash-loop ทุก 5 วิมาตลอด และถ้าฟื้นเมื่อไหร่จะเป็น listener ซ้อนอีกตัว | ✅ ทำแล้ว |
| 4 | แก้ `pm2.config.cjs` เป็น `exec_mode: 'fork'` + คอมเมนต์เตือน "bot ต้องรันที่เดียวเท่านั้น" | ✅ ทำแล้ว |
| 5 | เพิ่มอาการ "เด้งซ้ำ 2 รอบ" + วิธีเช็คจำนวน listener ในตาราง Troubleshooting ของ README | ✅ ทำแล้ว |
| 6 | **กติกา ops:** bot รันที่เดียวเท่านั้น (ปัจจุบัน = Render) — เครื่อง dev ทดสอบเสร็จต้องปิด | 📌 ตกลงร่วมกัน |
| 7 | (ทางเลือกอนาคต) `pg_try_advisory_lock` ให้ bot เป็น singleton ข้ามโปรเซส — กัน deploy ซ้อนทุกรูปแบบ แลกกับ failure mode ใหม่ (lock ค้างถ้า connection ครึ่งตาย) | ⏳ ยังไม่ทำ — พิจารณาถ้ามีการ deploy หลายที่ |

### วิธีเช็คเร็วๆ ว่ามี listener ซ้อนไหม (ใช้ได้ทุกเมื่อ)

```sql
SELECT pid, client_addr, backend_start, LEFT(query, 60) AS last_query
FROM pg_stat_activity
WHERE query ILIKE 'LISTEN%' OR query ILIKE 'UPDATE it_tickets SET discord_message_id%';
-- bot ปกติต้องมี 1 เส้นเท่านั้น — เจอมากกว่านั้น = มีตัวซ้อน (restart Render + หาว่าใครรันเพิ่ม)
```
