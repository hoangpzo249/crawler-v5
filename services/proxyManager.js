/**
 * ProxyManager - Quản lý proxy với cơ chế lock/checkout
 * Đảm bảo không có 2 worker dùng chung 1 proxy cùng lúc
 */
class ProxyManager {
    constructor(proxyString) {
        this.proxies = proxyString.split(',').filter(p => p.trim() !== '').map((p, index) => {
            const [ip, port, user, pass] = p.trim().split(':');
            return {
                id: index,
                ip, port, user, pass,
                inUse: false,
                cooldownUntil: 0, // timestamp khi proxy hết cooldown
                usageCount: 0
            };
        });

        this._waitQueue = []; // Các worker đang chờ proxy rảnh
        console.log(`🔧 ProxyManager: Đã load ${this.proxies.length} proxy`);
    }

    /**
     * Mượn 1 proxy rảnh (không trùng với lastProxyId)
     * Nếu không có proxy rảnh → chờ đến khi có
     */
    async checkout(lastProxyId = -1) {
        while (true) {
            const now = Date.now();

            // Tìm proxy rảnh, ưu tiên proxy khác với lần trước (luân phiên)
            const available = this.proxies
                .filter(p => !p.inUse && p.cooldownUntil <= now)
                .sort((a, b) => {
                    // Ưu tiên proxy khác với lastProxyId
                    if (a.id === lastProxyId && b.id !== lastProxyId) return 1;
                    if (b.id === lastProxyId && a.id !== lastProxyId) return -1;
                    // Ưu tiên proxy ít dùng hơn
                    return a.usageCount - b.usageCount;
                });

            if (available.length > 0) {
                const proxy = available[0];
                proxy.inUse = true;
                proxy.usageCount++;
                console.log(`   🔒 Proxy [${proxy.ip}] đã được checkout (lần dùng: ${proxy.usageCount})`);
                return proxy;
            }

            // Không có proxy rảnh → chờ
            console.log(`   ⏳ Tất cả proxy đang bận, đang chờ...`);
            await new Promise(resolve => this._waitQueue.push(resolve));
        }
    }

    /**
     * Trả proxy sau khi dùng xong
     */
    release(proxy) {
        proxy.inUse = false;
        console.log(`   🔓 Proxy [${proxy.ip}] đã được trả lại`);

        // Đánh thức worker đang chờ (nếu có)
        if (this._waitQueue.length > 0) {
            const resolve = this._waitQueue.shift();
            resolve();
        }
    }

    /**
     * Đánh dấu proxy bị lỗi → cooldown 60s
     */
    markFailed(proxy) {
        proxy.inUse = false;
        proxy.cooldownUntil = Date.now() + 60000;
        console.log(`   ⚠️ Proxy [${proxy.ip}] bị lỗi, cooldown 60s`);

        if (this._waitQueue.length > 0) {
            const resolve = this._waitQueue.shift();
            resolve();
        }
    }

    get totalProxies() {
        return this.proxies.length;
    }
}

module.exports = ProxyManager;
