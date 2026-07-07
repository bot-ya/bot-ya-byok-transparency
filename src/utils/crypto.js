const crypto = require('crypto');
require('dotenv').config();

// Secret-at-rest encryption for stored credentials (BYOK API keys, LINE
// channel token/secret). AES-256-GCM = authenticated encryption: the auth tag
// detects any tampering of the ciphertext (AES-256-CBC, used before, has no MAC
// so a modified ciphertext decrypts to undetected garbage).
//
// Ciphertext formats this module reads:
//   GCM (current):  iv(24 hex) : authTag(32 hex) : ciphertext(hex)
//   CBC (legacy):   iv(32 hex) : ciphertext(hex)          ← read-only, backward compat
// Legacy CBC decryption is kept so keys encrypted before the GCM upgrade keep
// working; everything written from now on is GCM.
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY; // hashed to 32 bytes below
const GCM_IV_LENGTH = 12; // 96-bit nonce — the GCM standard/recommended size
const CBC_IV_LENGTH = 16; // legacy AES-CBC block size (pre-GCM ciphertexts)
const GCM_TAG_LENGTH = 16; // AES-GCM auth tag is always 16 bytes

function getCipherKey() {
    if (!ENCRYPTION_KEY) {
        throw new Error('ENCRYPTION_KEY is not set in .env');
    }
    // Derive a fixed 32-byte key from the env string (accepts any length input).
    return crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();
}

const isHex = (s) => typeof s === 'string' && s.length > 0 && s.length % 2 === 0 && /^[0-9a-f]+$/i.test(s);

// Recognize a value produced by encrypt() (either format). Returns the parsed
// parts + mode, or null when the value is NOT our ciphertext (plaintext,
// corrupted, or a truncated/tampered value that lost its structure).
function classify(text) {
    if (typeof text !== 'string') return null;
    const p = text.split(':');
    if (p.length === 3 &&
        p[0].length === GCM_IV_LENGTH * 2 && p[1].length === GCM_TAG_LENGTH * 2 &&
        isHex(p[0]) && isHex(p[1]) && isHex(p[2])) {
        return { mode: 'gcm', parts: p };
    }
    if (p.length === 2 &&
        p[0].length === CBC_IV_LENGTH * 2 &&
        isHex(p[0]) && isHex(p[1])) {
        return { mode: 'cbc', parts: p };
    }
    return null;
}

/**
 * True if `text` is already an encrypted value produced by this module.
 * Used by the one-off migration script to skip already-encrypted rows.
 */
function isEncrypted(text) {
    return classify(text) !== null;
}

/**
 * Encrypts a text string with AES-256-GCM.
 * @param {string} text
 * @returns {string} iv:authTag:ciphertext (hex). Empty/falsy input passes through.
 */
function encrypt(text) {
    if (!text) return text;
    const iv = crypto.randomBytes(GCM_IV_LENGTH);
    const key = getCipherKey();
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts a value produced by encrypt() (GCM) or a legacy CBC ciphertext.
 * @param {string} text iv:authTag:ciphertext (GCM) or iv:ciphertext (legacy CBC)
 * @returns {string} original text. Empty/falsy input passes through.
 * @throws if the value is not a recognized ciphertext, or fails authentication
 *   (GCM tamper). Fail-closed: there is NO silent plaintext passthrough — the
 *   old behavior returned unrecognized input verbatim, which let a tampered or
 *   truncated ciphertext leak through as if it were cleartext.
 */
function decrypt(text) {
    if (!text) return text;
    const info = classify(text);
    if (!info) {
        throw new Error('Decryption failed: value is not an encrypted ciphertext');
    }
    const key = getCipherKey();
    try {
        if (info.mode === 'gcm') {
            const [ivHex, tagHex, dataHex] = info.parts;
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
            decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
            return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
        }
        // legacy CBC (no MAC) — only reached for keys encrypted before the GCM upgrade
        const [ivHex, dataHex] = info.parts;
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'));
        return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
    } catch (e) {
        console.error(`[crypto] Decryption failed: ${e.message}`);
        throw new Error('Decryption failed');
    }
}

module.exports = { encrypt, decrypt, isEncrypted };
