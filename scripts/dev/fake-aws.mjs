// In-memory stand-ins for @aws-sdk/client-s3, @aws-sdk/client-sesv2 and
// @aws-sdk/s3-request-presigner, used only by the local Lyrsoft dev API.
// Sent mail is kept in `sentMail` instead of going anywhere.
export const objects = new Map(); // key -> { body: Buffer, contentType }
export const sentMail = [];

class Command {
  constructor(input) {
    this.input = input;
  }
}
export class PutObjectCommand extends Command {}
export class GetObjectCommand extends Command {}
export class GetAccountCommand extends Command {}
export class GetEmailIdentityCommand extends Command {}
export class SendEmailCommand extends Command {}

export class S3Client {
  async send(command) {
    const { Key, Body, ContentType } = command.input;
    if (command instanceof PutObjectCommand) {
      objects.set(Key, { body: Buffer.from(Body), contentType: ContentType });
      return {};
    }
    if (command instanceof GetObjectCommand) {
      const object = objects.get(Key);
      if (!object) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
      return { Body: { transformToByteArray: async () => new Uint8Array(object.body) } };
    }
    throw new Error(`fake-aws: unsupported S3 command ${command.constructor.name}`);
  }
}

export class SESv2Client {
  async send(command) {
    if (command instanceof GetAccountCommand) return { ProductionAccessEnabled: false };
    if (command instanceof GetEmailIdentityCommand) return { VerifiedForSendingStatus: true, DkimAttributes: { Status: 'SUCCESS' } };
    if (command instanceof SendEmailCommand) {
      const MessageId = `dev-${Date.now().toString(36)}-${sentMail.length}`;
      sentMail.push({ MessageId, ...command.input, raw: Buffer.from(command.input.Content.Raw.Data).toString('utf8') });
      return { MessageId };
    }
    throw new Error(`fake-aws: unsupported SES command ${command.constructor.name}`);
  }
}

export async function getSignedUrl(_client, command) {
  return `http://localhost:${process.env.PORT || 8787}/__dev/s3/${encodeURIComponent(command.input.Key)}`;
}
