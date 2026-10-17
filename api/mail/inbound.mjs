// SES receipt rule -> this Lambda. SES has already stored the raw email at
// s3://<MAIL_BUCKET>/inbound/<messageId>; this parses it and files it into each matching mailbox.
// Mail for addresses with no mailbox (and no catch-all) is left in S3 only.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import PostalMime from 'postal-mime';
import { messageIds, newId, routeRecipient, safeFilename } from './model.mjs';
import { createMailStore } from './store.mjs';

const store = createMailStore({
  ddb: DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }),
  s3: new S3Client({}),
  table: process.env.TABLE_NAME,
  bucket: process.env.MAIL_BUCKET,
});

const MAX_ATTACHMENTS = 20;
const verdict = (v) => v?.status || null;
const addresses = (list) => (list || []).flatMap((a) => (a.group ? addresses(a.group) : a.address ? [a.address.toLowerCase()] : []));

export async function processInbound(sesRecord) {
  const { mail, receipt } = sesRecord;
  if (verdict(receipt.virusVerdict) === 'FAIL') {
    console.warn('dropping message with a virus verdict', mail.messageId);
    return { stored: 0 };
  }

  const mailboxes = await store.listMailboxes();
  const targets = new Map();
  for (const recipient of receipt.recipients) {
    const mailbox = routeRecipient(recipient, mailboxes);
    if (mailbox) targets.set(mailbox.address, mailbox);
  }
  if (!targets.size) {
    console.log('no mailbox for', receipt.recipients.join(', '));
    return { stored: 0 };
  }

  const rawKey = `inbound/${mail.messageId}`;
  const parsed = await PostalMime.parse(await store.readObject(rawKey));

  // Attachments are stored once and shared by every mailbox the message lands in.
  const messageKey = newId();
  const attachments = [];
  for (const [index, attachment] of (parsed.attachments || []).slice(0, MAX_ATTACHMENTS).entries()) {
    if (attachment.disposition === 'inline' && attachment.related) continue; // inline images in HTML
    const filename = safeFilename(attachment.filename);
    const key = `attachments/${messageKey}/${index}/${filename}`;
    const body = Buffer.from(attachment.content);
    await store.putObject(key, body, attachment.mimeType || 'application/octet-stream');
    attachments.push({ filename, contentType: attachment.mimeType || 'application/octet-stream', size: body.length, key });
  }

  const spam = verdict(receipt.spamVerdict) === 'FAIL' || verdict(receipt.dmarcVerdict) === 'FAIL';
  const from = parsed.from?.address
    ? { name: parsed.from.name || '', address: parsed.from.address.toLowerCase() }
    : { name: '', address: mail.source.toLowerCase() };

  let stored = 0;
  for (const address of targets.keys()) {
    if (!(await store.claimInbound(mail.messageId, address))) continue; // already processed
    await store.saveMessage(
      address,
      {
        direction: 'in',
        from,
        to: addresses(parsed.to),
        cc: addresses(parsed.cc),
        replyTo: addresses(parsed.replyTo),
        subject: parsed.subject || '(no subject)',
        text: parsed.text || '',
        html: parsed.html || null,
        headerMessageId: parsed.messageId || null,
        referenceIds: [...messageIds(parsed.references), ...messageIds(parsed.inReplyTo)],
        attachments,
        rawKey,
        verdicts: {
          spam: verdict(receipt.spamVerdict),
          virus: verdict(receipt.virusVerdict),
          spf: verdict(receipt.spfVerdict),
          dkim: verdict(receipt.dkimVerdict),
          dmarc: verdict(receipt.dmarcVerdict),
        },
        createdAt: new Date(mail.timestamp || Date.now()).toISOString(),
      },
      { newThreadStatus: spam ? 'spam' : 'open' },
    );
    await store.touchMailbox(address, 'lastReceivedAt');
    stored += 1;
  }
  return { stored };
}

export const handler = async (event) => {
  for (const record of event.Records || []) {
    if (record.eventSource === 'aws:ses') await processInbound(record.ses);
  }
};
