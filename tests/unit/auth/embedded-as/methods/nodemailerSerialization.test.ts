import { describe, expect, it, jest } from '@jest/globals';
import nodemailer from 'nodemailer';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
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

      // Published upstream parser advisories remain in 9.1.1. Prove the
      // invitation boundary rejects their input classes before serialization.
      const nestedRecipient = Array.from({ length: 100 }, () => 0)
        .reduce<unknown>(value => [value], 'user@example.com');
      for (const to of [
        'user@example.com(x)evil.com', 'user@example.com,other@example.com',
        '"user"@example.com(x)evil.com', 'a' + '@b(c)'.repeat(100),
        '[x]'.repeat(100) + '@', nestedRecipient as string,
      ]) {
        await expect(sender.sendTransactionalEmail({ to, subject: 'Invitation', text: 'Body', html: '<p>Body</p>' }))
          .rejects.toThrow('Invalid transactional email recipient');
      }
      expect(serialize).toHaveBeenCalledTimes(1);
    } finally {
      serialize.mockRestore();
      transport.close();
    }
  });

  it.each([
    ['file', { path: '/nonexistent/nodemailer-sandbox-fixture' }, /File access rejected/],
    ['URL', { href: 'https://nodemailer-sandbox.invalid/fixture' }, /Url access rejected/],
  ] as const)('keeps the message sandbox in legacy %s content resolution', async (_kind, content, rejection) => {
    // Exercise the actual API fixed in 9.1.1. Tripwires make even a regressed
    // dependency incapable of reading a file or opening a network connection.
    const file = jest.spyOn(fs, 'createReadStream').mockImplementation(() => { throw new Error('file tripwire'); });
    const plain = jest.spyOn(http, 'request').mockImplementation(() => { throw new Error('HTTP tripwire'); });
    const secure = jest.spyOn(https, 'request').mockImplementation(() => { throw new Error('HTTPS tripwire'); });
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
    transport.use('compile', (mail, done) => {
      mail.resolveContent({ text: content }, 'text', error => {
        done(error ?? new Error('Sandbox unexpectedly allowed content resolution'));
      });
    });
    try {
      await expect(transport.sendMail({
        from: 'sender@example.test', to: 'recipient@example.test', text: 'Inline fixture',
        disableFileAccess: true, disableUrlAccess: true,
      })).rejects.toThrow(rejection);
      expect(file).not.toHaveBeenCalled();
      expect(plain).not.toHaveBeenCalled();
      expect(secure).not.toHaveBeenCalled();
    } finally {
      transport.close();
      file.mockRestore(); plain.mockRestore(); secure.mockRestore();
    }
  });
});
