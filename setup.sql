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

-- เสร็จ — ทดสอบโดย:
--   IT ticket: สร้าง ticket → เด้ง channel #1 / กด resolve → message หาย
--   Equipment: กดยืม → เด้ง channel #2 / admin approve/reject → message หาย
--   Check-in:  คนใน CHECKIN_USERNAMES เช็คอิน/เอาท์ → เด้ง channel #3
--               (คนอื่นไม่เด้ง — bot กรอง, test check-in ไม่เด้ง — trigger กรอง)
