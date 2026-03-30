const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { createCursor } = require('ghost-cursor');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const os = require('os');
const FingerprintManager = require('./fingerprintManager');

puppeteer.use(StealthPlugin());

const BROWSER_ARGS = [
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',

    // === CHỐNG LỘ IP THẬT ===
    '--disable-webrtc',
    '--enforce-webrtc-ip-handling-policy',
    '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--disable-features=WebRtcHideLocalIpsWithMdns',

    // === CHỐNG DNS LEAK ===
    '--dns-prefetch-disable',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost',

    // === THÊM ẨN DANH ===
    '--disable-background-networking',
    '--disable-client-side-phishing-detection',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--no-first-run',

    // === GIẢM RAM ===
    '--disable-gpu',                     // Tắt GPU (headless không cần)
    '--disable-software-rasterizer',
    '--disable-translate',
    '--disable-hang-monitor',
    '--disable-popup-blocking',
    '--disable-prompt-on-repost',
    '--metrics-recording-only',
    '--no-zygote',                       // Giảm process con
    '--js-flags=--max-old-space-size=256', // Giới hạn JS heap 256MB
];

class CrawlerService {
    constructor() {
        this.fingerprintManager = new FingerprintManager();
    }

    /**
     * Mở Chrome 1 lần với proxy (dùng lại cho nhiều tab)
     */
    async createBrowser(proxy) {
        const args = [...BROWSER_ARGS];
        if (proxy) {
            args.push(`--proxy-server=http://${proxy.ip}:${proxy.port}`);

            const isHostname = proxy.ip && !/^\d+\.\d+\.\d+\.\d+$/.test(proxy.ip);
            if (isHostname) {
                const idx = args.findIndex(a => a.startsWith('--host-resolver-rules='));
                if (idx !== -1) {
                    args[idx] = `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE ${proxy.ip}`;
                }
            }
        }

        // Tạo thư mục profile tạm (sẽ xóa khi đóng Chrome)
        const tmpDir = path.join(os.tmpdir(), `crawler_${Date.now()}_${Math.random().toString(36).slice(2)}`);

        const browser = await puppeteer.launch({
            headless: "new",
            args,
            userDataDir: tmpDir,
            handleSIGINT: false,
            handleSIGTERM: false,
            handleSIGHUP: false
        });

        // Gắn đường dẫn profile để closeBrowser xóa
        browser._tmpProfileDir = tmpDir;

        console.log(`   🚀 Chrome mở với Proxy [${proxy ? proxy.ip : 'direct'}]`);
        return browser;
    }

    /**
     * Đóng Chrome an toàn
     */
    async closeBrowser(browser) {
        try {
            if (!browser) return;

            const tmpDir = browser._tmpProfileDir;

            // Kill process trước
            const proc = browser.process();
            if (proc) {
                proc.kill('SIGKILL');
            }

            await browser.close().catch(() => {});

            // Xóa thư mục profile tạm (dọn ~78MB rác/lần)
            if (tmpDir && fs.existsSync(tmpDir)) {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        } catch (e) {
            // Chrome đã đóng hoặc crash, bỏ qua
        }
    }

    /**
     * Mở tab mới trong browser đã có, inject fingerprint mới
     */
    async openTab(browser, url, proxy) {
        const fpData = this.fingerprintManager.generate();

        const page = await browser.newPage();

        try {
            // Xóa cookies + cache cho tab mới
            const client = await page.target().createCDPSession();
            await client.send('Network.clearBrowserCookies');
            await client.send('Network.clearBrowserCache');

            // Xác thực proxy
            if (proxy && proxy.user && proxy.pass) {
                await page.authenticate({ username: proxy.user, password: proxy.pass });
            }

            // Inject fingerprint mới cho mỗi tab
            await this.fingerprintManager.inject(page, fpData);

            await page.emulateTimezone('America/New_York');

            // Sửa thành domcontentloaded để lướt qua nhanh các redirect của hệ thống chống bot
            await page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: 60000,
            });
            
            // Chờ một chút phòng khi Cloudflare hay mangahub load JavaScript
            await new Promise(r => setTimeout(r, 5000));

            const cursor = createCursor(page);
            return { page, cursor, releaseFingerprint: fpData.release };

        } catch (err) {
            fpData.release();
            await page.close().catch(() => {});
            throw err;
        }
    }

    _parseStatus(raw) {
        const s = (raw || '').toLowerCase();
        if (s.includes('complete')) return 'completed';
        if (s.includes('hiatus')) return 'hiatus';
        if (s.includes('drop') || s.includes('cancel')) return 'dropped';
        return 'ongoing';
    }

    async autoScroll(page) {
        await page.evaluate(async () => {
            await new Promise((resolve) => {
                let totalHeight = 0;
                let distance = 300;
                let timer = setInterval(() => {
                    window.scrollBy(0, distance);
                    totalHeight += distance;
                    if (totalHeight >= document.body.scrollHeight) {
                        clearInterval(timer);
                        resolve();
                    }
                }, 200);
            });
        });
    }

    /**
     * Cào thông tin truyện (dùng browser đã mở)
     */
    async scrapeStoryInfo(browser, url, proxy) {
        const { page, releaseFingerprint } = await this.openTab(browser, url, proxy);
        try {
            const html = await page.content();
            const $ = cheerio.load(html);

            const titleText = $('h1._3xnDj').contents().filter(function () { return this.nodeType === 3; }).text().trim().replace(/"/g, '');
            // Lấy alt_titles và tách thành mảng theo dấu chấm phẩy
            const altTitleText = $('h1._3xnDj small').text().trim().replace(/"/g, '');
            const altTitles = altTitleText ? altTitleText.split(';').map(t => t.trim()).filter(Boolean) : [];
            
            const descText = $('#chapters-tab-pane-999 p.ZyMp7').text().trim() || $('div._3Iyzg, div.fullcontent').text().trim() || '';

            // Tách tác giả và hoạ sĩ theo dấu phẩy hoặc chấm phẩy
            const rawAuthor = $('span:contains("Author")').next().text().trim();
            const authorsList = rawAuthor ? rawAuthor.split(/[,;]/).map(t => t.trim()).filter(Boolean) : ["MangaHub"];

            const rawArtist = $('span:contains("Artist")').next().text().trim();
            const artistsList = rawArtist ? rawArtist.split(/[,;]/).map(t => t.trim()).filter(Boolean) : [];

            const info = {
                title: titleText,
                alt_titles: altTitles,
                author: authorsList,
                artist: artistsList,
                thumbnail: $('img.img-responsive').attr('src'),
                description: descText,
                status: this._parseStatus($('span:contains("Status")').next().text().trim()),
                genres: [],
                slug: url.split('/').filter(Boolean).pop(),
                chapterLinks: []
            };

            $('a[href*="/genre/"]').each((_, el) => {
                const genreName = $(el).text().trim();
                if (genreName) info.genres.push(genreName);
            });
            info.genres = [...new Set(info.genres)];

            const chapterMap = new Map();

            $('.tab-content .tab-pane a').each((_, el) => {
                const href = $(el).attr('href');
                const rawTitle = $(el).text().trim();
                if (href && href.includes('/chapter')) {
                    const fullLink = href.startsWith('http') ? href : `https://mangahub.io${href}`;
                    const match = rawTitle.match(/#(\d+(\.\d+)?)/);
                    const chapNum = match ? match[1] : null;

                    if (chapNum) {
                        if (!chapterMap.has(chapNum) || fullLink.length < chapterMap.get(chapNum).url.length) {
                            chapterMap.set(chapNum, { url: fullLink, title: rawTitle });
                        }
                    }
                }
            });

            const sortedChapters = Array.from(chapterMap.values()).sort((a, b) => {
                const numA = parseFloat(a.title.match(/#(\d+(\.\d+)?)/)[1]);
                const numB = parseFloat(b.title.match(/#(\d+(\.\d+)?)/)[1]);
                return numA - numB;
            });

            info.chapterLinks = sortedChapters;
            return info;
        } finally {
            releaseFingerprint();
            await page.close().catch(() => {});
        }
    }

    /**
     * Cào ảnh chapter (dùng browser đã mở, chỉ mở tab mới)
     */
    async scrapeChapterImages(browser, url, proxy) {
        const { page, releaseFingerprint } = await this.openTab(browser, url, proxy);
        try {
            await new Promise(r => setTimeout(r, 5000));

            await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button, a, div'));
                const startBtn = buttons.find(b =>
                    b.innerText.includes('Start Reading') ||
                    b.innerText.includes('Confirm') ||
                    b.innerText.includes('Continue')
                );
                if (startBtn) startBtn.click();
            }).catch(() => {});

            const readerFound = await page.waitForSelector('#mangareader', { timeout: 30000 }).catch(() => null);

            if (!readerFound) {
                const fs = require('fs');
                if (!fs.existsSync('./debug')) fs.mkdirSync('./debug');
                const debugName = `fail_${url.split('/').pop()}.png`;
                await page.screenshot({ path: `./debug/${debugName}`, fullPage: false });
                console.log(`   ⚠️ Không thấy khung đọc. Đã chụp ảnh lỗi: ${debugName}`);
                return [];
            }

            await this.autoScroll(page);
            const html = await page.content();
            const $ = cheerio.load(html);
            const images = [];

            $('#mangareader img').each((_, el) => {
                const src = $(el).attr('src');
                if (src && src.startsWith('http') && !src.includes('logo')) {
                    images.push(src.trim());
                }
            });

            return images;
        } catch (e) {
            console.error("   ❌ Lỗi:", e.message);
            return [];
        } finally {
            releaseFingerprint();
            await page.close().catch(() => {});
        }
    }

    /**
     * Cào danh sách truyện Hot từ trang popular (ví dụ MangaHub)
     */
    async scrapeHotList(browser, url, proxy, limit = 100) {
        let allLinks = [];
        let pageNum = 1;

        while (allLinks.length < limit) {
            const pageUrl = `${url}?page=${pageNum}`;
            console.log(`   🔎 Đang quét link từ trang: ${pageUrl}`);
            
            let tabData = null;
            // Thêm cơ chế retry mở tab để vượt lỗi "Navigating frame was detached"
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    tabData = await this.openTab(browser, pageUrl, proxy);
                    break; // Thành công thì thoát vòng lặp retry
                } catch (e) {
                    console.error(`   ⚠️ Mở tab lỗi (lần ${attempt}): ${e.message}`);
                    await new Promise(r => setTimeout(r, 3000)); // Đợi 3s rồi retry
                }
            }

            if (!tabData) {
                console.error(`   ❌ Đã thử 3 lần nhưng không thể mở trang ${pageUrl}. Bỏ qua cào danh sách.`);
                break;
            }

            const { page, releaseFingerprint } = tabData;

            try {
                // Đợi load thẻ body tránh việc page trắng
                await page.waitForSelector('body', { timeout: 30000 });
                
                // Trượt xuống một chút để kích hoạt lazy loading nếu có
                await page.evaluate(() => window.scrollBy(0, 1000));
                await new Promise(r => setTimeout(r, 1000));

                const html = await page.content();
                const $ = cheerio.load(html);
                
                const frameLinks = [];
                // Cào theo đúng cấu trúc F12 bạn vừa gửi (.media-manga a)
                $('.media-manga a').each((i, el) => {
                    let href = $(el).attr('href');
                    if (href && href.includes('/manga/') && !href.includes('/chapter') && !href.includes('#')) {
                        // Mangahub có khi dùng domain tương đối
                        if (!href.startsWith('http')) {
                            href = new URL(href, 'https://mangahub.io').href;
                        }
                        if (!allLinks.includes(href) && !frameLinks.includes(href)) {
                            frameLinks.push(href);
                        }
                    }
                });

                if (frameLinks.length === 0) {
                    console.log(`   ⚠️ Không tìm thấy link truyện. Có thể do lỗi mạng hoặc chặn bot.`);
                    break; 
                }

                allLinks.push(...frameLinks);
                console.log(`   ➕ Lấy được ${frameLinks.length} link truyện ở trang ${pageNum}. Tổng: ${allLinks.length}/${limit}`);
                
            } catch (error) {
                console.error(`   ❌ Lỗi khi quét danh sách trang ${pageNum}: ${error.message}`);
                break;
            } finally {
                releaseFingerprint();
                await page.close().catch(() => {});
            }

            pageNum++;
            await new Promise(r => setTimeout(r, 2000)); // Delay tránh bị quá tải request
        }

        return allLinks.slice(0, limit);
    }
}

module.exports = new CrawlerService();
