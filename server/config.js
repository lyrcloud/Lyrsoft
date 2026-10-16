const env = process.env;
const port = Number(env.PORT) || 3000;

export const config = {
  port,
  baseUrl: (env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  production: env.NODE_ENV === 'production',
  dbPath: env.DB_PATH || 'data/lyrsoft.db',
  superAdminEmail: (env.SUPER_ADMIN_EMAIL || 'lyrclouds@gmail.com').trim().toLowerCase(),
  sessionDays: 14,
  mail: {
    transport: env.MAIL_TRANSPORT || 'log',
    from: env.MAIL_FROM || 'Lyrsoft <no-reply@lyrsoft.com>',
    outboxDir: env.MAIL_OUTBOX_DIR || 'data/outbox',
    maxAttempts: Number(env.MAIL_MAX_ATTEMPTS) || 5,
    pollMs: Number(env.MAIL_POLL_MS) || 5000,
    smtp: {
      host: env.SMTP_HOST || '',
      port: Number(env.SMTP_PORT) || 465,
      secure: (env.SMTP_SECURE ?? 'true') !== 'false',
      user: env.SMTP_USER || '',
      pass: (env.SMTP_PASS || '').replace(/\s/g, ''),
    },
  },
};
