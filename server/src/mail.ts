/**
 * Outbound email via the Resend API (https://resend.com).
 *
 * Used for OTP verification codes and password-reset codes. When
 * RESEND_API_KEY is not set, sending is skipped and callers fall back to an
 * honest "delivery not configured" message — the app never pretends an email
 * was sent.
 *
 * RESEND_FROM must be an address on a domain you verified in Resend
 * (e.g. "Fast Temp Mail <noreply@mail.example.com>"). Resend's
 * `onboarding@resend.dev` works for testing but only delivers to the
 * Resend account owner's address.
 */

export function resendConfigured(): boolean {
  return Boolean((process.env.RESEND_API_KEY ?? "").trim());
}

export async function sendEmail(
  to: string,
  subject: string,
  html: string,
  text: string,
): Promise<boolean> {
  const apiKey = (process.env.RESEND_API_KEY ?? "").trim();
  if (!apiKey) return false;
  const from = (process.env.RESEND_FROM ?? "").trim() || "Fast Temp Mail <onboarding@resend.dev>";
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

export function otpEmail(code: string): { subject: string; html: string; text: string } {
  return {
    subject: "Your Fast Temp Mail verification code",
    html: `<p>Your Fast Temp Mail verification code is <strong>${code}</strong>.</p><p>It expires in 10 minutes. If you did not request this, you can ignore this email.</p>`,
    text: `Your Fast Temp Mail verification code is ${code}. It expires in 10 minutes.`,
  };
}

export function resetEmail(code: string): { subject: string; html: string; text: string } {
  return {
    subject: "Reset your Fast Temp Mail password",
    html: `<p>Use this code to reset your Fast Temp Mail password: <strong>${code}</strong></p><p>It expires in 30 minutes. If you did not request this, you can ignore this email.</p>`,
    text: `Your Fast Temp Mail password reset code is ${code}. It expires in 30 minutes.`,
  };
}
