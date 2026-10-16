import fs from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { config } from '../config.js';

// "smtp" delivers for real (Gmail, Amazon SES SMTP, Postmark, ...).
// "log" renders the full MIME message and writes it to the outbox folder, so development never emails anyone.
export function createTransport(mailConfig = config.mail) {
  if (mailConfig.transport === 'smtp') {
    const { host, port, secure, user, pass } = mailConfig.smtp;
    if (!host) throw new Error('MAIL_TRANSPORT=smtp needs SMTP_HOST');
    const smtp = nodemailer.createTransport({ host, port, secure, auth: user ? { user, pass } : undefined });
    return {
      name: `smtp (${host})`,
      send: async (msg) => {
        const info = await smtp.sendMail(msg);
        return info.messageId;
      },
    };
  }

  const stream = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  return {
    name: `log (${mailConfig.outboxDir})`,
    send: async (msg) => {
      const info = await stream.sendMail(msg);
      fs.mkdirSync(mailConfig.outboxDir, { recursive: true });
      const file = path.join(mailConfig.outboxDir, `${Date.now()}-${msg.headers['X-Lyrsoft-Message']}.eml`);
      fs.writeFileSync(file, info.message);
      return info.messageId;
    },
  };
}
