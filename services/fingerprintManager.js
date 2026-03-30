/**
 * FingerprintManager - Tạo fingerprint unique cho mỗi request
 * Sử dụng thư viện fingerprint-generator (đã cài sẵn)
 */
const { FingerprintGenerator } = require('fingerprint-generator');
const { FingerprintInjector } = require('fingerprint-injector');

class FingerprintManager {
    constructor() {
        this.generator = new FingerprintGenerator();
        this._activeFingerprints = new Set(); // Track UA đang dùng để tránh trùng
    }

    /**
     * Tạo fingerprint mới, đảm bảo không trùng với các worker khác
     */
    generate() {
        let fingerprint;
        let attempts = 0;

        do {
            fingerprint = this.generator.getFingerprint({
                browsers: ['chrome'],
                operatingSystems: ['windows', 'macos'],
                devices: ['desktop'],
                locales: ['en-US'],
            });
            attempts++;
        } while (
            this._activeFingerprints.has(fingerprint.fingerprint.navigator.userAgent) &&
            attempts < 10
        );

        // Đánh dấu fingerprint đang dùng
        const ua = fingerprint.fingerprint.navigator.userAgent;
        this._activeFingerprints.add(ua);

        return {
            fingerprint,
            release: () => this._activeFingerprints.delete(ua)
        };
    }

    /**
     * Inject fingerprint vào page puppeteer
     */
    async inject(page, fingerprintData) {
        const injector = new FingerprintInjector();
        await injector.attachFingerprintToPuppeteer(page, fingerprintData.fingerprint);
    }
}

module.exports = FingerprintManager;
