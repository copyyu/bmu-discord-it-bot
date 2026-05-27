-- ============================================================
-- Discord Bot — DB Trigger Setup
-- ============================================================
-- รัน script นี้ครั้งเดียวบน production database
-- จะติดตั้ง:
--   1) คอลัมน์ discord_message_id (เก็บ id ของ Discord message ที่ส่งไป)
--   2) Trigger INSERT → NOTIFY 'new_it_ticket' (ส่งแจ้งเตือนเข้า Discord)
--   3) Trigger UPDATE → NOTIFY 'it_ticket_resolved' (ลบ message เมื่อ ticket เสร็จ)
--
-- รันซ้ำได้ปลอดภัย (idempotent)
--
-- วิธีรัน:
--   cd discord-bot
--   npm run install-trigger
-- ============================================================

-- 1) เพิ่มคอลัมน์เก็บ Discord message id (รันซ้ำได้)
ALTER TABLE it_tickets ADD COLUMN IF NOT EXISTS discord_message_id VARCHAR(64);

-- ============================================================
-- 2) INSERT trigger — NOTIFY ตอนสร้าง ticket ใหม่
-- ============================================================
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

-- ============================================================
-- 3) UPDATE trigger — NOTIFY ตอน status เปลี่ยนเป็น resolved/closed
-- ============================================================
CREATE OR REPLACE FUNCTION notify_ticket_resolved()
RETURNS trigger AS $$
DECLARE
    payload json;
BEGIN
    -- ทำงานเฉพาะตอน status เปลี่ยนเป็น resolved หรือ closed
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

-- เสร็จ — ทดสอบโดย:
--   1. สร้าง ticket ใหม่ → ดูว่า Discord เด้งมั้ย
--   2. กด resolve/close ticket → ดูว่า message ใน Discord หายมั้ย
