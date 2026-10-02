import { describe, expect, it } from "vitest";
import { detectSensitive, ibanValid, luhnValid, redactSensitive } from "../../src/guards/sensitive.js";

const kinds = (t: string) => detectSensitive(t).map((f) => `${f.tier}:${f.kind}`);

describe("G09 detector: Prohibited secrets (ADR-020)", () => {
  const cases: Array<[string, string]> = [
    ["my password is Hunter2!x", "password"],
    ["Contraseña: Clave$egura99", "password"],
    ["la clave es 8812abcd", "password"],
    ["key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123", "api_key"],
    ["AWS AKIAIOSFODNN7EXAMPLE", "api_key"],
    ["token ghp_abcdefghijklmnopqrstuvwxyz0123456789", "api_key"],
    ["re_123456789abcdefghij for resend", "api_key"],
    ["Authorization: Bearer abcdefghijklmnopqrstuvwxyz.1234567890", "bearer_token"],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV", "jwt"],
    ["postgres://finagai_app:S3cretPw@db.example.com/finagai", "connection_string_credentials"],
    ["-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----", "private_key"],
  ];
  for (const [text, kind] of cases) {
    it(`detects ${kind} in "${text.slice(0, 30)}"`, () => {
      expect(kinds(text)).toContain(`prohibited:${kind}`);
    });
  }
});

describe("G09 detector: Highly Sensitive identifiers (ADR-016)", () => {
  it("detects a Luhn-valid card number with spaces, and ignores a Luhn-invalid one", () => {
    expect(kinds("card 4111 1111 1111 1111 exp 09/28")).toContain("highly_sensitive:payment_card");
    expect(kinds("order 4111 1111 1111 1112")).toEqual([]);
  });
  it("detects a valid IBAN and a US SSN, and rejects reserved SSN ranges", () => {
    expect(kinds("IBAN GB82 WEST 1234 5698 7654 32")).toContain("highly_sensitive:iban");
    expect(kinds("SSN 123-45-6789")).toContain("highly_sensitive:us_ssn");
    expect(kinds("ref 000-12-3456")).toEqual([]);
  });
  it("detects labeled bank account numbers in English and Spanish", () => {
    expect(kinds("account number: 000123456789")).toContain("highly_sensitive:bank_account");
    expect(kinds("número de cuenta 1234567890")).toContain("highly_sensitive:bank_account");
  });
  it("validators work", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(ibanValid("GB82WEST12345698765432")).toBe(true);
    expect(ibanValid("GB82WEST12345698765431")).toBe(false);
  });
});

describe("no false positives on ordinary work content", () => {
  const ordinary = [
    "Call the owner of The Rustic Bar before Friday Oct 9",
    "Tengo que enviar la propuesta antes del viernes 9 de octubre a las 3 pm",
    "Revenue last month was $4,250 across 6 machines",
    "Meeting at 2026-10-09 15:00, room 1203",
    "Phone extension 4417; invoice INV-2026-0042",
    "Password reset policy for Vendora staff: review next week",
  ];
  for (const t of ordinary) {
    it(`leaves "${t.slice(0, 40)}" untouched`, () => expect(detectSensitive(t)).toEqual([]));
  }
});

describe("redaction", () => {
  it("removes the secret but keeps the surrounding context, without repeating the value", () => {
    const { text, findings } = redactSensitive("Login for the POS portal: password: Hunter2!x — renew contract by Friday");
    expect(text).toBe("Login for the POS portal: password: [REDACTED:password] — renew contract by Friday");
    expect(text).not.toContain("Hunter2");
    expect(findings).toHaveLength(1);
  });
  it("redacts several findings in one input", () => {
    const { text } = redactSensitive("card 4111 1111 1111 1111 and key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123");
    expect(text).toBe("card [REDACTED:payment_card] and key [REDACTED:api_key]");
  });
});
