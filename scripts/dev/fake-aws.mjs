// In-memory stand-ins for @aws-sdk/client-s3, @aws-sdk/client-sesv2, @aws-sdk/client-sns,
// @aws-sdk/client-cognito-identity-provider and @aws-sdk/s3-request-presigner, used only by the
// local Lyrsoft dev API. Sent mail and texts are kept in `sentMail` and `sentSms` instead of going anywhere.
export const objects = new Map(); // key -> { body: Buffer, contentType }
export const sentMail = [];
export const sentSms = [];

class Command {
  constructor(input) {
    this.input = input;
  }
}
export class PutObjectCommand extends Command {}
export class GetObjectCommand extends Command {}
export class DeleteObjectCommand extends Command {}
export class GetAccountCommand extends Command {}
export class GetEmailIdentityCommand extends Command {}
export class SendEmailCommand extends Command {}
export class PublishCommand extends Command {}
export class AdminGetUserCommand extends Command {}
export class CreateMeetingCommand extends Command {}
export class GetMeetingCommand extends Command {}
export class DeleteMeetingCommand extends Command {}
export class CreateAttendeeCommand extends Command {}

// Meetings are only pretend locally: the app gets ids, but no media servers to connect to.
const meetings = new Map();
export class ChimeSDKMeetingsClient {
  async send(command) {
    const { input } = command;
    if (command instanceof CreateMeetingCommand) {
      const MeetingId = `dev-meeting-${meetings.size + 1}`;
      const Meeting = { MeetingId, ExternalMeetingId: input.ExternalMeetingId, MediaRegion: input.MediaRegion, MediaPlacement: { AudioHostUrl: 'dev', SignalingUrl: 'wss://dev.invalid' } };
      meetings.set(MeetingId, Meeting);
      return { Meeting };
    }
    if (command instanceof GetMeetingCommand) {
      if (!meetings.has(input.MeetingId)) throw Object.assign(new Error('not found'), { name: 'NotFoundException' });
      return { Meeting: meetings.get(input.MeetingId) };
    }
    if (command instanceof DeleteMeetingCommand) return meetings.delete(input.MeetingId), {};
    if (command instanceof CreateAttendeeCommand) return { Attendee: { AttendeeId: `dev-att-${Date.now()}`, ExternalUserId: input.ExternalUserId, JoinToken: 'dev' } };
    throw new Error(`fake-aws: unsupported Chime command ${command.constructor.name}`);
  }
}

export class SNSClient {
  async send(command) {
    sentSms.push({ to: command.input.PhoneNumber, message: command.input.Message, at: new Date().toISOString() });
    console.log(`[dev SMS to ${command.input.PhoneNumber}] ${command.input.Message}`);
    return { MessageId: `dev-sms-${sentSms.length}` };
  }
}

// Dev sign-ins all go through the fake userInfo endpoint, so AdminGetUser is never needed.
export class CognitoIdentityProviderClient {
  async send() {
    throw Object.assign(new Error('fake-aws: no Cognito locally'), { name: 'UserNotFoundException' });
  }
}

export class S3Client {
  async send(command) {
    const { Key, Body, ContentType } = command.input;
    if (command instanceof PutObjectCommand) {
      objects.set(Key, { body: Buffer.from(Body), contentType: ContentType });
      return {};
    }
    if (command instanceof DeleteObjectCommand) {
      objects.delete(Key);
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
