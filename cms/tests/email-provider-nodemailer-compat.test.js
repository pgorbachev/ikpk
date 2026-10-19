import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const nodemailer = require('nodemailer');
const emailProvider = require('@strapi/provider-email-sendmail');

test('Strapi sendmail provider preserves normal mail fields without opening a network connection', async () => {
  const originalCreateTransport = nodemailer.createTransport;
  let transportOptions;
  let deliveredMessage;
  let closeCalled = false;

  nodemailer.createTransport = (options) => {
    transportOptions = options;
    return {
      async sendMail(message) {
        deliveredMessage = message;
        return { messageId: 'synthetic-message@example.invalid' };
      },
      close() {
        closeCalled = true;
      },
    };
  };

  try {
    const provider = emailProvider.init(
      { devHost: 'fake.smtp.invalid', devPort: 2525 },
      {
        defaultFrom: 'IKPK Site <no-reply@example.invalid>',
        defaultReplyTo: 'support@example.invalid',
      }
    );

    await provider.send({
      to: 'Reader <reader@example.invalid>',
      cc: 'Editor <editor@example.invalid>',
      bcc: 'Archive <archive@example.invalid>',
      subject: 'Synthetic CMS compatibility check',
      text: 'Plain-text body',
      html: '<p>HTML body</p>',
    });
  } finally {
    nodemailer.createTransport = originalCreateTransport;
  }

  assert.equal(transportOptions.host, 'fake.smtp.invalid');
  assert.equal(transportOptions.port, 2525);
  assert.equal(deliveredMessage.from, 'IKPK Site <no-reply@example.invalid>');
  assert.equal(deliveredMessage.replyTo, 'support@example.invalid');
  assert.equal(deliveredMessage.to, 'Reader <reader@example.invalid>');
  assert.equal(deliveredMessage.cc, 'Editor <editor@example.invalid>');
  assert.equal(deliveredMessage.bcc, 'Archive <archive@example.invalid>');
  assert.equal(deliveredMessage.subject, 'Synthetic CMS compatibility check');
  assert.equal(deliveredMessage.text, 'Plain-text body');
  assert.equal(deliveredMessage.html, '<p>HTML body</p>');
  assert.deepEqual(deliveredMessage.envelope, {
    from: 'no-reply@example.invalid',
    to: ['reader@example.invalid', 'editor@example.invalid', 'archive@example.invalid'],
  });
  assert.equal(closeCalled, true);
});
