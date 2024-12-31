// 添加全局变量声明
let scanCancelled = false;
let invalidBookmarks = [];
let emptyFolders = [];
let totalBookmarks = 0;
let invalidBookmarksCount = 0;
let isScanning = false;
let selectedBookmarks = new Set();
let scanStartTime = 0;
let scanDurationInterval;

// 配置选项
const CONFIG = {
    batchSize: 30,  // 每批检查的书签数量
    validProtocols: ['chrome:', 'chrome-extension:', 'file:', 'javascript:', 'data:', 'about:', 'edge:', 'brave:']
    // 移除 requestDelay
};

// 在文件开头添加获取本地化消息的辅助函数
function getMessage(messageName, substitutions = null) {
    return chrome.i18n.getMessage(messageName, substitutions);
}

// 统一的更新函数
function updateInvalidBookmarksCount() {
    invalidBookmarksCount = invalidBookmarks.length;
    const invalidLinksEl = document.getElementById('invalid-links');
    if (invalidLinksEl) {
        invalidLinksEl.textContent = invalidBookmarksCount;
    }
}



// 添加失效类型筛选相关变量
let currentFilter = 'all'; // 当前筛选类型
const errorTypes = new Set(); // 存储所有出现的错误类型

// 添加错误消息映射函数
function getLocalizedErrorMessage(error) {
    // 处理 HTTP 错误
    if (error.startsWith('HTTP Error:')) {
        const code = error.match(/\d+/)[0];
        switch (code) {
            // 4xx 客户端错误
            case '400': return getMessage('errorType_badRequest');
            case '401': return getMessage('errorType_unauthorized');
            case '403': return getMessage('errorType_forbidden');
            case '404': return getMessage('errorType_pageNotFound');
            case '405': return getMessage('errorType_methodNotAllowed');
            case '408': return getMessage('errorType_requestTimeout');
            case '418': return getMessage('errorType_teapot');           // 彩蛋状态码
            case '429': return getMessage('errorType_tooManyRequests');
            
            // 5xx 服务器错误
            case '500': return getMessage('errorType_serverError');
            case '502': return getMessage('errorType_badGateway');
            case '503': return getMessage('errorType_serviceUnavailable');
            case '504': return getMessage('errorType_gatewayTimeout');
            
            // 非标准状态码
            case '777': return getMessage('errorType_nonStandard777');
            case '468': return getMessage('errorType_nonStandard468');
            
            default: return `HTTP Error: ${code}`; // 对于未定义的状态码返回原始错误
        }
    }

    // 处理其他常见错误
    const errorMap = {
        'Request Timeout': getMessage('errorType_requestTimeout'),
        'Site blocks automated access but might be accessible in browser': getMessage('errorType_accessDenied'),
        'Site has certificate issues but might be accessible': getMessage('errorType_sslError'),
        'net::ERR_NAME_NOT_RESOLVED': getMessage('errorType_dnsError'),
        'net::ERR_CONNECTION_REFUSED': getMessage('errorType_connectionError'),
        'net::ERR_CONNECTION_TIMED_OUT': getMessage('errorType_requestTimeout'),
        'net::ERR_TOO_MANY_REDIRECTS': getMessage('errorType_tooManyRedirects'),  // 使用本地化消息
        'net::ERR_CERT_AUTHORITY_INVALID': getMessage('errorType_sslError')
    };

    // 如果有映射就使用映射，否则保留原始错误
    return errorMap[error] || error;
}




// 添加更新全选按钮状态的函数
function updateSelectAllButtonState() {
    const selectAllBtn = document.getElementById('select-all');
    const checkboxes = document.querySelectorAll('.bookmark-checkbox');
    
    if (selectAllBtn && checkboxes.length > 0) {
        const isAllSelected = Array.from(checkboxes).every(cb => cb.checked);
        
        // 获取按钮内的 span 元素
        let span = selectAllBtn.querySelector('span[data-i18n]');
        
        // 如果没有找到带有 data-i18n 属性的 span，则创建一个
        if (!span) {
            span = document.createElement('span');
            span.setAttribute('data-i18n', 'selectAll');
            selectAllBtn.textContent = ''; // 清空按钮文本
            selectAllBtn.appendChild(span);
        }
        
        // 根据选中状态设置合适的国际化消息
        const messageKey = isAllSelected ? 'deselectAll' : 'selectAll';
        span.setAttribute('data-i18n', messageKey);
        span.textContent = chrome.i18n.getMessage(messageKey);
        
        // 设置按钮状态
        selectAllBtn.disabled = checkboxes.length === 0;
    }
}

// 添加更新删除按钮状态的函数
function updateDeleteButtonState() {
    const deleteSelectedBtn = document.getElementById('delete-selected');
    if (deleteSelectedBtn) {
        // 禁用或启用删除按钮，取决于是否有选中的项目
        deleteSelectedBtn.disabled = selectedBookmarks.size === 0;
        // 更新按钮样式
        if (selectedBookmarks.size === 0) {
            deleteSelectedBtn.classList.add('disabled');
        } else {
            deleteSelectedBtn.classList.remove('disabled');
        }
    }
}

// 添加初始化进度环的函数
function initializeProgressRing() {
    const container = document.querySelector('.scan-container');
    const progressText = document.querySelector('.progress-text');
    const progressRing = document.querySelector('.progress-ring-circle');
    const progressStatus = document.querySelector('.progress-status');
    
    const radius = 70;
    const circumference = 2 * Math.PI * radius;
    
    // 设置初始状态
    if (progressRing) {
        progressRing.style.strokeDasharray = `${circumference} ${circumference}`;
        progressRing.style.strokeDashoffset = circumference;
    }
    
    // 重置文本
    if (progressText) {
        progressText.textContent = '0%';
        progressText.style.opacity = '1';
    }
    
    // 清空状态文本但不设置透明度
    if (progressStatus) {
        progressStatus.textContent = '';
    }
    
    if (container) {
        container.classList.remove('scanning');
        container.classList.remove('scan-complete');
    }
}

// 修改 DOMContentLoaded 事件处理，合并两个监听器
document.addEventListener('DOMContentLoaded', async () => {
    // 初始化本地化文本
    document.querySelectorAll('[data-i18n]').forEach(element => {
        const message = element.getAttribute('data-i18n');
        const localizedText = chrome.i18n.getMessage(message);
        if (localizedText) {
            element.textContent = localizedText;
        } else {
            console.warn(`Missing translation for: ${message}`);
        }
    });

    // 初始化DOM元素
    const scanButton = document.getElementById('scan-button');
    const loadingDiv = document.getElementById('loading');
    const resultsDiv = document.getElementById('results');
    const totalBookmarksEl = document.getElementById('total-bookmarks');
    const scannedBookmarksEl = document.getElementById('scanned-bookmarks');
    const invalidLinksEl = document.getElementById('invalid-links');
    const emptyFoldersEl = document.getElementById('empty-folders');
    const buttonText = scanButton.querySelector('.button-text');
    
    // 设置初始文案
    buttonText.textContent = chrome.i18n.getMessage('scanBookmarks');
    
    // 初始化显示
    scannedBookmarksEl.textContent = '0';
    totalBookmarksEl.textContent = '-';
    invalidLinksEl.textContent = '0';
    emptyFoldersEl.textContent = '0';
    createMovingCat();
    // 初始化时获取并显示总书签数
    try {
        const tree = await chrome.bookmarks.getTree();
        totalBookmarks = await countCheckableBookmarks(tree[0]);
        
        // 更新显示
        if (scannedBookmarksEl && totalBookmarksEl) {
            scannedBookmarksEl.textContent = '0';
            totalBookmarksEl.textContent = totalBookmarks;
        }
    } catch (error) {
        console.error('Error initializing bookmarks:', error);
        if (scannedBookmarksEl && totalBookmarksEl) {
            scannedBookmarksEl.textContent = '-';
            totalBookmarksEl.textContent = '-';
        }
    }

    // 初始化进度环显示
    initializeProgressRing();

    // 初始化批量操作按钮
    initBatchActions();

    // 添加取消扫描的文本
    scanButton.setAttribute('data-scan-text', chrome.i18n.getMessage('scanning', 'Scanning...'));
    scanButton.setAttribute('data-cancel-text', chrome.i18n.getMessage('cancelScan', 'Cancel'));
    
    let scanCancelled = false;
    
    scanButton.addEventListener('click', async () => {
        const container = document.querySelector('.scan-container');
        
        // 如果正在扫描，则取消扫描
        if (container.classList.contains('scanning')) {
            scanCancelled = true;
            container.classList.remove('scanning');
            
            // 取消扫描时重置计时器
            cancelScan();
            
            // 更改按钮样式为取消状态
            scanButton.classList.remove('cancel');
            // 重置按钮文案
            buttonText.textContent = chrome.i18n.getMessage('scanBookmarks');
            
            // 重置所有状态和显示
            resetScanState();
            // 重置所有数据
            resetScanData();
            return;
        }
        
        // 开始新扫描前重置所有数据
        resetScanData();
        
        // 初始化计时器
        scanStartTime = Date.now();
        scanDurationInterval = setInterval(updateScanDuration, 1000);
        
        // 开始扫描时更改按钮文案和样式
        buttonText.textContent = chrome.i18n.getMessage('cancelScan');
        scanButton.classList.add('cancel');
        
        try {
            isScanning = true;
            scanButton.classList.add('disabled');
            loadingDiv.style.display = 'block';
            
            // 使用本地化消息设置初始状态文本
            document.querySelector('.progress-status').textContent = 
                chrome.i18n.getMessage('scanning', 'Scanning...');
            
            // 禁用删除和全选按钮
            disableBatchActions();
            
            // 创建或清空无效列表容器
            let invalidList = document.getElementById('invalidList');
            if (!invalidList) {
                invalidList = document.createElement('div');
                invalidList.id = 'invalidList';
                invalidList.className = 'results';
                document.querySelector('.container').appendChild(invalidList);
            } else {
                invalidList.innerHTML = '';
            }
            
            // 隐藏批量操作按钮
            document.querySelector('.batch-actions').style.display = 'none';
            
            // 获取书签树并开始扫描
            const tree = await chrome.bookmarks.getTree();
            const bookmarkCount = await countCheckableBookmarks(tree[0]);
            showMovingCat();
            
            // 在扫描过程中定期检查是否取消
            await scanBookmarks(tree[0], [], { 
                count: 0, 
                total: bookmarkCount,
                shouldCancel: () => scanCancelled 
            });
            
            // 扫描完成后的处理
            if (!scanCancelled) {  // 只在非取消状态下显示结果
                if (invalidBookmarks.length > 0 || emptyFolders.length > 0) {
                    const batchActions = document.querySelector('.batch-actions');
                    batchActions.style.display = 'flex';
                    initBatchActions();
                    createFilterTags();
                } else {
                    invalidList.innerHTML = `
                        <div class="result-item">
                            <div style="color: #34C759">${chrome.i18n.getMessage('allValid')}</div>
                        </div>
                    `;
                }
            }
            
        } catch (error) {
            console.error('Error during scan:', error);
            if (!scanCancelled) {  // 只在非取消状态下显示错误
                const invalidList = document.getElementById('invalidList');
                if (invalidList) {
                    invalidList.innerHTML = `
                        <div class="result-item">
                            <div style="color: var(--system-red)">
                                ${chrome.i18n.getMessage('errorScanning', [error.message])}
                            </div>
                        </div>
                    `;
                }
            }
        } finally {
            isScanning = false;
            scanButton.classList.remove('disabled');
            loadingDiv.style.display = 'none';
            
            // 如果是被取消的，显示取消消息
            if (scanCancelled) {
                const invalidList = document.getElementById('invalidList');
                if (invalidList) {
                    invalidList.innerHTML = `
                        <div class="result-item">
                            <div style="color: var(--system-gray)">
                                ${chrome.i18n.getMessage('scanCancelled', 'Scan cancelled')}
                            </div>
                        </div>
                    `;
                }
                // 重置进度环到初始状态
                initializeProgressRing();
            }
            // 扫描完成或出错时恢复按钮文案和样式
            buttonText.textContent = chrome.i18n.getMessage('scanBookmarks');
            scanButton.classList.remove('cancel');
            
            // 扫描结束时停止计时
            if (!scanCancelled) {
                finishScan();
            }
        }
    });

    // 确保 DOM 加载完成
    document.addEventListener('DOMContentLoaded', () => {
        // 创建容器（如果不存在）
        let invalidList = document.getElementById('invalidList');
        if (!invalidList) {
            invalidList = document.createElement('div');
            invalidList.id = 'invalidList';
            invalidList.className = 'results';
            
            // 找到合适的父容器来添加
            const container = document.querySelector('.container');
            if (container) {
                container.appendChild(invalidList);
            }
        }
    });
});

async function scanBookmarks(node, path = [], counter = { count: 0, total: 0 }) {
    try {
        if (counter.shouldCancel()) {
            throw new Error('Scan cancelled');
        }
        
        if (node.children) {
            const currentPath = [...path, node.title];
            let hasBookmarks = false;
            let hasBookmarksInSubfolders = false;
            let bookmarksToCheck = [];

            // 遍历子节点
            for (const child of node.children) {
                if (child.url) {
                    hasBookmarks = true;
                    bookmarksToCheck.push({
                        id: child.id,
                        title: child.title,
                        url: child.url,
                        path: currentPath
                    });
                } else {
                    const subfoldersHasBookmarks = await scanBookmarks(child, currentPath, counter);
                    hasBookmarksInSubfolders = hasBookmarksInSubfolders || subfoldersHasBookmarks;
                }
            }

            // 检查收集到的书签
            if (bookmarksToCheck.length > 0) {
                const { results } = await checkBookmarksInBatch(bookmarksToCheck, counter);
                
                if (results && Array.isArray(results)) {
                    results.forEach(({ bookmark, isValid, reason }) => {
                        if (!isValid) {
                            addInvalidBookmark(bookmark, reason);
                        }
                    });
                }
            }

            // 空文件夹判断：当前文件夹没有书签且子文件夹都是空的
            if (!hasBookmarks && !hasBookmarksInSubfolders && node.id && node.title) {
                if (!isSpecialFolder(node.id)) {
                    // 避免重复添加
                    if (!emptyFolders.some(folder => folder.id === node.id)) {
                        emptyFolders.push({
                            id: node.id,
                            title: node.title,
                            path: currentPath
                        });
                        addEmptyFolder({
                            id: node.id,
                            title: node.title,
                            path: currentPath
                        });
                    }
                }
            }

            // 更新空文件夹计数显示
            const emptyFoldersEl = document.getElementById('empty-folders');
            if (emptyFoldersEl) {
                emptyFoldersEl.textContent = emptyFolders.length;
            }

            return hasBookmarks || hasBookmarksInSubfolders;
        } else if (node.url) {
            // 只有当 URL 不在有效协议列表中时才增加计数
            if (!CONFIG.validProtocols.some(protocol => node.url.startsWith(protocol))) {
                counter.count++;
                
                // 更新已扫描书签数显示
                const scannedBookmarksEl = document.getElementById('scanned-bookmarks');
                if (scannedBookmarksEl) {
                    scannedBookmarksEl.textContent = counter.count;
                }
                
                updateProgress(counter.count, counter.total);
                
                try {
                    const result = await chrome.runtime.sendMessage({
                        type: 'checkUrl',
                        url: node.url
                    });
                    
                    if (!result.isValid) {
                        addInvalidBookmark({
                            id: node.id,
                            title: node.title,
                            url: node.url,
                            path: path
                        }, result.reason);
                    }
                } catch (error) {
                    console.error('Error checking URL:', error);
                }
            }
        }
    } catch (error) {
        if (error.message === 'Scan cancelled') {
            console.log('Scanning cancelled by user');
        } else {
            console.error('Error scanning bookmarks:', error);
            handleError(error);
        }
    }
}

async function checkBookmarksInBatch(bookmarks, counter, batchSize = CONFIG.batchSize) {
    const results = [];
    const retryBookmarks = new Map();
    
    for (let i = 0; i < bookmarks.length; i += batchSize) {
        if (i > 0) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        const batch = bookmarks.slice(i, i + batchSize);
        const checks = batch.map(async bookmark => {
            try {
                const result = await chrome.runtime.sendMessage({
                    type: 'checkUrl',
                    url: bookmark.url
                });

                counter.count++;
                
                // 更新已扫描书签数显示
                const scannedBookmarksEl = document.getElementById('scanned-bookmarks');
                if (scannedBookmarksEl) {
                    scannedBookmarksEl.textContent = counter.count;
                }
                
                updateProgress(counter.count, counter.total);
                
                if (result.needsRetry) {
                    retryBookmarks.set(bookmark.url, bookmark);
                    return { bookmark, pending: true };
                }
                
                return { bookmark, ...result };
            } catch (error) {
                console.error('Error checking bookmark:', bookmark.url, error);
                return { 
                    bookmark, 
                    isValid: false, 
                    reason: error.message || 'Check failed' 
                };
            }
        });
        
        const batchResults = await Promise.all(checks);
        results.push(...batchResults.filter(r => !r.pending));
    }
    
    // 等待并处理重试结果
    if (retryBookmarks.size > 0) {
        console.log(`Waiting for ${retryBookmarks.size} retries to complete...`);
        await new Promise(resolve => setTimeout(resolve, 3000)); // 给重试充足时间
        
        // 检查重试结果
        for (const [url, bookmark] of retryBookmarks.entries()) {
            if (!results.some(r => r.bookmark.url === url)) {
                // 如果重试后仍然没有结果，标记为失败
                results.push({
                    bookmark,
                    isValid: false,
                    reason: 'Retry failed or timed out'
                });
            }
        }
    }
    
    // 确保更新最终统计
    updateStats();
    
    return { 
        results, 
        retryBookmarks,
        totalProcessed: counter.count,
        totalInvalid: results.filter(r => !r.isValid).length
    };
    showMovingCat();
}

// 辅助函数：判断是否为特殊文件夹
function isSpecialFolder(id) {
    const specialIds = ['0', '1', '2', '3'];  // 根文件夹、书签栏、其他书签、移动设备书签
    return specialIds.includes(id);
}

function addInvalidBookmark(bookmark, reason) {
    const invalidList = document.getElementById('invalidList');
    if (!invalidList) return;

    const item = document.createElement('div');
    item.className = 'result-item';
    
    // 创建复选框
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'bookmark-checkbox';
    checkbox.setAttribute('data-id', bookmark.id);
    
    checkbox.addEventListener('change', (e) => {
        if (isScanning) {
            e.preventDefault();
            checkbox.checked = !checkbox.checked;
            return;
        }
        
        if (e.target.checked) {
            selectedBookmarks.add(bookmark.id);
            item.classList.add('selected');
        } else {
            selectedBookmarks.delete(bookmark.id);
            item.classList.remove('selected');
        }
        updateDeleteButtonState();
        updateSelectAllButtonState(); // 确保在这里也更新全选按钮状态
    });

    // 创建其他元素
    const title = document.createElement('div');
    title.className = 'bookmark-title';
    title.textContent = bookmark.title;

    const urlDiv = document.createElement('div');
    urlDiv.className = 'bookmark-url';
    const urlLink = document.createElement('a');
    urlLink.href = bookmark.url;
    urlLink.textContent = bookmark.url;
    urlLink.target = '_blank';
    urlDiv.appendChild(urlLink);

    const path = document.createElement('div');
    path.className = 'bookmark-path';
    path.textContent = bookmark.path.join(' > ');

    // 创建错误原因标签时使用本地化的错误消息
    const reasonTag = document.createElement('div');
    reasonTag.className = 'bookmark-reason';
    reasonTag.textContent = getLocalizedErrorMessage(reason);
    
    // 添加 title 属性作为 tooltip
    reasonTag.title = getErrorExplanation(reason);

    // 组装 DOM
    item.appendChild(checkbox);
    item.appendChild(title);
    item.appendChild(urlDiv);
    item.appendChild(path);
    item.appendChild(reasonTag);
    
    invalidList.appendChild(item);
    
    // 更新计数
    invalidBookmarks.push(bookmark);
    updateInvalidBookmarksCount();
    updateSelectAllButtonState();
}

function updateProgress(current, total) {
    const container = document.querySelector('.scan-container');
    const progressText = document.querySelector('.progress-text');
    const progressRing = document.querySelector('.progress-ring-circle');
    const progressStatus = document.querySelector('.progress-status');
    
    // 确保 current 不超过 total
    current = Math.min(current, total);
    
    // 计算百分比，使用更精确的计算方式
    const percentage = (current / total) * 100;
    const roundedPercentage = Math.round(percentage);
    
    // 修正圆环计算
    // SVG circle 的 r 属性是 70（来自 HTML），所以这里要匹配
    const radius = 70;
    const circumference = 2 * Math.PI * radius;
    
    // 计算精确的偏移量
    const offset = circumference - (percentage / 100) * circumference;
    
    // 使用 requestAnimationFrame 使动画更平滑
    requestAnimationFrame(() => {
        // 设置圆环属性
        progressRing.style.strokeDasharray = `${circumference} ${circumference}`;
        progressRing.style.strokeDashoffset = offset;
        
        // 更新文本显示
        progressText.style.opacity = '1';
        progressText.textContent = `${roundedPercentage}%`;
        
        // 使用本地化消息更新状态文本
        if (progressStatus) {
            // 添加 scanning 和 complete 的本地化消息到 messages.json
            const statusMessage = roundedPercentage < 100 ? 
                chrome.i18n.getMessage('scanning', 'Scanning...') : 
                chrome.i18n.getMessage('complete', 'Complete');
            progressStatus.textContent = statusMessage;
        }
        
        // 添加扫描中的类
        container.classList.add('scanning');
        
        // 只在真正完成时处理完成状态
        if (Math.abs(percentage - 100) < 0.1) {
            container.classList.add('scan-complete');
            setTimeout(() => {
                container.classList.remove('scanning');
                container.classList.remove('scan-complete');
            }, 1000);
        }
    });
}

// 数字动画函数
function animateNumber(element, start, end) {
    const duration = 500; // 动画持续时间（毫秒）
    const startTime = performance.now();
    
    function updateNumber(currentTime) {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        
        // 使用 easeOutQuad 缓动函数使动画更自然
        const easeProgress = 1 - (1 - progress) * (1 - progress);
        const current = Math.round(start + (end - start) * easeProgress);
        
        element.textContent = current;
        
        if (progress < 1) {
            requestAnimationFrame(updateNumber);
        }
    }
    
    requestAnimationFrame(updateNumber);
}

function updateStats() {
    const totalBookmarksEl = document.getElementById('total-bookmarks');
    const scannedBookmarksEl = document.getElementById('scanned-bookmarks');
    const emptyFoldersEl = document.getElementById('empty-folders');
    
    if (scannedBookmarksEl) scannedBookmarksEl.textContent = totalBookmarks;
    if (totalBookmarksEl) totalBookmarksEl.textContent = totalBookmarks;
    if (emptyFoldersEl) emptyFoldersEl.textContent = emptyFolders.length;
    
    // 用统一的更新函数
    updateInvalidBookmarksCount();
}

// 修改显示结果的函数
function displayResults() {
    const invalidList = document.getElementById('invalidList');
    if (!invalidList) return;
    
    // 添加调试日志
    console.log('Display Results - Invalid Bookmarks:', invalidBookmarks.length);
    console.log('Display Results - Empty Folders:', emptyFolders.length);
    
    // 清空现有列表
    invalidList.innerHTML = '';
    
    // 如果没有无效书签和空文件夹，显示成功消息
    if (invalidBookmarks.length === 0 && emptyFolders.length === 0) {
        invalidList.innerHTML = `
            <div class="result-item">
                <div style="color: #34C759">${chrome.i18n.getMessage('allValid')}</div>
            </div>
        `;
        return;
    }

    // 合并无效书签和空文件夹
    const allItems = [
        ...invalidBookmarks.map(bookmark => ({
            type: 'bookmark',
            data: bookmark
        })),
        ...emptyFolders.map(folder => ({
            type: 'folder',
            data: folder
        }))
    ];

    // 添加调试日志
    console.log('Combined items count:', allItems.length);

    // 显示所有项目
    allItems.forEach(item => {
        if (item.type === 'bookmark') {
            addInvalidBookmark(item.data);
        } else {
            addEmptyFolder(item.data);
            // 添加调试日志
            console.log('Adding empty folder to display:', item.data.title);
        }
    });
    
    // 添加这行：更新筛选标签
    createFilterTags();
}

// 添加空文件夹显示函数
function addEmptyFolder(folder) {
    const invalidList = document.getElementById('invalidList');
    if (!invalidList) {
        console.error('Invalid list container not found');
        return;
    }

    console.log('Adding empty folder:', folder); // 调试日志

    const item = document.createElement('div');
    item.className = 'result-item';
    
    // 创建复选框
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'bookmark-checkbox';
    checkbox.setAttribute('data-id', folder.id);
    
    checkbox.addEventListener('change', (e) => {
        if (isScanning) {
            e.preventDefault();
            checkbox.checked = !checkbox.checked;
            return;
        }
        
        if (e.target.checked) {
            selectedBookmarks.add(folder.id);
            item.classList.add('selected');
        } else {
            selectedBookmarks.delete(folder.id);
            item.classList.remove('selected');
        }
        updateDeleteButtonState();
        updateSelectAllButtonState(); // 确保在这里也更新全选按钮状态
    });

    // 创建文件夹标题
    const title = document.createElement('div');
    title.className = 'bookmark-title';
    title.textContent = folder.title;

    // 创建空的 URL 占位符（保持布局一致）
    const urlDiv = document.createElement('div');
    urlDiv.className = 'bookmark-url';
    urlDiv.textContent = ''; // 空文件夹没有 URL

    // 创建路径
    const path = document.createElement('div');
    path.className = 'bookmark-path';
    path.textContent = folder.path.slice(0, -1).join(' > ');

    // 创建标签
    const reasonTag = document.createElement('div');
    reasonTag.className = 'bookmark-reason empty-folder-tag';
    reasonTag.textContent = chrome.i18n.getMessage('emptyFolder');

    // 组装 DOM
    item.appendChild(checkbox);
    item.appendChild(title);
    item.appendChild(urlDiv);
    item.appendChild(path);
    item.appendChild(reasonTag);
    
    invalidList.appendChild(item);
    updateSelectAllButtonState();
}

// 添加 HTML 转义函数以防止 XSS
function escapeHtml(unsafe) {
    if (!unsafe) return '';
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// 计算需要检查的书签总数
async function countCheckableBookmarks(node) {
    let count = 0;
    
    if (node.children) {
        for (const child of node.children) {
            if (child.url) {
                // 检查是否是有效的 URL
                if (!CONFIG.validProtocols.some(protocol => child.url.startsWith(protocol))) {
                    count++;
                }
            } else {
                // 递归计算子文件夹中的书签
                count += await countCheckableBookmarks(child);
            }
        }
    }
    
    return count;
}

// 添加重试结果的监听器
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'retryResult') {
        const bookmark = retryBookmarks.get(message.url);
        if (bookmark) {
            // 更新显示结果
            if (!message.result.isValid) {
                addInvalidBookmark(bookmark, message.result.reason);
            }
            retryBookmarks.delete(message.url);
            
            // 更新进度显示
            updateProgress(counter.count, counter.total);
        }
    }
});

// 修改 initBatchActions 函数
function initBatchActions() {
    console.log('Initializing batch actions...'); // 调试日志
    
    const deleteSelectedBtn = document.getElementById('delete-selected');
    const selectAllBtn = document.getElementById('select-all');
    
    if (!selectAllBtn || !deleteSelectedBtn) {
        console.error('Batch action buttons not found!');
        return;
    }

    // 移除现有的事件监听器
    const newSelectAllBtn = selectAllBtn.cloneNode(true);
    const newDeleteSelectedBtn = deleteSelectedBtn.cloneNode(true);
    selectAllBtn.parentNode.replaceChild(newSelectAllBtn, selectAllBtn);
    deleteSelectedBtn.parentNode.replaceChild(newDeleteSelectedBtn, deleteSelectedBtn);

    // 添加全选按钮事件监听器
    newSelectAllBtn.addEventListener('click', () => {
        console.log('Select all clicked'); // 调试日志
        if (isScanning) return;
        
        const checkboxes = document.querySelectorAll('.bookmark-checkbox');
        console.log('Found checkboxes:', checkboxes.length); // 调试日志
        
        const isAllSelected = Array.from(checkboxes).every(cb => cb.checked);
        
        checkboxes.forEach(checkbox => {
            checkbox.checked = !isAllSelected;
            const bookmarkId = checkbox.getAttribute('data-id');
            const resultItem = checkbox.closest('.result-item');
            
            if (!isAllSelected) {
                selectedBookmarks.add(bookmarkId);
                resultItem.classList.add('selected');
            } else {
                selectedBookmarks.delete(bookmarkId);
                resultItem.classList.remove('selected');
            }
        });
        
        updateSelectAllButtonState();
        updateDeleteButtonState();
    });

    // 添加删除按钮事件监听器
    newDeleteSelectedBtn.addEventListener('click', async () => {
        if (isScanning || selectedBookmarks.size === 0) return;

        if (confirm(chrome.i18n.getMessage('confirmDelete'))) {
            try {
                for (const id of selectedBookmarks) {
                    await chrome.bookmarks.remove(id);
                    const item = document.querySelector(`[data-id="${id}"]`).closest('.result-item');
                    if (item) {
                        // 检查是否为空文件夹
                        const reasonElement = item.querySelector('.bookmark-reason');
                        const isEmptyFolder = reasonElement && 
                            reasonElement.textContent === chrome.i18n.getMessage('errorType_emptyFolder');
                        
                        // 更新统计数据
                        if (isEmptyFolder) {
                            // 从 emptyFolders 数组中移除
                            const index = emptyFolders.findIndex(folder => folder.id === id);
                            if (index !== -1) {
                                emptyFolders.splice(index, 1);
                            }
                        } else {
                            // 从 invalidBookmarks 数组中移除
                            const index = invalidBookmarks.findIndex(bookmark => bookmark.id === id);
                            if (index !== -1) {
                                invalidBookmarks.splice(index, 1);
                            }
                        }
                        
                        // 更新总书签数
                        totalBookmarks--;
                        
                        // 更新界面显示
                        updateAllStats();
                        
                        // 移除项目
                        item.remove();
                    }
                }
                
                // 清空选中集合
                selectedBookmarks.clear();
                
                // 如果没有更多项目，隐藏批量操作按钮
                const remainingItems = document.querySelectorAll('.result-item');
                if (remainingItems.length === 0) {
                    document.querySelector('.batch-actions').style.display = 'none';
                }
                
                // 更新按钮状态
                updateDeleteButtonState();
                updateSelectAllButtonState();
                
            } catch (error) {
                console.error('Error deleting bookmarks:', error);
                alert(chrome.i18n.getMessage('errorDeleting'));
            }
        }
    });

    console.log('Batch actions initialized successfully'); // 调试日志
}

// 修改显示无效书签列表添加复选框
function createInvalidItem(bookmark, reason) {
    const item = document.createElement('div');
    item.className = 'result-item';
    
    // 添加复选框
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'bookmark-checkbox';
    checkbox.setAttribute('data-id', bookmark.id);
    
    checkbox.addEventListener('change', (e) => {
        if (isScanning) {
            e.preventDefault();
            checkbox.checked = !checkbox.checked;
            return;
        }
        
        if (e.target.checked) {
            selectedBookmarks.add(bookmark.id);
            item.classList.add('selected');
        } else {
            selectedBookmarks.delete(bookmark.id);
            item.classList.remove('selected');
        }
        updateDeleteButtonState();
    });
    
    // 创建书签标题
    const title = document.createElement('div');
    title.className = 'bookmark-title';
    title.textContent = bookmark.title;

    // 创建 URL 链接
    const urlDiv = document.createElement('div');
    urlDiv.className = 'bookmark-url';
    const urlLink = document.createElement('a');
    urlLink.href = bookmark.url;
    urlLink.textContent = bookmark.url;
    urlLink.target = '_blank';
    urlDiv.appendChild(urlLink);

    // 创建路径显示
    const path = document.createElement('div');
    path.className = 'bookmark-path';
    path.textContent = bookmark.path.join(' > ');

    // 创建错误原因标签
    const reasonTag = document.createElement('div');
    reasonTag.className = 'bookmark-reason';
    reasonTag.textContent = reason;
    
    // 添加 title 属性作为 tooltip
    reasonTag.title = getErrorExplanation(reason);

    // 组装 DOM
    item.appendChild(checkbox);
    item.appendChild(title);
    item.appendChild(urlDiv);
    item.appendChild(path);
    item.appendChild(reasonTag);
    
    return item;
}

// 在开始扫描时显示批量操作按钮
function showBatchActions() {
    const batchActions = document.querySelector('.batch-actions');
    if (batchActions) {
        batchActions.style.display = 'flex';
    }
    selectedBookmarks.clear();
    updateDeleteButtonState();
}

// 在扫描完成时调用
function onScanComplete() {
    // ... existing code ...
    showBatchActions();
}

// 更新书签计数显示
function updateBookmarkCountDisplay() {
    const scannedBookmarksEl = document.getElementById('scanned-bookmarks');
    const totalBookmarksEl = document.getElementById('total-bookmarks');
    
    if (scannedBookmarksEl && totalBookmarksEl) {
        scannedBookmarksEl.textContent = totalBookmarks;
        totalBookmarksEl.textContent = totalBookmarks;
    }
}

// 更新所有统计数据
function updateAllStats() {
    // 更新书签总数和已扫描数
    updateBookmarkCountDisplay();
    
    // 更新无效链接数
    const invalidLinksEl = document.getElementById('invalid-links');
    if (invalidLinksEl) {
        invalidLinksEl.textContent = invalidBookmarks.length;
    }
    
    // 更新空文件夹数
    const emptyFoldersEl = document.getElementById('empty-folders');
    if (emptyFoldersEl) {
        emptyFoldersEl.textContent = emptyFolders.length;
    }
}

// 修改错误处理部分
function handleError(error) {
    const invalidList = document.getElementById('invalidList');
    if (invalidList) {
        invalidList.innerHTML = `
            <div class="result-item">
                <div style="color: var(--system-red)">
                    ${chrome.i18n.getMessage('errorScanning', [error.message])}
                </div>
            </div>
        `;
    }
    console.error('Error:', error);
}

// 添加禁用批量操作的函数
function disableBatchActions() {
    const selectAllBtn = document.getElementById('select-all');
    const deleteSelectedBtn = document.getElementById('delete-selected');
    const batchActions = document.querySelector('.batch-actions');
    
    if (selectAllBtn) selectAllBtn.disabled = true;
    if (deleteSelectedBtn) deleteSelectedBtn.disabled = true;
    if (batchActions) batchActions.style.opacity = '1';
}

// 添加启用批量操作的函数
function enableBatchActions() {
    const selectAllBtn = document.getElementById('select-all');
    const deleteSelectedBtn = document.getElementById('delete-selected');
    const batchActions = document.querySelector('.batch-actions');
    
    if (selectAllBtn) selectAllBtn.disabled = false;
    if (deleteSelectedBtn) {
        // 只有当有选中项时才启用删除按钮
        deleteSelectedBtn.disabled = selectedBookmarks.size === 0;
    }
    if (batchActions) batchActions.style.opacity = '1';
}

// 修改创建筛选标签的函数
function createFilterTags() {
    // 移除现有的筛选标签
    const existingFilterTags = document.querySelector('.filter-tags');
    if (existingFilterTags) {
        existingFilterTags.remove();
    }

    const filterContainer = document.createElement('div');
    filterContainer.className = 'filter-tags';
    
    // 添加"全部"标签
    const allTag = createFilterTag('all', getMessage('errorType_all'));
    filterContainer.appendChild(allTag);
    
    // 添加"空文件夹"标签
    if (emptyFolders.length > 0) {
        const emptyFolderTag = createFilterTag('empty-folder', getMessage('errorType_emptyFolder'));
        filterContainer.appendChild(emptyFolderTag);
    }
    
    // 收集所有错误类型
    const reasons = new Set();
    document.querySelectorAll('.bookmark-reason').forEach(el => {
        if (!el.classList.contains('empty-folder-tag')) {
            const errorText = el.textContent.trim();
            reasons.add(errorText);
        }
    });
    
    // 为每个错误类型创建标签
    reasons.forEach(reason => {
        const tag = createFilterTag(reason, reason);
        filterContainer.appendChild(tag);
    });
    
    // 插入到批量操作按钮下方
    const batchActions = document.querySelector('.batch-actions');
    if (batchActions && batchActions.parentNode) {
        batchActions.parentNode.insertBefore(filterContainer, batchActions.nextSibling);
    }

    // 打印日志以便调试
    console.log('Created filter tags for reasons:', Array.from(reasons));
}

// 修改应用筛选函数
function applyFilter() {
    const items = document.querySelectorAll('.result-item');
    items.forEach(item => {
        const reasonTag = item.querySelector('.bookmark-reason');
        if (!reasonTag) return;

        const isEmptyFolder = reasonTag.classList.contains('empty-folder-tag');
        const currentReason = reasonTag.textContent.trim();
        
        if (currentFilter === 'all') {
            item.style.display = '';
        } else if (currentFilter === 'empty-folder') {
            item.style.display = isEmptyFolder ? '' : 'none';
        } else {
            // 直接使用完整的错误文本进行匹配
            item.style.display = (currentReason === currentFilter) ? '' : 'none';
        }
    });
    
    // 更新选中状态和按钮
    updateSelectAllButtonState();
    updateDeleteButtonState();
}

// 创建单个筛选标签
function createFilterTag(type, text) {
    const tag = document.createElement('div');
    tag.className = 'filter-tag';
    if (type === currentFilter) {
        tag.classList.add('active');
    }
    
    tag.textContent = text;
    
    // 添加提示文本
    const tooltip = getErrorExplanation(text);
    if (tooltip && tooltip !== text) {
        tag.setAttribute('data-tooltip', tooltip);
    }
    
    tag.addEventListener('click', () => {
        currentFilter = type;
        document.querySelectorAll('.filter-tag').forEach(t => {
            t.classList.remove('active');
        });
        tag.classList.add('active');
        applyFilter();
    });
    
    return tag;
}

// 添加新函数：获取错误说明
function getErrorExplanation(errorType) {
    // 根据错误类型返回详细解释
    const explanations = {
        [getMessage('errorType_connectionError')]: getMessage('errorExplanation_connectionError'),
        [getMessage('errorType_dnsError')]: getMessage('errorExplanation_dnsError'),
        [getMessage('errorType_requestTimeout')]: getMessage('errorExplanation_requestTimeout'),
        [getMessage('errorType_sslError')]: getMessage('errorExplanation_sslError'),
        [getMessage('errorType_pageNotFound')]: getMessage('errorExplanation_pageNotFound'),
        [getMessage('errorType_accessDenied')]: getMessage('errorExplanation_accessDenied'),
        [getMessage('errorType_serverError')]: getMessage('errorExplanation_serverError'),
        [getMessage('errorType_emptyFolder')]: getMessage('errorExplanation_emptyFolder'),
        [getMessage('errorType_tooManyRedirects')]: getMessage('errorExplanation_tooManyRedirects'),
        [getMessage('errorType_networkError')]: getMessage('errorExplanation_networkError'),
        [getMessage('errorType_unknown')]: getMessage('errorExplanation_unknown'),
        [getMessage('errorType_invalidUrl')]: getMessage('errorExplanation_invalidUrl'),
        [getMessage('errorType_blockedAccess')]: getMessage('errorExplanation_blockedAccess'),
        [getMessage('errorType_all')]: getMessage('errorExplanation_all'),
        [getMessage('errorType_httpError')]: getMessage('errorExplanation_httpError'),
        [getMessage('errorType_invalidProtocol')]: getMessage('errorExplanation_invalidProtocol'),
        [getMessage('errorType_badRequest')]: getMessage('errorExplanation_badRequest'),
        [getMessage('errorType_unauthorized')]: getMessage('errorExplanation_unauthorized'),
        [getMessage('errorType_forbidden')]: getMessage('errorExplanation_forbidden'),
        [getMessage('errorType_methodNotAllowed')]: getMessage('errorExplanation_methodNotAllowed'),
        [getMessage('errorType_teapot')]: getMessage('errorExplanation_teapot'),
        [getMessage('errorType_tooManyRequests')]: getMessage('errorExplanation_tooManyRequests'),
        [getMessage('errorType_badGateway')]: getMessage('errorExplanation_badGateway'),
        [getMessage('errorType_serviceUnavailable')]: getMessage('errorExplanation_serviceUnavailable'),
        [getMessage('errorType_gatewayTimeout')]: getMessage('errorExplanation_gatewayTimeout'),
        [getMessage('errorType_nonStandard777')]: getMessage('errorExplanation_nonStandard777'),
        [getMessage('errorType_nonStandard468')]: getMessage('errorExplanation_nonStandard468')
    };

    return explanations[errorType] || errorType;
}

// 添加重置扫描状态的函数
function resetScanState() {
    // 重置扫描标志
    isScanning = false;
    
    // 重置进度环
    initializeProgressRing();
    
    // 重置按钮文案和样式
    const scanButton = document.getElementById('scan-button');
    const buttonText = scanButton.querySelector('.button-text');
    if (buttonText) {
        buttonText.textContent = chrome.i18n.getMessage('scanBookmarks');
    }
    if (scanButton) {
        scanButton.classList.remove('cancel');
    }
    
    // 重置进度文本
    const progressText = document.querySelector('.progress-text');
    if (progressText) {
        progressText.textContent = '0%';
    }
    
    // 重置状态文本
    const progressStatus = document.querySelector('.progress-status');
    if (progressStatus) {
        progressStatus.textContent = '';
    }
    
    // 重置加载状态
    const loadingDiv = document.getElementById('loading');
    if (loadingDiv) {
        loadingDiv.style.display = 'none';
    }
    
    // 重置扫描容器类
    const container = document.querySelector('.scan-container');
    if (container) {
        container.classList.remove('scanning');
        container.classList.remove('scan-complete');
    }
}

// 添加重置数据的函数
function resetScanData() {
    // 重置所有计数器和数组
    invalidBookmarks = [];
    emptyFolders = [];
    invalidBookmarksCount = 0;
    selectedBookmarks.clear();
    scanCancelled = false;
    
    // 重置显示的数值，但保留总书签数
    const scannedBookmarksEl = document.getElementById('scanned-bookmarks');
    const invalidLinksEl = document.getElementById('invalid-links');
    const emptyFoldersEl = document.getElementById('empty-folders');
    
    if (scannedBookmarksEl) scannedBookmarksEl.textContent = '0';
    if (invalidLinksEl) invalidLinksEl.textContent = '0';
    if (emptyFoldersEl) emptyFoldersEl.textContent = '0';
    
    // 清空结果列表
    const invalidList = document.getElementById('invalidList');
    if (invalidList) {
        invalidList.innerHTML = '';
    }
    
    // 隐藏批量操作按钮
    const batchActions = document.querySelector('.batch-actions');
    if (batchActions) {
        batchActions.style.display = 'none';
    }
    
    // 移除筛选标签
    const filterTags = document.querySelector('.filter-tags');
    if (filterTags) {
        filterTags.innerHTML = '';
    }
}

// 更新扫描持续时间
function updateScanDuration() {
    if (!scanStartTime) return;
    
    const duration = Math.floor((Date.now() - scanStartTime) / 1000);
    const durationEl = document.getElementById('scan-duration');
    
    if (durationEl) {
        // 格式化时间
        let formatted;
        if (duration < 60) {
            // 少于1分钟，只显示秒
            formatted = duration;
        } else if (duration < 3600) {
            // 少于1小时，显示分和秒
            const minutes = Math.floor(duration / 60);
            const seconds = duration % 60;
            formatted = `${minutes}m ${seconds}`;
        } else {
            // 超过1小时，显示时分秒
            const hours = Math.floor(duration / 3600);
            const minutes = Math.floor((duration % 3600) / 60);
            const seconds = duration % 60;
            formatted = `${hours}h ${minutes}m ${seconds}`;
        }
        
        durationEl.textContent = formatted;
    }
}

// 在扫描完成时停止计时
function finishScan() {
    clearInterval(scanDurationInterval);
    scanStartTime = 0;
    hideMovingCat();
}

// 在取消扫描时重置计时器
function cancelScan() {
    clearInterval(scanDurationInterval);
    scanStartTime = 0;
    const durationEl = document.getElementById('scan-duration');
    if (durationEl) {
        durationEl.textContent = '0';
    }
    hideMovingCat();
}

// 添加创建移动猫咪的函数
function createMovingCat() {
    const statsWrapper = document.querySelector('.scan-stats-wrapper');
    if (!statsWrapper) return;

    // 创建猫咪容器
    const catContainer = document.createElement('div');
    catContainer.className = 'moving-cat-container';
    
    // 创建猫咪元素
    const cat = document.createElement('img');
    cat.src = 'images/logo.jpg';  // 使用你的猫咪logo
    cat.className = 'moving-cat';
    cat.alt = '懒猫书签清理';
    
    catContainer.appendChild(cat);
    statsWrapper.after(catContainer); // 将猫咪放在stats-wrapper后面
    initCatInteraction();
}

// 在开始扫描时显示猫咪
function showMovingCat() {
    const cat = document.querySelector('.moving-cat-container');
    if (cat) {
        cat.style.display = 'block';
        cat.style.opacity = '1';
    }
}

// 在扫描结束时隐藏猫咪
function hideMovingCat() {
    const cat = document.querySelector('.moving-cat-container');
    if (cat) {
        cat.style.opacity = '0';
        setTimeout(() => {
            cat.style.display = 'none';
        }, 300); // 等待淡出动画完成
    }
}
// 添加猫咪点击交互
function initCatInteraction() {
    const cat = document.querySelector('.moving-cat');
    const tooltip = document.querySelector('.cat-tooltip');

    // 随机提示语数组
    const messages = [
        chrome.i18n.getMessage('catMessage1'),
        chrome.i18n.getMessage('catMessage2'),
        chrome.i18n.getMessage('catMessage3'),
        chrome.i18n.getMessage('catMessage4'),
        chrome.i18n.getMessage('catMessage5'),
        chrome.i18n.getMessage('catMessage6'),
        chrome.i18n.getMessage('catMessage7'),
        chrome.i18n.getMessage('catMessage8'),
        chrome.i18n.getMessage('catMessage9'),
        chrome.i18n.getMessage('catMessage10'),
        chrome.i18n.getMessage('catMessage11'),
        chrome.i18n.getMessage('catMessage12'),
        chrome.i18n.getMessage('catMessage13'),
        chrome.i18n.getMessage('catMessage14'),
        chrome.i18n.getMessage('catMessage15'),
        chrome.i18n.getMessage('catMessage16'),
        chrome.i18n.getMessage('catMessage17'),
        chrome.i18n.getMessage('catMessage18'),
        chrome.i18n.getMessage('catMessage19'),
        chrome.i18n.getMessage('catMessage20')
    ];

    let timeoutId;

    cat.addEventListener('click', (e) => {
        // 获取随机消息
        const message = messages[Math.floor(Math.random() * messages.length)];

        // 更新并显示提示框
        tooltip.querySelector('.tooltip-text').textContent = message;
        tooltip.style.display = 'block';
        tooltip.style.opacity = '1';

        // 设置提示框位置（在猫咪上方）
        const catRect = cat.getBoundingClientRect();
        tooltip.style.left = `${catRect.left + (catRect.width / 2) - (tooltip.offsetWidth / 2)}px`;
        tooltip.style.top = `${catRect.top - tooltip.offsetHeight - 10}px`;

        // 清除之前的定时器
        clearTimeout(timeoutId);

        // 2秒后隐藏提示框
        timeoutId = setTimeout(() => {
            tooltip.style.opacity = '0';
            setTimeout(() => {
                tooltip.style.display = 'none';
            }, 300);
        }, 2000);
    });
}

async function scanBookmarksInBatches(node, batchSize = 100) {
    const bookmarks = [];
    const collectBookmarks = (node) => {
        if (node.url) bookmarks.push(node);
        if (node.children) node.children.forEach(collectBookmarks);
    };
    collectBookmarks(node);
    
    for (let i = 0; i < bookmarks.length; i += batchSize) {
        const batch = bookmarks.slice(i, i + batchSize);
        await processBatch(batch);
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}


