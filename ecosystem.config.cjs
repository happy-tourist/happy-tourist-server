/**
 * PM2 ecosystem config для happy-tourist-server.
 * Рассчитан на сервер с 1 ГБ ОЗУ.
 */

module.exports = {
  apps: [
    {
      name: "happy-tourist-server",
      script: "build/index.js",
      cwd: "/var/www/happy-tourist-server",
      time: true,
      watch: false,

      // 1 воркер — cluster на 1 ГБ ОЗУ не имеет смысла
      instances: 1,
      exec_mode: "fork",

      // Ждём, пока listen() отправит process.send("ready")
      wait_ready: true,
      listen_timeout: 10000,
      kill_timeout: 5000,

      // Мягкий лимит RSS: PM2 перезапустит процесс при превышении
      max_memory_restart: "500M",

      // Жёсткий лимит heap V8
      node_args: "--max-old-space-size=350",

      env: {
        NODE_ENV: "production",
        PORT: 2567,
        NODE_OPTIONS: "--max-old-space-size=350",
      },

      error_file: "/var/log/happy-tourist-server/error.log",
      out_file: "/var/log/happy-tourist-server/out.log",
      merge_logs: true,
    },
  ],
};
