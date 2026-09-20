import { describe, expect, it, jest } from '@jest/globals';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { NodemailerEmailSender } from '../../../../../src/auth/embedded-as/methods/nodemailerEmailSender.js';
import { classifyEmailSubmissionFailure } from '../../../../../src/auth/embedded-as/methods/TransactionalEmailSender.js';

const message = () => ({
  to: 'Person@example.test', subject: 'Your DollhouseMCP beta invitation',
  text: 'Accept invitation: https://beta.example.test/auth/onboarding/invitation#token=SECRET',
  html: '<p>Your invitation expires in 24 hours.</p>',
});
function fixture() {
  const sender = new NodemailerEmailSender({
    host: 'smtp.example.test', port: 587, user: 'test', password: 'unused', from: 'beta@example.test',
  });
  const transport = (sender as unknown as { transporter: { sendMail(message: unknown): Promise<unknown> } }).transporter;
  const sendMail = jest.fn<(input: unknown) => Promise<unknown>>().mockResolvedValue({
    accepted: ['Person@example.test'], rejected: [], messageId: '<local-id@example.test>',
    response: '250 opaque-provider-response-with-private-data',
  });
  transport.sendMail = sendMail;
  return { sender, sendMail };
}

describe('transactional SMTP submission', () => {
  it('sends multipart content once to one structured recipient without magic-link lifetime copy', async () => {
    const { sender, sendMail } = fixture();
    const input = { ...message(), attachments: [{ path: '/private/file' }], headers: { 'X-Secret': 'SECRET' } };
    expect(await sender.sendTransactionalEmail(input)).toEqual({ state: 'submitted', providerMessageId: null });
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledWith({
      from: 'beta@example.test', to: { name: '', address: input.to },
      subject: input.subject, text: input.text, html: input.html,
      disableFileAccess: true, disableUrlAccess: true,
    });
    expect(JSON.stringify(sendMail.mock.calls)).not.toContain('15 minutes');
  });

  it.each([
    'person@example.test,other@example.test', 'Person <person@example.test>',
    'person@example.test\r\nBcc: other@example.test', 'person@example.test\n', 'bad@-example.test',
  ])('rejects unsafe single-recipient input before contacting SMTP: %j', async to => {
    const { sender, sendMail } = fixture();
    await expect(sender.sendTransactionalEmail({ ...message(), to })).rejects.toThrow('Invalid transactional email recipient');
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('normalizes Unicode and surrounding spaces without changing local-part case', async () => {
    const { sender, sendMail } = fixture();
    await sender.sendTransactionalEmail({ ...message(), to: '  Jose\u0301@example.test  ' });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: { name: '', address: 'José@example.test' } }));
  });

  it('checks the octet limit of the case-preserved mailbox actually sent', async () => {
    const { sender, sendMail } = fixture();
    // Capital sharp S occupies three UTF-8 bytes; its lowercase occupies two.
    await expect(sender.sendTransactionalEmail({ ...message(), to: `${'ẞ'.repeat(32)}@example.test` }))
      .rejects.toThrow('Invalid transactional email recipient');
    expect(sendMail).not.toHaveBeenCalled();
    const to = `${'ẞ'.repeat(21)}x@example.test`; // Exactly 64 bytes before @.
    await sender.sendTransactionalEmail({ ...message(), to });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: { name: '', address: to } }));
  });

  it('rejects Unicode domains whose SMTP encoding exceeds label or mailbox limits', async () => {
    const { sender, sendMail } = fixture();
    const longLabel = `${'a'.repeat(59)}é`;
    const longMailbox = `${'P'.repeat(64)}@${Array(3).fill(`${'a'.repeat(55)}é`).join('.')}`;
    for (const to of [`Person@${longLabel}.test`, longMailbox]) {
      // Exercise the installed SMTP serializer, not merely a mocked transport.
      const wireAddress = new MailComposer({ to: { name: '', address: to } }).compile().getEnvelope().to[0];
      expect(Buffer.byteLength(wireAddress) > 254 || wireAddress.split('@')[1].split('.').some(label => label.length > 63))
        .toBe(true);
      await expect(sender.sendTransactionalEmail({ ...message(), to }))
        .rejects.toThrow('Invalid transactional email recipient');
    }
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('accepts an exact-boundary local part even when identity lowercasing expands it', async () => {
    const { sender, sendMail } = fixture();
    const to = `${'İ'.repeat(32)}@example.test`; // 64 bytes; lowercasing would produce 96.
    await sender.sendTransactionalEmail({ ...message(), to });
    const submitted = sendMail.mock.calls[0][0] as { to: { name: string; address: string } };
    expect(new MailComposer(submitted).compile().getEnvelope().to).toEqual([to]);
  });

  it('submits the validated ASCII domain while preserving local-part case', async () => {
    const { sender, sendMail } = fixture();
    await sender.sendTransactionalEmail({ ...message(), to: 'Person@café.test' });
    const submitted = sendMail.mock.calls[0][0] as { to: { name: string; address: string } };
    expect(submitted.to.address).toBe('Person@xn--caf-dma.test');
    expect(new MailComposer(submitted).compile().getEnvelope().to).toEqual(['Person@xn--caf-dma.test']);
  });

  it.each([
    { subject: 'Subject\r\nBcc: someone@example.test' }, { subject: 'x'.repeat(201) },
    { subject: 'hidden\u202esubject' }, { subject: '' }, { text: '' }, { html: 'x'.repeat(65_537) },
    { html: { path: '/private/file' } },
  ])('rejects invalid or non-string content without sending', async invalid => {
    const { sender, sendMail } = fixture();
    await expect(sender.sendTransactionalEmail({ ...message(), ...invalid } as ReturnType<typeof message>))
      .rejects.toThrow('Invalid transactional email');
    expect(sendMail).not.toHaveBeenCalled();
  });

  it.each([
    { accepted: [], rejected: ['private@example.test'] },
    { accepted: ['one@example.test', 'two@example.test'], rejected: [] },
    {}, undefined,
  ])('does not report acceptance from incomplete/contradictory transport results', async result => {
    const { sender, sendMail } = fixture();
    sendMail.mockResolvedValue(result);
    expect(await sender.sendTransactionalEmail(message())).toEqual({ state: 'unknown', failureClass: 'indeterminate' });
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it('returns only sanitized uncertainty after a DATA timeout and never retries', async () => {
    const { sender, sendMail } = fixture();
    sendMail.mockRejectedValue(Object.assign(new Error('SECRET API_KEY recipient@example.test'), {
      code: 'ETIMEDOUT', command: 'DATA', response: 'SECRET', cause: new Error('API_KEY'),
    }));
    expect(await sender.sendTransactionalEmail(message())).toEqual({ state: 'unknown', failureClass: 'indeterminate' });
    expect(sendMail).toHaveBeenCalledTimes(1);
  });
});

describe('SMTP failure classification', () => {
  it.each([
    ['EAUTH', 'authentication'], ['EDNS', 'connection'],
    ['ETLS', 'tls'], ['EENVELOPE', 'rejected'],
  ])('classifies known pre-acceptance %s safely', (code, failureClass) => {
    expect(classifyEmailSubmissionFailure({ code, message: 'SECRET' })).toEqual({ state: 'failed', failureClass });
  });
  it.each(['MAIL FROM', 'RCPT TO', 'DATA'])('recognizes an explicit SMTP rejection during %s', command => {
    expect(classifyEmailSubmissionFailure({ code: 'EMESSAGE', command, responseCode: 550 }))
      .toEqual({ state: 'failed', failureClass: 'rejected' });
  });
  it.each([
    null, 'SECRET', { code: 'ESOCKET' }, { code: 'ETIMEDOUT' },
    { code: 'ECONNECTION', command: 'DATA' }, { code: 'ECONNECTION', command: 'CONN' },
    { code: 'ECONNECTION' },
    { command: 'DATA', responseCode: 250 }, { command: 'QUIT', responseCode: 550 },
  ])('preserves uncertainty for unproven outcomes', error => {
    expect(classifyEmailSubmissionFailure(error)).toEqual({ state: 'unknown', failureClass: 'indeterminate' });
  });
});
