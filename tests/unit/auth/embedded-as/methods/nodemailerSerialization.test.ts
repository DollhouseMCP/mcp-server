import { describe, expect, it, jest } from '@jest/globals';
import nodemailer from 'nodemailer';
import type StreamTransport from 'nodemailer/lib/stream-transport/index.js';
import { NodemailerEmailSender } from '../../../../../src/auth/embedded-as/methods/nodemailerEmailSender.js';

describe('transactional email with real Nodemailer serialization', () => {
  it('keeps one normalized recipient and multipart bodies without claiming SMTP acceptance', async () => {
    const sender = new NodemailerEmailSender({
      host: 'smtp.example.com', port: 587, user: 'fixture', password: 'fixture',
      from: 'Sender@ｅxample.com',
    });
    // Stream transport runs the actual address parser/MIME compiler entirely in
    // memory: no socket, provider, or delivered message. Only transport changes.
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
    const serialize = jest.spyOn(transport, 'sendMail');
    Object.defineProperty(sender, 'transporter', { value: transport });
    try {
      await expect(sender.sendTransactionalEmail({
        to: 'Invitee@ｅxample.com', subject: 'Your DollhouseMCP private-beta invitation',
        text: 'A GitHub account is required. No Dollhouse password.',
        html: '<p>A GitHub account is required. No Dollhouse password.</p>',
      })).resolves.toEqual({ state: 'unknown', failureClass: 'indeterminate' });
      const serialized = await serialize.mock.results[0].value as StreamTransport.SentMessageInfo;
      expect(serialized.envelope).toEqual({ from: 'Sender@example.com', to: ['Invitee@example.com'] });
      const message = serialized.message.toString();
      expect(message).toContain('To: Invitee@example.com');
      expect(message).toContain('From: Sender@example.com');
      expect(message).toContain('Content-Type: multipart/alternative;');
      expect(message).toContain('Content-Type: text/plain; charset=utf-8');
      expect(message).toContain('Content-Type: text/html; charset=utf-8');
      expect(message).toContain('No Dollhouse password.');

      for (const to of ['user@example.com(x)evil.com', 'user@example.com,other@example.com']) {
        await expect(sender.sendTransactionalEmail({ to, subject: 'Invitation', text: 'Body', html: '<p>Body</p>' }))
          .rejects.toThrow('Invalid transactional email recipient');
      }
      expect(serialize).toHaveBeenCalledTimes(1);
    } finally {
      serialize.mockRestore();
      transport.close();
    }
  });
});
