/**
 * Backend client certificates (S04 §6, REST): gateway-generated RSA-2048
 * self-signed certificates. The PEM is public (backends trust it); the
 * private key lives in the vault. Pure-JS DER construction — no new
 * dependencies; signatures use `node:crypto`.
 *
 * @module lib/control/cert-issue
 */

import { createPrivateKey, createSign, generateKeyPairSync, randomBytes, X509Certificate } from "node:crypto";

function derLength(length) {
  if (length < 128) return Buffer.from([length]);
  const bytes = [];
  let rest = length;
  while (rest > 0) {
    bytes.unshift(rest & 0xff);
    rest >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, ...parts) {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

function oid(...arcs) {
  const bytes = [arcs[0] * 40 + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const stack = [arc & 0x7f];
    let rest = arc >> 7;
    while (rest > 0) {
      stack.unshift((rest & 0x7f) | 0x80);
      rest >>= 7;
    }
    bytes.push(...stack);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function integer(bytes) {
  let body = Buffer.from(bytes);
  if (body.length === 0) body = Buffer.from([0]);
  if (body[0] & 0x80) body = Buffer.concat([Buffer.from([0]), body]);
  return tlv(0x02, body);
}

function bitString(bytes, unusedBits = 0) {
  return tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), Buffer.from(bytes)]));
}

function utf8Time(date) {
  // UTCTime for years < 2050 (our certs live 365 days from issue).
  const pad = (num) => String(num).padStart(2, "0");
  const text = `${String(date.getUTCFullYear()).slice(2)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(text, "ascii"));
}

const RSA_ENCRYPTION = oid(1, 2, 840, 113549, 1, 1, 1);
const SHA256_RSA = oid(1, 2, 840, 113549, 1, 1, 11);
const NULL = Buffer.from([0x05, 0x00]);
const CN_OID = oid(2, 5, 4, 3);

function rsaPublicKeyDer(nBytes, eBytes) {
  return tlv(0x30, integer(nBytes), integer(eBytes));
}

function spkiDer(nBytes, eBytes) {
  return tlv(0x30, tlv(0x30, RSA_ENCRYPTION, NULL), bitString(rsaPublicKeyDer(nBytes, eBytes)));
}

function nameDer(commonName) {
  return tlv(0x30, tlv(0x31, tlv(0x30, CN_OID, tlv(0x13, Buffer.from(commonName, "utf8")))));
}

function toPem(label, der) {
  const b64 = der.toString("base64");
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/**
 * Issues a self-signed RSA-2048 client certificate.
 *
 * @param {{ commonName?: string, daysValid?: number, notBefore?: Date }} [opts={}]
 * @returns {{ certificatePem: string, privateKeyPem: string, publicKeyPem: string, serialHex: string, notBefore: Date, notAfter: Date }}
 */
export function issueSelfSignedCertificate(opts = {}) {
  const commonName = opts.commonName ?? "pods-backend-client";
  const daysValid = opts.daysValid ?? 365;
  const notBefore = opts.notBefore ?? new Date();
  const notAfter = new Date(notBefore.getTime() + daysValid * 24 * 3600 * 1000);

  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { format: "jwk" },
    privateKeyEncoding: { format: "jwk" },
  });
  const nBytes = Buffer.from(publicKey.n, "base64url");
  const eBytes = Buffer.from(publicKey.e, "base64url");

  const serial = integer(randomBytes(16));
  const name = nameDer(commonName);
  const basicConstraints = tlv(0x30, oid(2, 5, 29, 19), tlv(0x04, tlv(0x30)));
  const keyUsage = tlv(
    0x30,
    oid(2, 5, 29, 15),
    tlv(0x01, Buffer.from([0xff])),
    tlv(0x04, bitString([0xa0], 5)),
  );
  const extKeyUsage = tlv(
    0x30,
    oid(2, 5, 29, 37),
    tlv(0x04, tlv(0x30, oid(1, 3, 6, 1, 5, 5, 7, 3, 2))),
  );
  const extensionsSeq = tlv(0xa3, tlv(0x30, basicConstraints, keyUsage, extKeyUsage));

  const tbs = tlv(
    0x30,
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    serial,
    tlv(0x30, SHA256_RSA, NULL),
    name,
    tlv(0x30, utf8Time(notBefore), utf8Time(notAfter)),
    name,
    spkiDer(nBytes, eBytes),
    extensionsSeq,
  );
  const key = createPrivateKey({ key: privateKey, format: "jwk" });
  const signature = createSign("RSA-SHA256").update(tbs).sign(key);
  const certificate = tlv(0x30, tbs, tlv(0x30, SHA256_RSA, NULL), bitString(signature));

  const privateKeyPem = key.export({ format: "pem", type: "pkcs8" }).toString();
  const publicKeyPem = toPem("PUBLIC KEY", spkiDer(nBytes, eBytes));
  const certificatePem = toPem("CERTIFICATE", certificate);
  const parsed = new X509Certificate(certificatePem);
  return {
    certificatePem,
    privateKeyPem,
    publicKeyPem,
    serialHex: parsed.serialNumber,
    notBefore,
    notAfter,
  };
}
