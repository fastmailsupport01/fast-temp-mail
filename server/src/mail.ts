/**
 * Outbound email: Resend API first, Gmail SMTP pool as fallback.
 *
 * Used for OTP verification codes and password-reset codes. When neither
 * transport is configured, sending is skipped and callers fall back to an
 * honest "delivery not configured" message — the app never pretends an email
 * was sent.
 *
 * RESEND_FROM must be an address on a domain you verified in Resend
 * (e.g. "Fast Mail <noreply@mail.example.com>"). Resend's
 * `onboarding@resend.dev` works for testing but only delivers to the
 * Resend account owner's address.
 *
 * GMAIL_SMTP_POOL is a JSON array of Gmail accounts used in round-robin as a
 * free fallback so OTPs reach any address without a verified domain:
 *   GMAIL_SMTP_POOL='[{"user":"a@gmail.com","pass":"xxxx xxxx xxxx xxxx"}, ...]'
 * Each entry needs a Gmail App Password (Google account → 2-Step Verification
 * → App passwords). Gmail allows ~500 sends/day per account; the pool rotates
 * so load spreads across accounts, and a failing account is skipped.
 */

import nodemailer from "nodemailer";

export function resendConfigured(): boolean {
  return Boolean((process.env.RESEND_API_KEY ?? "").trim());
}

type GmailAccount = { user: string; pass: string };

function gmailPool(): GmailAccount[] {
  try {
    const raw = (process.env.GMAIL_SMTP_POOL ?? "").trim();
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(
        (a): a is { user: string; pass: string } =>
          Boolean(a) && typeof (a as { user?: unknown }).user === "string" &&
          typeof (a as { pass?: unknown }).pass === "string" &&
          (a as { user: string }).user.includes("@") &&
          (a as { pass: string }).pass.trim().length > 0,
      )
      .map((a) => ({ user: a.user.trim().toLowerCase(), pass: a.pass.replace(/\s+/g, "") }));
  } catch {
    return [];
  }
}

/** Number of Gmail accounts in the pool (safe to expose — no addresses). */
export function gmailPoolSize(): number {
  return gmailPool().length;
}

let gmailIndex = 0;

async function sendViaResend(to: string, subject: string, html: string, text: string): Promise<boolean> {
  const apiKey = (process.env.RESEND_API_KEY ?? "").trim();
  if (!apiKey) return false;
  const from = (process.env.RESEND_FROM ?? "").trim() || "Fast Mail <onboarding@resend.dev>";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: [to], subject, html, text }),
    });
    if (!res.ok) {
      console.error(`[mail] resend rejected the message: ${res.status} ${await res.text()}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[mail] resend request failed:", err);
    return false;
  }
}

async function sendViaGmail(to: string, subject: string, html: string, text: string): Promise<boolean> {
  const pool = gmailPool();
  if (pool.length === 0) return false;
  const start = gmailIndex % pool.length;
  for (let i = 0; i < pool.length; i++) {
    const acct = pool[(start + i) % pool.length]!;
    try {
      const transporter = nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        auth: { user: acct.user, pass: acct.pass },
      });
      await transporter.sendMail({
        from: `"Fast Mail" <${acct.user}>`,
        to,
        subject,
        html,
        text,
      });
      gmailIndex = (start + i + 1) % pool.length;
      return true;
    } catch (err) {
      console.error(`[mail] gmail send failed, skipping account #${(start + i) % pool.length}:`, err);
    }
  }
  return false;
}

export async function sendEmail(
  to: string,
  subject: string,
  html: string,
  text: string,
): Promise<boolean> {
  if (await sendViaResend(to, subject, html, text)) return true;
  if (await sendViaGmail(to, subject, html, text)) return true;
  return false;
}

export function otpEmail(code: string): { subject: string; html: string; text: string } {
  return {
    subject: "Your Fast Mail verification code",
    html: `<p>Your Fast Mail verification code is <strong>${code}</strong>.</p><p>It expires in 10 minutes. If you did not request this, you can ignore this email.</p>`,
    text: `Your Fast Mail verification code is ${code}. It expires in 10 minutes.`,
  };
}

export function resetEmail(code: string): { subject: string; html: string; text: string } {
  return {
    subject: "Reset your Fast Temp Mail password",
    html: `<p>Use this code to reset your Fast Temp Mail password: <strong>${code}</strong></p><p>It expires in 30 minutes. If you did not request this, you can ignore this email.</p>`,
    text: `Your Fast Temp Mail password reset code is ${code}. It expires in 30 minutes.`,
  };
}
