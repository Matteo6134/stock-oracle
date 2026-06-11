module.exports = {
  apps: [
    {
      name: 'stock-oracle',
      script: 'server/index.js',
      cwd: 'C:/Users/pc2/Desktop/binance-bot',
      node_args: '--expose-gc',
      env: { NODE_ENV: 'production' },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      watch: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: 'C:/Users/pc2/Desktop/binance-bot/logs/error.log',
      out_file: 'C:/Users/pc2/Desktop/binance-bot/logs/out.log',
      merge_logs: true,
      max_memory_restart: '500M',
    },
    // alpaca-gold-bot removed 2026-06-11 — retired (folder still at
    // C:/Users/pc2/Desktop/gold if it ever needs to come back)
  ],
};
