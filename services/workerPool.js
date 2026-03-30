/**
 * WorkerPool - Điều phối N worker cào song song từ queue chung
 * Mỗi worker lấy job nhỏ nhất (1 chapter) từ queue, cào xong lấy tiếp
 */
class WorkerPool {
    constructor(proxyManager, concurrency) {
        this.proxyManager = proxyManager;
        this.concurrency = concurrency;
        this.queue = [];
        this.results = { success: 0, failed: 0, skipped: 0 };
    }

    addJob(jobFn) {
        this.queue.push(jobFn);
    }

    addJobs(jobFns) {
        this.queue.push(...jobFns);
    }

    get remaining() {
        return this.queue.length;
    }

    async run() {
        const totalJobs = this.queue.length;
        console.log(`\n🚀 WorkerPool: ${totalJobs} jobs | ${this.concurrency} worker song song\n`);

        const workers = [];
        for (let i = 0; i < this.concurrency; i++) {
            workers.push(this._startWorker(i + 1, totalJobs));
        }

        await Promise.all(workers);

        console.log(`\n${'='.repeat(60)}`);
        console.log(`🏁 WorkerPool HOÀN TẤT:`);
        console.log(`   ✅ Thành công: ${this.results.success}`);
        console.log(`   ❌ Thất bại: ${this.results.failed}`);
        console.log(`   ⏭️ Bỏ qua: ${this.results.skipped}`);
        console.log(`${'='.repeat(60)}\n`);

        return this.results;
    }

    async _startWorker(workerId, totalJobs) {
        while (this.queue.length > 0) {
            const job = this.queue.shift();
            if (!job) break;

            const jobIndex = totalJobs - this.queue.length;

            try {
                const result = await job(this.proxyManager, workerId);
                if (result === 'skipped') {
                    this.results.skipped++;
                } else {
                    this.results.success++;
                }
            } catch (err) {
                this.results.failed++;
                console.error(`   💥 Worker-${workerId} | Job thất bại: ${err.message}`);
            }

            // Nghỉ ngẫu nhiên 2-5s
            const sleep = Math.floor(Math.random() * 3000) + 2000;
            await new Promise(r => setTimeout(r, sleep));
        }

        console.log(`   👷 Worker-${workerId} | Xong, không còn job.`);
    }
}

module.exports = WorkerPool;
