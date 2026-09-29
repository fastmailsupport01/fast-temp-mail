/**
 * Outbound/inbound SMS plumbing via Twilio.
 *
 * Virtual numbers let users receive real SMS messages (e.g. verification
 * codes) on a rented number. Everything is gated behind TWILIO_ACCOUNT_SID /
 * TWILIO_AUTH_TOKEN — when they are not set, the app reports honestly that
 * SMS receiving is not configured instead of pretending.
 *
 * Inbound SMS arrives at POST /webhooks/twilio-sms (see server/src/index.ts),
 * which validates Twilio's request signature before storing the message.
 */

import { createHmac } from "node:crypto";

export const SMS_NUMBER_PRICE_USD = 2;
export const SMS_NUMBER_RENTAL_DAYS = 30;

export function twilioAccountSid(): string {
  return (process.env.TWILIO_ACCOUNT_SID ?? "").trim();
}

function twilioAuthToken(): string {
  return (process.env.TWILIO_AUTH_TOKEN ?? "").trim();
}

export function twilioConfigured(): boolean {
  return Boolean(twilioAccountSid() && twilioAuthToken());
}

export function publicBaseUrl(): string {
  const raw = (process.env.PUBLIC_BASE_URL ?? "").trim();
  if (raw) return raw.replace(/\/+$/, "");
  return "https://fast-temp-mail.onrender.com";
}

export function twilioSmsWebhookUrl(): string {
  return `${publicBaseUrl()}/webhooks/twilio-sms`;
}

function twilioApi(path: string, init?: RequestInit): Promise<Response> {
  const sid = twilioAccountSid();
  const token = twilioAuthToken();
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  return fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}${path}`, {
    ...init,
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      ...(init?.headers ?? {}),
    },
  });
}

/**
 * Validate Twilio's X-Twilio-Signature header.
 * Algorithm: sort POST params by key, concatenate url + each key+value,
 * HMAC-SHA1 with the auth token, base64-encode, compare.
 */
export function validateTwilioSignature(
  signature: string,
  url: string,
  params: Record<string, string>,
): boolean {
  const token = twilioAuthToken();
  if (!token || !signature) return false;
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join("");
  const expected = createHmac("sha1", token).update(data, "utf8").digest("base64");
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

export async function buyTwilioNumber(): Promise<{ phoneNumber: string; sid: string }> {
  // 1. Find an available SMS-capable local number (US).
  const search = await twilioApi(`/AvailablePhoneNumbers/US/Local.json?SmsEnabled=true&Limit=1`);
  if (!search.ok) throw new Error(`Twilio number search failed (HTTP ${search.status}).`);
  const searchJson = (await search.json()) as { available_phone_numbers?: Array<{ phone_number: string }> };
  const candidate = searchJson.available_phone_numbers?.[0]?.phone_number;
  if (!candidate) throw new Error("Twilio has no SMS-capable numbers available right now.");

  // 2. Purchase it and point inbound SMS at our webhook.
  const buy = await twilioApi(`/IncomingPhoneNumbers.json`, {
    method: "POST",
    body: new URLSearchParams({
      PhoneNumber: candidate,
      SmsUrl: twilioSmsWebhookUrl(),
      SmsMethod: "POST",
    }),
  });
  if (!buy.ok) {
    const detail = await buy.text().catch(() => "");
    throw new Error(`Twilio number purchase failed (HTTP ${buy.status}). ${detail.slice(0, 200)}`);
  }
  const bought = (await buy.json()) as { phone_number: string; sid: string };
  if (!bought.phone_number || !bought.sid) throw new Error("Twilio returned an incomplete purchase response.");
  return { phoneNumber: bought.phone_number, sid: bought.sid };
}

export async function releaseTwilioNumber(incomingSid: string): Promise<void> {
  const res = await twilioApi(`/IncomingPhoneNumbers/${incomingSid}.json`, { method: "DELETE" });
  // 204 = deleted. Anything else: log but don't hard-fail the release flow.
  if (!res.ok && res.status !== 204) {
    console.error(`[sms] Twilio release returned HTTP ${res.status} for ${incomingSid}`);
  }
}
