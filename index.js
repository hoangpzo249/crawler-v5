require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const crawler = require('./services/crawler');
const ProxyManager = require('./services/proxyManager');
const WorkerPool = require('./services/workerPool');

// ===== CẤU HÌNH =====
const BATCH_SIZE = 50;
const TARGET_CHAPTERS = 10;
const REST_BETWEEN_BATCHES = 5 * 60 * 1000;
const MAX_CHAPTERS_PER_BROWSER = 5;  // Chế độ 2: đóng/mở Chrome sau N chap để dọn RAM

// Cấu hình cào danh sách
const SCRAPE_LIST_URL = 'https://mangahub.io/popular';
const MAX_STORIES_TO_CRAWL = 5;

// Thay vì hardcode danh sách, hãy để biến let và lấy tự động từ MangaHub
let storyUrls = [];

// ===== SELECTORS cho MangaHub =====
const MANGAHUB_SELECTORS = {
    title: 'h1._3xnDj',
    description: 'div._3Iyzg, div.fullcontent',
    cover_image: 'img.img-responsive',
    cover_attr: 'src',
    genres: 'a[href*="/genre/"]',
    info_labels: {
        author: 'span:contains("Author") + *',
        artist: 'span:contains("Artist") + *',
        status: 'span:contains("Status") + *',
    },
    chapter_list: '.tab-content .tab-pane a',
    chapter_url_pattern: '/chapter',
    chapter_number_regex: '#(\\d+(\\.\\d+)?)',
    chapter_images: '#mangareader img',
    chapter_image_attr: 'src',
    chapter_image_filter: { startsWith: 'http', excludes: 'logo' },
};

async function getOrCreateSource() {
    let source = await prisma.crawlSource.findFirst({
        where: { baseUrl: 'https://mangahub.io' }
    });

    if (!source) {
        source = await prisma.crawlSource.create({
            data: {
                name: 'MangaHub',
                baseUrl: 'https://mangahub.io',
                selectors: MANGAHUB_SELECTORS,
                isActive: true,
                analyzedAt: new Date(),
            }
        });
    }
    return source;
}

async function upsertGenres(genreNames) {
    const genres = [];
    for (const name of genreNames) {
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        if (!slug) continue;
        
        try {
            const genre = await prisma.genre.upsert({
                where: { slug },
                update: { name },
                create: { name, slug }
            });
            genres.push({ id: genre.id });
        } catch (e) {
            const genre = await prisma.genre.findUnique({ where: { slug } });
            if (genre) genres.push({ id: genre.id });
        }
    }
    return genres;
}

async function updateGenreCounts() {
    const genres = await prisma.genre.findMany();
    for (const genre of genres) {
        const count = await prisma.comicGenre.count({
            where: { genreId: genre.id }
        });
        await prisma.genre.update({
            where: { id: genre.id },
            data: { comicCount: count }
        });
    }
    console.log(`📊 Đã cập nhật comic_count cho ${genres.length} genres`);
}

// ================================================================
// BƯỚC 1: Cào info truyện (dùng chung cho cả 2 chế độ)
// ================================================================
async function scrapeStoryInfo(url, proxyManager, source) {
    const proxy = await proxyManager.checkout(-1);
    const browser = await crawler.createBrowser(proxy);

    let info;
    try {
        info = await crawler.scrapeStoryInfo(browser, url, proxy);
    } catch (err) {
        proxyManager.markFailed(proxy);
        await crawler.closeBrowser(browser);
        throw err;
    }

    await crawler.closeBrowser(browser);
    proxyManager.release(proxy);

    if (!info || !info.title) return null;

    const comicSlug = info.slug.replace(/_\d+$/, '');
    const genresToConnect = await upsertGenres(info.genres);

    const comic = await prisma.comic.upsert({
        where: { slug: comicSlug },
        update: {
            title: info.title,
            authors: info.author || [],
            artists: info.artist || [],
            description: info.description,
            altTitles: info.alt_titles || [],
            status: (info.status || 'ongoing').toUpperCase(),
            coverScrapedUrl: info.thumbnail || '',
            // Bỏ dòng coverCdnUrl: '', để tránh xoá mất link CDN đã upload do BE làm
            type: 'MANHWA',
            crawlSourceId: source.id,
            sourceUrl: url,
            lastCrawledAt: new Date(),
            comicGenres: {
                deleteMany: {},
                create: genresToConnect.map(g => ({ genreId: g.id }))
            }
        },
        create: {
            slug: comicSlug,
            title: info.title,
            authors: info.author || [],
            artists: info.artist || [],
            description: info.description,
            altTitles: info.alt_titles || [],
            status: (info.status || 'ongoing').toUpperCase(),
            coverScrapedUrl: info.thumbnail || '',
            coverCdnUrl: '',
            type: 'MANHWA',
            crawlSourceId: source.id,
            sourceUrl: url,
            lastCrawledAt: new Date(),
            comicGenres: {
                create: genresToConnect.map(g => ({ genreId: g.id }))
            }
        }
    });

    const chaptersInDb = await prisma.chapter.findMany({
        where: { comicId: comic.id },
        select: { chapterNumber: true, pages: true }
    });

    // Lọc lại các chapter đã cào có trang > 0
    const existingChapNums = new Set(
        chaptersInDb.filter(c => Array.isArray(c.pages) && c.pages.length > 0).map(c => c.chapterNumber)
    );
    const existingCount = existingChapNums.size;

    if (existingCount >= TARGET_CHAPTERS) {
        console.log(`   ⏭️ ${info.title} đã đủ ${existingCount}/${TARGET_CHAPTERS} chap, SKIP!`);
        return null;
    }

    const allChapters = info.chapterLinks.slice(0, TARGET_CHAPTERS);
    const chaptersToScrape = allChapters.filter(cObj => {
        const match = cObj.title.match(/#(\d+(\.\d+)?)/);
        return match && !existingChapNums.has(parseFloat(match[1]));
    });

    console.log(`   📂 ${info.title} | Cần cào ${chaptersToScrape.length} chap (đã có ${existingChapNums.size})`);

    return { comic, comicSlug, info, chaptersToScrape, source };
}

// ================================================================
// Lưu chapter vào DB (dùng chung cho cả 2 chế độ)
// ================================================================
async function saveChapter(comic, comicSlug, chapterNumber, chapterTitle, seoSlug, images, workerId) {
    const pages = images.map((imgUrl, idx) => ({
        pageNumber: idx + 1,
        scrapedUrl: imgUrl,
        cdnUrl: '',
    }));

    const chapter = await prisma.chapter.upsert({
        where: {
            comicId_chapterNumber: {
                comicId: comic.id,
                chapterNumber: chapterNumber
            }
        },
        update: {
            title: chapterTitle,
            slug: seoSlug,
            pages: pages,
        },
        create: {
            comicId: comic.id,
            chapterNumber: chapterNumber,
            title: chapterTitle,
            slug: seoSlug,
            imageSource: 'scraped',
            pages: pages,
        }
    });

    console.log(`   ✅ Worker-${workerId} | ${comic.title} - ${chapterTitle} | Trang: ${pages.length}`);

    // Lấy 3 chapter gần nhất
    const allChapters = await prisma.chapter.findMany({
        where: { comicId: comic.id },
        select: { id: true, chapterNumber: true, slug: true, createdAt: true, pages: true },
        orderBy: { chapterNumber: 'desc' }
    });

    const latestValidChapters = allChapters.filter(c => Array.isArray(c.pages) && c.pages.length > 0).slice(0, 3);

    await prisma.comic.update({
        where: { id: comic.id },
        data: {
            latestChapters: latestValidChapters.map(c => ({
                chapterId: c.id,
                chapterNumber: c.chapterNumber,
                slug: c.slug,
                createdAt: c.createdAt.toISOString() || new Date().toISOString(),
            }))
        }
    });

    return chapter;
}

// ================================================================
// CHẾ ĐỘ 1: Queue chung — nhiều proxy cào chung chapters
// Dùng khi: số truyện cần cào ≤ số proxy
// ================================================================
const workerLastProxy = {};

async function scrapeOneChapter(chapterData, proxyManager, workerId) {
    const { comic, comicSlug, cObj } = chapterData;
    const matchNumber = cObj.title.match(/#(\d+(\.\d+)?)/);
    const chapterNumber = parseFloat(matchNumber[1]);
    const seoSlug = `chapter-${chapterNumber}`;
    const chapterTitle = `Chapter ${chapterNumber}`;

    let images = [];
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts && images.length === 0) {
        attempts++;

        const proxy = await proxyManager.checkout(workerLastProxy[workerId] || -1);
        workerLastProxy[workerId] = proxy.id;
        const browser = await crawler.createBrowser(proxy);

        try {
            console.log(`   📸 Worker-${workerId} | ${comic.title} [${chapterTitle}] Proxy [${proxy.ip}]`);
            images = await crawler.scrapeChapterImages(browser, cObj.url, proxy);
            await crawler.closeBrowser(browser);
            proxyManager.release(proxy);
        } catch (err) {
            await crawler.closeBrowser(browser);
            proxyManager.markFailed(proxy);
            console.error(`   ❌ Worker-${workerId} | ${chapterTitle} lỗi: ${err.message}`);
            if (attempts < maxAttempts) {
                console.log(`   🔄 Worker-${workerId} | Đổi proxy, thử lại ${chapterTitle} (lần ${attempts + 1})...`);
            }
        }
    }

    if (images && images.length > 0) {
        await saveChapter(comic, comicSlug, chapterNumber, chapterTitle, seoSlug, images, workerId);
        return 'success';
    }

    console.log(`   ❌ Worker-${workerId} | ${comic.title} - ${chapterTitle} thất bại sau ${maxAttempts} lần`);
    return 'failed';
}

// ================================================================
// CHẾ ĐỘ 2: Mỗi proxy giữ 1 truyện — Chrome reuse, dọn RAM định kỳ
// Dùng khi: số truyện cần cào > số proxy
// ================================================================
async function scrapeStoryWithReuse(storyInfo, proxyManager, workerId) {
    const { comic, comicSlug, info, chaptersToScrape, source } = storyInfo;

    let currentBrowser = null;
    let currentProxy = null;
    let chapsSinceBrowserOpen = 0;
    let lastProxyId = -1;
    let chaptersFound = 0;
    let errorMessage = '';

    for (let i = 0; i < chaptersToScrape.length; i++) {
        const cObj = chaptersToScrape[i];
        const matchNumber = cObj.title.match(/#(\d+(\.\d+)?)/);
        const chapterNumber = parseFloat(matchNumber[1]);
        const seoSlug = `chapter-${chapterNumber}`;
        const chapterTitle = `Chapter ${chapterNumber}`;

        // Mở Chrome mới nếu chưa có hoặc đã dùng quá N chap (dọn RAM)
        if (!currentBrowser || chapsSinceBrowserOpen >= MAX_CHAPTERS_PER_BROWSER) {
            if (currentBrowser) {
                await crawler.closeBrowser(currentBrowser);
                proxyManager.release(currentProxy);
                logMemory();
                console.log(`   🧹 Worker-${workerId} | Dọn RAM: đóng Chrome sau ${chapsSinceBrowserOpen} chap, mở lại...`);
            }

            currentProxy = await proxyManager.checkout(lastProxyId);
            lastProxyId = currentProxy.id;
            currentBrowser = await crawler.createBrowser(currentProxy);
            chapsSinceBrowserOpen = 0;
        }

        // Cào chapter bằng tab mới (reuse Chrome)
        let images = [];
        let attempts = 0;
        const maxAttempts = 3;

        while (attempts < maxAttempts && images.length === 0) {
            attempts++;

            if (attempts > 1) {
                // Fail → đóng Chrome cũ, đổi proxy ngay
                await crawler.closeBrowser(currentBrowser);
                proxyManager.markFailed(currentProxy);
                console.log(`   🔄 Worker-${workerId} | [Lần ${attempts}] Đổi proxy cho ${chapterTitle}...`);

                currentProxy = await proxyManager.checkout(lastProxyId);
                lastProxyId = currentProxy.id;
                currentBrowser = await crawler.createBrowser(currentProxy);
                chapsSinceBrowserOpen = 0;
            }

            try {
                console.log(`   📸 Worker-${workerId} | ${comic.title} [${chapterTitle}] Proxy [${currentProxy.ip}]`);
                images = await crawler.scrapeChapterImages(currentBrowser, cObj.url, currentProxy);
            } catch (err) {
                console.error(`   ❌ Worker-${workerId} | ${chapterTitle} lỗi: ${err.message}`);
                errorMessage = err.message;
            }
        }

        chapsSinceBrowserOpen++;

        if (images && images.length > 0) {
            await saveChapter(comic, comicSlug, chapterNumber, chapterTitle, seoSlug, images, workerId);
            chaptersFound++;
        } else {
            errorMessage = `Thất bại: ${chapterTitle} sau ${maxAttempts} lần`;
            console.log(`   ❌ Worker-${workerId} | ${errorMessage}`);
        }

        // Nghỉ ngẫu nhiên 3-8s giữa các chapter
        const sleep = Math.floor(Math.random() * 5000) + 3000;
        await new Promise(r => setTimeout(r, sleep));
    }

    // Đóng Chrome cuối cùng + trả proxy
    if (currentBrowser) {
        await crawler.closeBrowser(currentBrowser);
        proxyManager.release(currentProxy);
    }

    console.log(`   ✅ Worker-${workerId} | HOÀN THÀNH: ${info.title} (${chaptersFound} chương mới)`);
    return { chaptersFound, errorMessage };
}

// ================================================================
// KILL ZOMBIE
// ================================================================
function logMemory() {
    const used = process.memoryUsage();
    const rss = Math.round(used.rss / 1024 / 1024);
    const heap = Math.round(used.heapUsed / 1024 / 1024);
    console.log(`   💾 RAM: ${rss}MB (heap: ${heap}MB)`);
}

function killZombieChrome() {
    try {
        require('child_process').execSync(
            'taskkill /F /IM chrome.exe /T 2>nul',
            { stdio: 'ignore' }
        );
        console.log('🧹 Đã dọn Chrome zombie');
    } catch (e) {}
}

// ================================================================
// QUẢN LÝ DỌN DẸP TOÀN CỤC KHI ẤN CTRL+C TẮT NGANG
// ================================================================
const activeBrowsers = new Set();
// Can thiệp (Patch) lại hàm mở browser để đánh dấu các browser đang chạy
const originalCreateBrowser = crawler.createBrowser.bind(crawler);
crawler.createBrowser = async function (proxy) {
    const browser = await originalCreateBrowser(proxy);
    if (browser) activeBrowsers.add(browser);
    return browser;
};
const originalCloseBrowser = crawler.closeBrowser.bind(crawler);
crawler.closeBrowser = async function (browser) {
    if (browser) activeBrowsers.delete(browser);
    await originalCloseBrowser(browser);
};

// Lắng nghe sự kiện người dùng ấn Ctrl+C 
process.on('SIGINT', async () => {
    console.log('\n\n🛑 [HỆ THỐNG] Nhận lệnh dừng khẩn cấp (Ctrl+C)! Đang dọn dẹp RAM và thu hồi ổ cứng...');
    
    // Đóng toàn bộ browser đang mở theo vết mượt mà để chống crash
    for (const browser of activeBrowsers) {
        try {
            await crawler.closeBrowser(browser);
        } catch (e) {}
    }
    
    // 2. PHẢI KILL PROC: Dọn dẹp các tiến trình ngầm còn sót lại
    if (process.platform === 'win32') {
        const { execSync } = require('child_process');
        try {
            execSync('taskkill /F /IM chrome.exe /T 2>nul', { stdio: 'ignore' });
            console.log('🔫 [HỆ THỐNG] Đã ép tắt tiến trình Chrome ngầm để giũ bỏ khóa File...');
        } catch (e) {}
    }

    // Đợi nhẹ 1 giây cho Kernel của Windows chạy nốt lệnh nhả file
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 3. Tiến hành XÓA Ổ CỨNG vào các thư mục đã được thả khóa
    const os = require('os');
    const fs = require('fs');
    const path = require('path');
    const tmpDir = os.tmpdir();
    
    try {
        const files = fs.readdirSync(tmpDir);
        let deletedCount = 0;
        for (const file of files) {
            if (file.startsWith('crawler_')) {
                const targetPath = path.join(tmpDir, file);
                try {
                    // Dùng maxRetries để chày cối xóa (nếu khóa bị kẹt lâu)
                    fs.rmSync(targetPath, { 
                        recursive: true, 
                        force: true, 
                        maxRetries: 5, 
                        retryDelay: 300 
                    });
                    deletedCount++;
                } catch (rmErr) {}
            }
        }
        console.log(`🧹 [HỆ THỐNG] Đã vứt bỏ thành công ${deletedCount} thư mục (profile rác).`);
    } catch(e) {}

    console.log('✅ Hệ thống dọn dẹp thành công. Thoát cực kỳ an toàn!\n');
    process.exit(0);
});

// ================================================================
// MAIN
// ================================================================
async function startCrawl() {
    try {
        console.log("🚀 Đã tải Prisma và bắt đầu kết nối PostgreSQL.");

        const source = await getOrCreateSource();
        console.log(`📡 CrawlSource: ${source.name}`);

        const proxyString = process.env.PROXIES || process.env.PROXY_DATA;
        if (!proxyString) throw new Error("🚨 Thiếu PROXIES hoặc PROXY_DATA trong .env!");
        const proxyManager = new ProxyManager(proxyString);

        // --- BƯỚC MỚI: TỰ ĐỘNG CÀO 100 LINK TRUYỆN HOT NHẤT ---
        console.log(`\n--- Bắt đầu lấy danh sách ${MAX_STORIES_TO_CRAWL} truyện Hot nhất từ ${SCRAPE_LIST_URL} ---`);
        const initProxy = await proxyManager.checkout(-1);
        const initBrowser = await crawler.createBrowser(initProxy);
        
        try {
            storyUrls = await crawler.scrapeHotList(initBrowser, SCRAPE_LIST_URL, initProxy, MAX_STORIES_TO_CRAWL);
            console.log(`✅ Đã thu thập thành công ${storyUrls.length} link truyện để cào!`);
        } catch (err) {
            console.error(`🚨 Lỗi khi cào danh sách truyện: ${err.message}`);
        } finally {
            await crawler.closeBrowser(initBrowser);
            if (initProxy) proxyManager.release(initProxy);
        }

        if (storyUrls.length === 0) {
            console.error("🚨 Không có link truyện nào để cào. Dừng script!");
            return;
        }

        const concurrency = proxyManager.totalProxies;
        const totalBatches = Math.ceil(storyUrls.length / BATCH_SIZE);

        console.log(`⚡ ${concurrency} proxy | ${storyUrls.length} truyện | ${TARGET_CHAPTERS} chap/truyện`);

        for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
            const batchStart = batchIdx * BATCH_SIZE;
            const batchUrls = storyUrls.slice(batchStart, batchStart + BATCH_SIZE);

            console.log(`\n${'='.repeat(60)}`);
            console.log(`📦 BATCH ${batchIdx + 1}/${totalBatches} | ${batchUrls.length} truyện`);
            console.log(`${'='.repeat(60)}`);

            // ===== PHASE 1: Cào info =====
            console.log(`\n--- Phase 1: Cào info truyện ---`);
            const storyInfos = [];

            const infoPool = new WorkerPool(proxyManager, Math.min(concurrency, batchUrls.length));
            for (const url of batchUrls) {
                infoPool.addJob(async (pm, wId) => {
                    try {
                        const result = await scrapeStoryInfo(url, pm, source);
                        if (result) storyInfos.push(result);
                        return result ? 'success' : 'skipped';
                    } catch (err) {
                        console.error(`   ❌ Lỗi info ${url}: ${err.message}`);
                        return 'failed';
                    }
                });
            }
            await infoPool.run();

            if (storyInfos.length === 0) {
                console.log(`   ⚠️ Không có truyện nào cần cào trong batch này.`);
                continue;
            }

            // ===== Tạo CrawlJobs =====
            const crawlJobs = new Map();
            for (const si of storyInfos) {
                const job = await prisma.crawlJob.create({
                    data: {
                        sourceId: source.id,
                        comicId: si.comic.id,
                        type: 'FETCH_NEW_CHAPTERS',
                        status: 'RUNNING',
                        startedAt: new Date(),
                    }
                });
                crawlJobs.set(si.comic.id.toString(), { job, found: 0, error: '' });
            }

            // ===== PHASE 2: Chọn chế độ cào =====
            const storiesNeedScrape = storyInfos.filter(si => si.chaptersToScrape.length > 0);

            if (storiesNeedScrape.length <= concurrency) {
                // ───── CHẾ ĐỘ 1: Ít truyện ≤ proxy → queue chung, chia chapter ─────
                console.log(`\n--- Phase 2 [Chế độ 1]: ${storiesNeedScrape.length} truyện ≤ ${concurrency} proxy → Chia chapter cho tất cả proxy ---`);

                const chapterPool = new WorkerPool(proxyManager, concurrency);
                let totalChapterJobs = 0;

                for (const si of storiesNeedScrape) {
                    for (const cObj of si.chaptersToScrape) {
                        totalChapterJobs++;
                        chapterPool.addJob(async (pm, wId) => {
                            const result = await scrapeOneChapter({
                                comic: si.comic,
                                comicSlug: si.comicSlug,
                                cObj,
                                source: si.source,
                            }, pm, wId);

                            const tracker = crawlJobs.get(si.comic.id.toString());
                            if (result === 'success') tracker.found++;
                            else tracker.error = `Fail: ${cObj.title}`;
                            return result;
                        });
                    }
                }

                console.log(`   📋 ${totalChapterJobs} chapters → ${concurrency} proxy song song`);
                await chapterPool.run();

            } else {
                // ───── CHẾ ĐỘ 2: Nhiều truyện > proxy → mỗi proxy 1 truyện, Chrome reuse ─────
                console.log(`\n--- Phase 2 [Chế độ 2]: ${storiesNeedScrape.length} truyện > ${concurrency} proxy → Mỗi proxy 1 truyện, Chrome reuse (dọn RAM mỗi ${MAX_CHAPTERS_PER_BROWSER} chap) ---`);

                const storyPool = new WorkerPool(proxyManager, concurrency);

                for (const si of storiesNeedScrape) {
                    storyPool.addJob(async (pm, wId) => {
                        const { chaptersFound, errorMessage } = await scrapeStoryWithReuse(si, pm, wId);

                        const tracker = crawlJobs.get(si.comic.id.toString());
                        tracker.found = chaptersFound;
                        if (errorMessage) tracker.error = errorMessage;
                        return chaptersFound > 0 ? 'success' : 'failed';
                    });
                }

                await storyPool.run();
            }

            // ===== Cập nhật CrawlJobs + stats =====
            for (const si of storyInfos) {
                const tracker = crawlJobs.get(si.comic.id.toString());
                const totalChapters = await prisma.chapter.count({ where: { comicId: si.comic.id } });
                
                // Fetch stats, update views/total chapters
                const comicData = await prisma.comic.findUnique({ where: { id: si.comic.id } });
                let latestChaptersRaw = si.comic.latestChapters || [];
                if (typeof latestChaptersRaw === 'string') latestChaptersRaw = JSON.parse(latestChaptersRaw);

                await prisma.comic.update({
                    where: { id: si.comic.id },
                    data: {
                        lastCrawledAt: new Date(),
                    }
                });

                const status = tracker.found > 0 ? 'COMPLETED' : (tracker.error ? 'FAILED' : 'COMPLETED');
                
                await prisma.crawlJob.update({
                    where: { id: tracker.job.id },
                    data: {
                        status: status,
                        completedAt: new Date(),
                        result: {
                            chapters_found: tracker.found,
                            images_uploaded: 0,
                            error_message: status === 'FAILED' ? tracker.error : '',
                        }
                    }
                });

                console.log(`   📊 ${si.info.title} | ${tracker.found} chap mới | ${status}`);
            }

            killZombieChrome();

            if (batchIdx < totalBatches - 1) {
                const restMinutes = REST_BETWEEN_BATCHES / 60000;
                console.log(`\n😴 Nghỉ ${restMinutes} phút trước batch tiếp...`);
                await new Promise(r => setTimeout(r, REST_BETWEEN_BATCHES));
            }
        }

        await updateGenreCounts();
        console.log("\n🏁 TẤT CẢ BATCH ĐÃ CHẠY XONG.");
        process.exit(0);

    } catch (err) {
        console.error("💥 LỖI:", err.message);
        killZombieChrome();
        process.exit(1);
    }
}

startCrawl();
