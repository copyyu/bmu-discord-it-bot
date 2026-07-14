/**
 * PM2 ecosystem config for BMU Discord IT Bot
 *
 * ⚠️ Bot ต้องรันที่เดียวเท่านั้น — production ตัวจริงอยู่บน Render
 *   ห้ามรันตัว local ค้างไว้พร้อมกัน: ทุก instance ที่ LISTEN DB เดียวกัน
 *   จะส่งข้อความ Discord ซ้ำกันทุก event (ดู POSTMORTEM-2026-07-14)
 *   ใช้ config นี้เฉพาะกรณีย้าย production มารันในเครื่อง (README Option D)
 *
 * Usage:
 *   pm2 start pm2.config.cjs
 *   pm2 save           # บันทึก process list
 *   pm2 logs           # ดู log
 *   pm2 status         # เช็คสถานะ
 *   pm2 restart bmu-discord-bot
 *   pm2 stop bmu-discord-bot
 *   pm2 delete bmu-discord-bot && pm2 save --force   # เลิกใช้ local (ต้อง --force ตอน list ว่าง)
 */

module.exports = {
    apps: [
        {
            name: 'bmu-discord-bot',
            script: './index.js',
            node_args: '--env-file=.env',
            cwd: __dirname,
            instances: 1,
            // fork เท่านั้น — cluster mode ทำให้ node หา --env-file=.env ไม่เจอ (คนละ cwd)
            // แล้ว crash-loop เงียบๆ ทุก 5 วิ (exit code 9) — เจอมาแล้ว 14 ก.ค. 2026
            exec_mode: 'fork',
            autorestart: true,
            watch: false,
            max_restarts: 10,
            restart_delay: 5000,
            max_memory_restart: '200M',
            env: {
                NODE_ENV: 'production',
            },
            error_file: './logs/error.log',
            out_file: './logs/out.log',
            time: true,
        },
    ],
}
