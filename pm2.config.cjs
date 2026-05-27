/**
 * PM2 ecosystem config for BMU Discord IT Bot
 *
 * Usage:
 *   pm2 start pm2.config.cjs
 *   pm2 save           # บันทึก process list
 *   pm2 logs           # ดู log
 *   pm2 status         # เช็คสถานะ
 *   pm2 restart bmu-discord-bot
 *   pm2 stop bmu-discord-bot
 *   pm2 delete bmu-discord-bot
 */

module.exports = {
    apps: [
        {
            name: 'bmu-discord-bot',
            script: './index.js',
            node_args: '--env-file=.env',
            cwd: __dirname,
            instances: 1,
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
