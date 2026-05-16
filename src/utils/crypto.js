const crypto = require('crypto');
require('dotenv').config();

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY; // Must be 32 bytes (64 hex chars) or just a string we hash
const IV_LENGTH = 16; // AES block size

function getCipherKey() {
    if (!ENCRYPTION_KEY) {
        throw new Error('ENCRYPTION_KEY is not set in .env');
    }
    // Create a 32-byte key from the env string using sha256 to ensure length
    return crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();
}

/**
 * Encrypts a text string
 * @param {string} text
 * @returns {string} iv:encryptedText (hex)
 */
function encrypt(text) {
    if (!text) return text;
    const iv = crypto.randomBytes(IV_LENGTH);
    const key = getCipherKey();
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
}

/**
 * Decrypts an encrypted string
 * @param {string} text iv:encryptedText
 * @returns {string} original text
 */
function decrypt(text) {
    if (!text) return text;
    const textParts = text.split(':');
    if (textParts.length < 2) return text; // Not encrypted or invalid format

    const iv = Buffer.from(textParts.shift(), 'hex');
    const encryptedText = Buffer.from(textParts.join(':'), 'hex');
    const key = getCipherKey();

    try {
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString();
    } catch (e) {
        console.error(`[crypto] Decryption failed: ${e.message}`);
        throw new Error('Decryption failed');
    }
}

module.exports = { encrypt, decrypt };
