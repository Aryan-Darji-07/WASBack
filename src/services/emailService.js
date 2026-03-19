// ─── Transporter ──────────────────────────────────────────────────────────────
// FIX: Do NOT cache at module level as `null`.
// The old code set `let transporter = null` and returned early if truthy — but
// null is falsy so the factory ran every time, yet a *failed* verify left a
// broken transporter instance that passed the truthy check on the next call.
// Now we cache only a *verified-good* transporter, or re-create on every call
// if the previous one never verified.

let _transporter = null;        // undefined = never tried; null = failed; object = ready
let _transporterVerified = false;

function getTransporter() {
  // Return already-verified instance immediately
  if (_transporter && _transporterVerified) return _transporter;

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.warn('[Email] Missing SMTP env vars (SMTP_HOST / SMTP_USER / SMTP_PASS). Emails will not be sent.');
    return null;
  }

  try {
    const nodemailer = require('nodemailer');
    const t = nodemailer.createTransport({
      host:   SMTP_HOST,
      port:   parseInt(SMTP_PORT) || 587,
      secure: parseInt(SMTP_PORT) === 465,
      auth:   { user: SMTP_USER, pass: SMTP_PASS },
      // Increase timeouts so slow SMTP servers don't silently drop
      connectionTimeout: 10000,
      greetingTimeout:   10000,
      socketTimeout:     15000,
    });

    // Verify asynchronously — mark as verified only on success,
    // reset on failure so the next call retries creation.
    t.verify((error) => {
      if (error) {
        console.error('[Email] SMTP verification failed:', error.message);
        _transporter = null;
        _transporterVerified = false;
      } else {
        console.log('[Email] SMTP transporter verified — ready to send');
        _transporterVerified = true;
      }
    });

    // Store the *unverified* transporter so we can still attempt sends
    // (verify is informational; the transport itself may still work).
    _transporter = t;
    return _transporter;
  } catch (err) {
    console.error('[Email] Failed to create transporter:', err.message);
    _transporter = null;
    _transporterVerified = false;
    return null;
  }
}

// ─── Reset helper (useful after env-var changes or test mocking) ──────────────
function resetTransporter() {
  _transporter = null;
  _transporterVerified = false;
}

// ─── Shared brand tokens ──────────────────────────────────────────────────────
const BRAND = {
  green:      '#25d366',
  greenDark:  '#128c7e',
  dark:       '#1a202c',
  cardBg:     '#ffffff',
  pageBg:     '#f0f4f8',
  border:     '#e2e8f0',
  textMain:   '#1a202c',
  textMuted:  '#64748b',
  textLight:  '#94a3b8',
  danger:     '#dc2626',
  dangerBg:   '#fef2f2',
  dangerBdr:  '#fecaca',
  warning:    '#d97706',
  warningBg:  '#fffbeb',
  warningBdr: '#fde68a',
  success:    '#16a34a',
  successBg:  '#f0fdf4',
  successBdr: '#bbf7d0',
  infoBg:     '#eff6ff',
  infoBdr:    '#bfdbfe',
  infoText:   '#1d4ed8',
  appName:    process.env.APP_NAME || 'WA Scheduler',
  appUrl:     process.env.CLIENT_URL || 'http://localhost:5173',
};

// ─── "From" address helper ────────────────────────────────────────────────────
// FIX: Many SMTP providers (Gmail, SendGrid, etc.) require the From header to
// be either a plain address OR "Display Name <address>".  Using a raw SMTP_USER
// that contains spaces without angle-brackets causes some servers to reject mail.
function getFromAddress() {
  const addr = process.env.SMTP_FROM || process.env.SMTP_USER || '';
  // If SMTP_FROM already has angle brackets or is empty, use as-is.
  if (!addr || addr.includes('<')) return addr;
  // Otherwise wrap with a friendly display name.
  return `"${BRAND.appName}" <${addr}>`;
}

// ─── Master HTML wrapper ──────────────────────────────────────────────────────
function emailShell({ subject, headerBg, headerIcon, headerTitle, headerSubtitle, bodyHtml, footerNote }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <meta name="color-scheme" content="light"/>
  <title>${subject}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.pageBg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:${BRAND.pageBg};padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:560px;">

        <!-- ── HEADER ─────────────────────────────────────────────────────── -->
        <tr><td style="background:${headerBg || BRAND.greenDark};border-radius:16px 16px 0 0;padding:28px 32px 24px;">
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
            <tr>
              <td style="vertical-align:middle;">
                <table cellpadding="0" cellspacing="0" role="presentation">
                  <tr>
                    <td style="background:rgba(255,255,255,0.15);border-radius:10px;padding:8px 10px;vertical-align:middle;">
                      <span style="font-size:20px;line-height:1;">${headerIcon || '💬'}</span>
                    </td>
                    <td style="padding-left:10px;vertical-align:middle;">
                      <p style="margin:0;color:#fff;font-size:16px;font-weight:700;letter-spacing:-0.3px;">${BRAND.appName}</p>
                      <p style="margin:0;color:rgba(255,255,255,0.65);font-size:11px;">Automated Notification</p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr><td style="padding-top:20px;">
              <h1 style="margin:0;color:#fff;font-size:22px;font-weight:800;letter-spacing:-0.5px;line-height:1.2;">${headerTitle}</h1>
              ${headerSubtitle ? `<p style="margin:8px 0 0;color:rgba(255,255,255,0.75);font-size:14px;line-height:1.5;">${headerSubtitle}</p>` : ''}
            </td></tr>
          </table>
        </td></tr>

        <!-- ── BODY ──────────────────────────────────────────────────────── -->
        <tr><td style="background:${BRAND.cardBg};padding:32px;border-left:1px solid ${BRAND.border};border-right:1px solid ${BRAND.border};">
          ${bodyHtml}
        </td></tr>

        <!-- ── FOOTER ─────────────────────────────────────────────────────── -->
        <tr><td style="background:#f8fafc;border:1px solid ${BRAND.border};border-top:none;border-radius:0 0 16px 16px;padding:20px 32px;">
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
            <tr>
              <td>
                <p style="margin:0;font-size:12px;color:${BRAND.textLight};line-height:1.6;">
                  ${footerNote || 'This is an automated message from <strong>WA Scheduler</strong>. Please do not reply to this email.'}
                </p>
              </td>
              <td align="right" style="white-space:nowrap;padding-left:16px;">
                <a href="${BRAND.appUrl}" style="font-size:12px;color:${BRAND.green};text-decoration:none;font-weight:600;">${BRAND.appName} →</a>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- ── BOTTOM SPACER ─────────────────────────────────────────────── -->
        <tr><td style="padding:24px 0 8px;">
          <p style="margin:0;text-align:center;font-size:11px;color:${BRAND.textLight};">
            © ${new Date().getFullYear()} ${BRAND.appName} &nbsp;·&nbsp; All rights reserved
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ─── Reusable snippets ────────────────────────────────────────────────────────
function greeting(username) {
  return `<p style="margin:0 0 16px;font-size:15px;color:${BRAND.textMain};">Hi <strong>${username}</strong>,</p>`;
}

function ctaButton(label, url, bg) {
  return `
    <table cellpadding="0" cellspacing="0" role="presentation" style="margin-top:24px;">
      <tr><td style="border-radius:10px;background:${bg || BRAND.green};">
        <a href="${url}"
           style="display:inline-block;padding:12px 24px;color:#fff;font-size:14px;font-weight:700;text-decoration:none;border-radius:10px;letter-spacing:-0.2px;">
          ${label}
        </a>
      </td></tr>
    </table>`;
}

function alertBox(icon, text, bg, border, color) {
  return `
    <table cellpadding="0" cellspacing="0" role="presentation" style="width:100%;margin:20px 0;border-radius:10px;background:${bg};border:1px solid ${border};overflow:hidden;">
      <tr>
        <td style="width:44px;padding:14px 0 14px 16px;vertical-align:top;">
          <span style="font-size:20px;line-height:1;">${icon}</span>
        </td>
        <td style="padding:14px 16px 14px 10px;font-size:14px;color:${color};line-height:1.6;font-weight:500;">
          ${text}
        </td>
      </tr>
    </table>`;
}

function detailsTable(rows) {
  const rowsHtml = rows.map((r, i) => {
    const bg = r.highlight
      ? `background:${r.highlight === 'danger' ? BRAND.dangerBg : BRAND.warningBg};`
      : i % 2 === 0 ? 'background:#f8fafc;' : 'background:#fff;';
    const labelColor = r.highlight === 'danger' ? BRAND.danger : BRAND.textMain;
    const valueColor = r.highlight === 'danger' ? BRAND.danger : BRAND.textMuted;
    return `
      <tr style="${bg}">
        <td style="padding:10px 14px;border-bottom:1px solid ${BRAND.border};font-size:13px;font-weight:600;color:${labelColor};width:35%;white-space:nowrap;">
          ${r.label}
        </td>
        <td style="padding:10px 14px;border-bottom:1px solid ${BRAND.border};font-size:13px;color:${valueColor};word-break:break-word;">
          ${r.value}
        </td>
      </tr>`;
  }).join('');

  return `
    <table cellpadding="0" cellspacing="0" role="presentation"
           style="width:100%;border-collapse:collapse;border:1px solid ${BRAND.border};border-radius:10px;overflow:hidden;margin:20px 0;font-family:inherit;">
      ${rowsHtml}
    </table>`;
}

function divider() {
  return `<hr style="border:none;border-top:1px solid ${BRAND.border};margin:24px 0;"/>`;
}

// ─── 1. WhatsApp Disconnected ─────────────────────────────────────────────────
async function sendWADisconnectAlert(toEmail, username, reason) {
  const t = getTransporter();
  if (!t) {
    console.warn('[Email] sendWADisconnectAlert skipped: transporter not available');
    return;
  }
  if (!toEmail) {
    console.warn('[Email] sendWADisconnectAlert skipped: no recipient email');
    return;
  }

  const from = getFromAddress();
  const isAuthFailure = String(reason || '').toLowerCase().includes('auth');

  const body = `
    ${greeting(username)}
    <p style="margin:0 0 4px;font-size:15px;color:${BRAND.textMain};line-height:1.6;">
      Your WhatsApp connection on <strong>${BRAND.appName}</strong> has been <strong style="color:${BRAND.danger};">disconnected</strong>.
      Scheduled messages will be <strong>paused</strong> until you reconnect.
    </p>

    ${detailsTable([
      { label: 'Account', value: username },
      { label: 'Reason',  value: `<code style="font-size:12px;background:#f1f5f9;padding:2px 6px;border-radius:4px;">${reason || 'Unknown'}</code>`, highlight: 'danger' },
      { label: 'Time',    value: new Date().toUTCString() },
    ])}

    ${alertBox('⏸', '<strong>Scheduled messages will NOT be sent</strong> while WhatsApp is disconnected. Please reconnect before any messages are due to avoid missed deliveries.', BRAND.dangerBg, BRAND.dangerBdr, BRAND.danger)}

    ${isAuthFailure
      ? alertBox('🔑', 'This looks like an <strong>authentication failure</strong>. You may need to re-scan the QR code to re-link your device.', BRAND.warningBg, BRAND.warningBdr, BRAND.warning)
      : ''}

    ${divider()}
    <p style="margin:0 0 4px;font-size:14px;color:${BRAND.textMuted};line-height:1.6;">
      Click below to log in and reconnect your WhatsApp account.
    </p>
    ${ctaButton('Reconnect WhatsApp →', `${BRAND.appUrl}/whatsapp`, BRAND.green)}
  `;

  try {
    console.log(`[Email] Sending disconnect alert → ${toEmail}`);
    const info = await t.sendMail({
      from,
      to: toEmail,
      subject: `⚠️ WhatsApp Disconnected — ${BRAND.appName}`,
      html: emailShell({
        subject:        `WhatsApp Disconnected — ${BRAND.appName}`,
        headerBg:       '#b91c1c',
        headerIcon:     '⚠️',
        headerTitle:    'WhatsApp Disconnected',
        headerSubtitle: 'Your scheduled messages have been paused.',
        bodyHtml:       body,
      }),
    });
    console.log(`[Email] Disconnect alert sent → ${toEmail} (id: ${info.messageId})`);
  } catch (err) {
    console.error(`[Email] Disconnect alert FAILED for ${toEmail}:`, err.message || err);
    // Reset transporter so next call retries with a fresh connection
    _transporterVerified = false;
  }
}

// ─── 2. Scheduled Message Failed ─────────────────────────────────────────────
async function sendScheduledMessageFailedAlert(toEmail, username, msgInfo) {
  const t = getTransporter();
  if (!t) {
    console.warn('[Email] sendScheduledMessageFailedAlert skipped: transporter not available');
    return;
  }
  if (!toEmail) {
    console.warn('[Email] sendScheduledMessageFailedAlert skipped: no recipient email');
    return;
  }

  const from = getFromAddress();
  const typeLabel = {
    individual: '👤 Individual',
    group:      '👥 Group',
    status:     '📢 Status',
  }[msgInfo.type] || msgInfo.type;

  const recipientLabel =
    msgInfo.type === 'status'
      ? '<em>WhatsApp Status broadcast</em>'
      : msgInfo.recipient || '-';

  // FIX: MySQL datetime strings don't have a "Z" suffix but ARE stored as UTC.
  // Appending "Z" before passing to `new Date()` ensures correct UTC parsing.
  const scheduledDisplay = msgInfo.scheduled_at
    ? new Date(
        String(msgInfo.scheduled_at).endsWith('Z')
          ? msgInfo.scheduled_at
          : msgInfo.scheduled_at + 'Z'
      ).toUTCString()
    : 'Unknown';

  const isExpired = String(msgInfo.error_message || '').toLowerCase().includes('expired');

  const body = `
    ${greeting(username)}
    <p style="margin:0 0 4px;font-size:15px;color:${BRAND.textMain};line-height:1.6;">
      A scheduled WhatsApp message <strong style="color:${BRAND.danger};">could not be delivered</strong>.
      Please review the details below and take action.
    </p>

    ${detailsTable([
      { label: 'Message ID',   value: `<strong>#${msgInfo.id}</strong>` },
      { label: 'Type',         value: typeLabel },
      { label: 'Recipient',    value: recipientLabel },
      { label: 'Scheduled At', value: scheduledDisplay },
      { label: 'Error',        value: `<span style="font-family:monospace;font-size:12px;">${msgInfo.error_message || 'Unknown error'}</span>`, highlight: 'danger' },
    ])}

    ${isExpired
      ? alertBox('🕐', '<strong>Message expired:</strong> WhatsApp was not connected at the scheduled time. The message window passed and the message was skipped. Reconnect WhatsApp and reschedule if needed.', BRAND.warningBg, BRAND.warningBdr, BRAND.warning)
      : alertBox('❌', '<strong>Send failed:</strong> The message was attempted but could not be delivered. Check your WhatsApp connection and verify the recipient details before rescheduling.', BRAND.dangerBg, BRAND.dangerBdr, BRAND.danger)
    }

    ${divider()}
    <p style="margin:0 0 4px;font-size:14px;color:${BRAND.textMuted};">
      Open your dashboard to review the message, check your connection, and reschedule if needed.
    </p>
    ${ctaButton('Open Dashboard →', BRAND.appUrl, BRAND.green)}
  `;

  try {
    console.log(`[Email] Sending failure alert → ${toEmail} (msg #${msgInfo.id})`);
    const info = await t.sendMail({
      from,
      to: toEmail,
      subject: `❌ Message Failed #${msgInfo.id} — ${BRAND.appName}`,
      html: emailShell({
        subject:        `Scheduled Message Failed — ${BRAND.appName}`,
        headerBg:       '#b91c1c',
        headerIcon:     '❌',
        headerTitle:    'Scheduled Message Failed',
        headerSubtitle: `Message #${msgInfo.id} could not be delivered.`,
        bodyHtml:       body,
      }),
    });
    console.log(`[Email] Failure alert sent → ${toEmail} (id: ${info.messageId})`);
  } catch (err) {
    console.error(`[Email] Failure alert FAILED for ${toEmail} (msg #${msgInfo.id}):`, err.message || err);
    // Reset transporter so next call retries with a fresh connection
    _transporterVerified = false;
  }
}

module.exports = { sendWADisconnectAlert, sendScheduledMessageFailedAlert, resetTransporter };