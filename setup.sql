-- ============================================================
-- Discord Bot — DB Trigger Setup
-- ============================================================
-- รัน script นี้ครั้งเดียวบน production database
-- จะติดตั้ง:
--   IT Tickets:
--     1) คอลัมน์ it_tickets.discord_message_id
--     2) INSERT trigger → NOTIFY 'new_it_ticket'
--     3) UPDATE trigger → NOTIFY 'it_ticket_resolved' (resolved/closed)
--   Equipment Borrowings:
--     4) คอลัมน์ equipment_borrowings.discord_message_id
--     5) INSERT trigger → NOTIFY 'new_equipment_borrowing' (JOIN equipment + users)
--     6) UPDATE trigger → NOTIFY 'equipment_borrowing_resolved' (approved/rejected)
--   GPS Check-in:
--     7) INSERT trigger → NOTIFY 'gps_checkin_event' (bot กรองตาม username)
--   Error Logs (System Status):
--     8) INSERT trigger → NOTIFY 'new_error_log' (แจ้งทุก error ใหม่ที่ backend log)
--   API Access Logs (System Status):
--     9) INSERT trigger → NOTIFY 'new_api_error' (แจ้งเมื่อพนักงานเรียก API แล้ว error 4xx/5xx)
--
-- รันซ้ำได้ปลอดภัย (idempotent)
--
-- วิธีรัน:
--   cd discord-bot
--   npm run install-trigger
-- ============================================================

-- ============================================================
-- IT TICKETS
-- ============================================================

-- 1) เพิ่มคอลัมน์เก็บ Discord message id (รันซ้ำได้)
ALTER TABLE it_tickets ADD COLUMN IF NOT EXISTS discord_message_id VARCHAR(64);

-- 2) INSERT trigger — NOTIFY ตอนสร้าง ticket ใหม่
CREATE OR REPLACE FUNCTION notify_new_it_ticket()
RETURNS trigger AS $$
DECLARE
    payload json;
BEGIN
    payload := json_build_object(
        'id',            NEW.id,
        'ticket_no',     NEW.ticket_no,
        'category',      NEW.category,
        'description',   NEW.description,
        'status',        NEW.status,
        'reporter_id',   NEW.reporter_id,
        'reporter_name', NEW.reporter_name,
        'created_at',    NEW.created_at
    );
    PERFORM pg_notify('new_it_ticket', payload::text);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS it_tickets_notify_insert ON it_tickets;
CREATE TRIGGER it_tickets_notify_insert
    AFTER INSERT ON it_tickets
    FOR EACH ROW
    EXECUTE FUNCTION notify_new_it_ticket();

-- 3) UPDATE trigger — NOTIFY ตอน status เปลี่ยนเป็น resolved/closed
CREATE OR REPLACE FUNCTION notify_ticket_resolved()
RETURNS trigger AS $$
DECLARE
    payload json;
BEGIN
    IF NEW.status IN ('resolved', 'closed') AND OLD.status IS DISTINCT FROM NEW.status THEN
        payload := json_build_object(
            'id',                 NEW.id,
            'ticket_no',          NEW.ticket_no,
            'status',             NEW.status,
            'discord_message_id', NEW.discord_message_id
        );
        PERFORM pg_notify('it_ticket_resolved', payload::text);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS it_tickets_notify_update ON it_tickets;
CREATE TRIGGER it_tickets_notify_update
    AFTER UPDATE ON it_tickets
    FOR EACH ROW
    EXECUTE FUNCTION notify_ticket_resolved();


-- ============================================================
-- EQUIPMENT BORROWINGS
-- ============================================================

-- 4) เพิ่มคอลัมน์เก็บ Discord message id
ALTER TABLE equipment_borrowings ADD COLUMN IF NOT EXISTS discord_message_id VARCHAR(64);

-- 5) INSERT trigger — NOTIFY ตอนมีคนขอยืมใหม่ (JOIN equipment + users)
CREATE OR REPLACE FUNCTION notify_new_equipment_borrowing()
RETURNS trigger AS $$
DECLARE
    payload          json;
    eq_name          TEXT;
    eq_asset_tag     TEXT;
    eq_category      TEXT;
    borrower_name    TEXT;
    borrower_nick    TEXT;
BEGIN
    SELECT name, asset_tag, category
        INTO eq_name, eq_asset_tag, eq_category
        FROM equipment WHERE id = NEW.equipment_id;

    SELECT name, nick_name
        INTO borrower_name, borrower_nick
        FROM users WHERE id = NEW.borrower_id;

    payload := json_build_object(
        'id',                   NEW.id,
        'equipment_id',         NEW.equipment_id,
        'equipment_name',       eq_name,
        'equipment_asset_tag',  eq_asset_tag,
        'equipment_category',   eq_category,
        'borrower_id',          NEW.borrower_id,
        'borrower_name',        borrower_name,
        'borrower_nick',        borrower_nick,
        'borrow_date',          NEW.borrow_date,
        'expected_return_date', NEW.expected_return_date,
        'purpose',              NEW.purpose,
        'status',               NEW.status
    );
    PERFORM pg_notify('new_equipment_borrowing', payload::text);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS equipment_borrowings_notify_insert ON equipment_borrowings;
CREATE TRIGGER equipment_borrowings_notify_insert
    AFTER INSERT ON equipment_borrowings
    FOR EACH ROW
    EXECUTE FUNCTION notify_new_equipment_borrowing();

-- 6) UPDATE trigger — NOTIFY ตอน status เปลี่ยนจาก pending (approve/reject)
CREATE OR REPLACE FUNCTION notify_equipment_borrowing_resolved()
RETURNS trigger AS $$
DECLARE
    payload json;
BEGIN
    -- ลบ Discord message เมื่อ admin ตัดสินใจ (approved/rejected/borrowed)
    -- ไม่ทำงานตอน status เปลี่ยนเป็น returned (ตอนนั้น message หายไปแล้ว)
    IF NEW.status IN ('approved', 'rejected', 'borrowed')
       AND OLD.status = 'pending'
       AND OLD.status IS DISTINCT FROM NEW.status
    THEN
        payload := json_build_object(
            'id',                 NEW.id,
            'status',             NEW.status,
            'discord_message_id', NEW.discord_message_id
        );
        PERFORM pg_notify('equipment_borrowing_resolved', payload::text);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS equipment_borrowings_notify_update ON equipment_borrowings;
CREATE TRIGGER equipment_borrowings_notify_update
    AFTER UPDATE ON equipment_borrowings
    FOR EACH ROW
    EXECUTE FUNCTION notify_equipment_borrowing_resolved();


-- ============================================================
-- GPS CHECK-IN / CHECK-OUT
-- ============================================================
-- ไม่ต้องเก็บ message_id — check-in เป็น log ถาวร ไม่มีการลบ
-- ส่งทุก check-in (ยกเว้น test) มา bot → bot กรองตาม username (env CHECKIN_USERNAMES)
--   เหตุผล: เปลี่ยนรายชื่อได้ที่ env ไม่ต้องรัน SQL ใหม่ + ไม่ฝัง username ใน repo
-- ใช้ now() AT TIME ZONE 'Asia/Bangkok' (now() เป็น timestamptz → แปลง tz ได้ตรง)
--   แทน checked_at ที่เป็น timestamp without time zone (เลี่ยง tz ambiguity)

CREATE OR REPLACE FUNCTION notify_gps_checkin()
RETURNS trigger AS $$
DECLARE
    payload     json;
    v_username  TEXT;
    v_name      TEXT;
    v_time      TEXT;
BEGIN
    -- ข้าม test check-in
    IF COALESCE(NEW.is_test, false) = true THEN
        RETURN NEW;
    END IF;

    SELECT u.username, u.name
        INTO v_username, v_name
        FROM users u
        WHERE u.id = NEW.user_id;

    v_time := to_char(now() AT TIME ZONE 'Asia/Bangkok', 'HH24:MI');

    payload := json_build_object(
        'id',              NEW.id,
        'user_id',         NEW.user_id,
        'username',        v_username,
        'name',            v_name,
        'type',            NEW.type,
        'distance_meters', NEW.distance_meters,
        'event_time',      v_time
    );
    PERFORM pg_notify('gps_checkin_event', payload::text);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS gps_checkins_notify_insert ON gps_checkins;
CREATE TRIGGER gps_checkins_notify_insert
    AFTER INSERT ON gps_checkins
    FOR EACH ROW
    EXECUTE FUNCTION notify_gps_checkin();


-- ============================================================
-- ERROR LOGS  (System Status → "บันทึกข้อผิดพลาด")
-- ============================================================
-- แจ้งเตือนทุก error ใหม่ที่ backend เขียนลงตาราง error_logs
--   (500 จาก Express handler / uncaughtException = fatal / unhandledRejection
--    — ดู backend/utils/errorLogger.js). volume ต่ำมากโดยปกติ (รูปในหน้าเพจ = 0/24ชม.)
-- ไม่เก็บ discord_message_id — error log เป็น log ถาวร ไม่มีการลบข้อความ (เหมือน check-in)
--
-- ⚠️ pg_notify จำกัด payload 8000 bytes — ตัด message/stack ให้สั้นใน trigger
--    และห่อด้วย EXCEPTION block: ถ้า notify ล้มเหลว (payload เกิน/อื่นๆ) ห้ามให้
--    INSERT error_logs rollback (error_logs คือ safety net ของระบบ logging ห้ามพัง)
-- error_logs ถูกสร้างโดย backend ตอน boot (ensureErrorLogsTable) — ใส่ CREATE IF NOT EXISTS
--    เผื่อรัน setup ก่อน backend boot (idempotent, schema ตรงกับ backend)

CREATE TABLE IF NOT EXISTS error_logs (
    id          SERIAL PRIMARY KEY,
    level       VARCHAR(10)  NOT NULL DEFAULT 'error',
    category    VARCHAR(40)  NOT NULL DEFAULT 'unknown',
    source      VARCHAR(40)  NOT NULL DEFAULT 'manual',
    error_code  VARCHAR(60),
    message     TEXT         NOT NULL,
    stack       TEXT,
    endpoint    VARCHAR(255),
    status_code INTEGER,
    user_id     VARCHAR(36),
    ip_address  VARCHAR(64),
    metadata    TEXT,
    created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE OR REPLACE FUNCTION notify_new_error_log()
RETURNS trigger AS $$
DECLARE
    v_name     TEXT;
    v_nick     TEXT;
    v_username TEXT;
BEGIN
    -- แจ้ง Discord เฉพาะระดับ error/fatal — level อื่น (warn/info) เก็บ log อย่างเดียว ไม่ notify
    -- (ตรงกับ migration 138 ฝั่ง Web_app_BMU_V2 — แก้ที่นั่นต้องแก้ที่นี่ให้ตรงกัน)
    IF NEW.level NOT IN ('error', 'fatal') THEN
        RETURN NEW;
    END IF;

    -- ห่อ pg_notify ด้วย sub-block: notify พังต้องไม่ทำให้ INSERT error_logs พัง
    BEGIN
        -- ดึงชื่อผู้ใช้ที่เจอ error (user_id มาจาก JWT ตอนยิง request — null ถ้าเป็น error ระดับระบบ)
        -- ใช้ id::text เทียบ เพราะ error_logs.user_id เป็น VARCHAR — กัน type mismatch
        -- ห่อ EXCEPTION ซ้อน: lookup พังก็ยังส่ง notify ต่อ (แค่ไม่มีชื่อ)
        IF NEW.user_id IS NOT NULL THEN
            BEGIN
                SELECT u.name, u.nick_name, u.username
                    INTO v_name, v_nick, v_username
                    FROM users u WHERE u.id::text = NEW.user_id;
            EXCEPTION WHEN OTHERS THEN
                NULL;
            END;
        END IF;

        PERFORM pg_notify('new_error_log', json_build_object(
            'id',          NEW.id,
            'level',       NEW.level,
            'category',    NEW.category,
            'source',      NEW.source,
            'error_code',  NEW.error_code,
            'message',     LEFT(NEW.message, 1500),
            'stack',       LEFT(NEW.stack, 600),
            'endpoint',    NEW.endpoint,
            'status_code', NEW.status_code,
            'user_id',     NEW.user_id,
            'user_name',   v_name,
            'user_nick',   v_nick,
            'username',    v_username,
            'created_at',  NEW.created_at
        )::text);
    EXCEPTION WHEN OTHERS THEN
        NULL; -- notify ล้มเหลว (เช่น payload > 8000 bytes) — ปล่อยผ่าน ไม่ให้ logging พัง
    END;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS error_logs_notify_insert ON error_logs;
CREATE TRIGGER error_logs_notify_insert
    AFTER INSERT ON error_logs
    FOR EACH ROW
    EXECUTE FUNCTION notify_new_error_log();


-- ============================================================
-- API ACCESS LOGS  (System Status → "การเรียก API ที่ error ตามพนักงาน")
-- ============================================================
-- แจ้งเตือนเมื่อ "พนักงานเรียก API แล้ว error" (4xx/5xx) — ดู backend/utils/apiAccessLogger.js
--   ตารางนี้เก็บเฉพาะ request ที่ auth แล้ว + status >= 400 + ตัด poller ออก, retention 7 วัน
-- payload เล็ก (ไม่มี stack) — แต่ INSERT เป็น "batch" (buffered ทุก 5 วิ สูงสุด 500 แถว/ครั้ง)
--   → ห่อ pg_notify ด้วย EXCEPTION: notify พังต้องไม่ทำให้ batch INSERT (log ทั้งชุด) rollback
-- volume สูงกว่า error_logs → bot กรองด้วย API_ERROR_MIN_STATUS (default 500) + dedup + rate cap
-- ไม่เก็บ message_id — เป็น log ถาวร ไม่มีการลบข้อความ
-- CREATE IF NOT EXISTS เผื่อรัน setup ก่อน backend boot (idempotent, schema ตรงกับ backend)

CREATE TABLE IF NOT EXISTS api_access_logs (
    id           SERIAL PRIMARY KEY,
    user_id      VARCHAR(36),
    employee_id  VARCHAR(36),
    user_name    VARCHAR(120),
    method       VARCHAR(10),
    endpoint     VARCHAR(255),
    status_code  INTEGER,
    response_ms  INTEGER,
    ip_address   VARCHAR(64),
    page_path    VARCHAR(255),
    created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE OR REPLACE FUNCTION notify_new_api_error()
RETURNS trigger AS $$
BEGIN
    BEGIN
        PERFORM pg_notify('new_api_error', json_build_object(
            'id',          NEW.id,
            'user_id',     NEW.user_id,
            'employee_id', NEW.employee_id,
            'user_name',   NEW.user_name,
            'method',      NEW.method,
            'endpoint',    NEW.endpoint,
            'status_code', NEW.status_code,
            'response_ms', NEW.response_ms,
            'ip_address',  NEW.ip_address,
            'page_path',   NEW.page_path,
            'created_at',  NEW.created_at
        )::text);
    EXCEPTION WHEN OTHERS THEN
        NULL; -- notify ล้มเหลว — ปล่อยผ่าน ห้ามทำให้ batch INSERT api_access_logs พัง
    END;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS api_access_logs_notify_insert ON api_access_logs;
CREATE TRIGGER api_access_logs_notify_insert
    AFTER INSERT ON api_access_logs
    FOR EACH ROW
    EXECUTE FUNCTION notify_new_api_error();

-- เสร็จ — ทดสอบโดย:
--   IT ticket: สร้าง ticket → เด้ง channel #1 / กด resolve → message หาย
--   Equipment: กดยืม → เด้ง channel #2 / admin approve/reject → message หาย
--   Check-in:  คนใน CHECKIN_USERNAMES เช็คอิน/เอาท์ → เด้ง channel #3
--               (คนอื่นไม่เด้ง — bot กรอง, test check-in ไม่เด้ง — trigger กรอง)
--   Error log: backend เกิด error (500/crash) → เด้ง channel #4
--               (npm run test:error เพื่อยิง fake error เข้า bot)
--   API error: พนักงานเรียก API แล้ว error 4xx/5xx → เด้ง channel #5
--               (npm run test:apierror — bot กรองตาม API_ERROR_MIN_STATUS, default 5xx)
