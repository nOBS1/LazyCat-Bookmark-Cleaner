chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.create({
    url: 'index.html'
  });
});

// 处理 URL 检查请求
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'checkUrl') {
    checkUrl(request.url)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ 
        isValid: false, 
        reason: error.message 
      }));
    return true;
  }
});

async function checkUrl(url) {
    try {
        return await checkUrlOnce(url);
    } catch (error) {
        throw error;
    }
}

// 添加网络状况检测和超时管理
class NetworkTimeoutManager {
    constructor() {
        this.baseTimeout = 6000; // 基础超时时间 6 秒
        this.maxTimeout = 12000; // 最大超时时间 12 秒
        this.minTimeout = 4000;  // 最小超时时间 4 秒
        this.networkSamples = []; // 存储最近的网络响应时间样本
        this.maxSamples = 10;    // 保留最近 10 个样本
    }

    // 获取当前网络状况下的超时时间
    getTimeout() {
        if (this.networkSamples.length === 0) {
            return this.baseTimeout;
        }

        // 计算最近样本的平均响应时间
        const avgResponseTime = this.calculateAverageResponseTime();
        // 使用平均响应时间的 2.5 倍作为超时时间
        let timeout = avgResponseTime * 2.5;

        // 确保超时时间在合理范围内
        timeout = Math.max(this.minTimeout, Math.min(timeout, this.maxTimeout));
        
        console.log(`🕒 Dynamic timeout set to ${timeout}ms (avg response: ${avgResponseTime}ms)`);
        return timeout;
    }

    // 添加新的响应时间样本
    addSample(responseTime) {
        this.networkSamples.push(responseTime);
        if (this.networkSamples.length > this.maxSamples) {
            this.networkSamples.shift(); // 移除最老的样本
        }
        console.log(`📊 Network samples updated: ${this.networkSamples.join(', ')}ms`);
    }

    // 计算平均响应时间
    calculateAverageResponseTime() {
        if (this.networkSamples.length === 0) return this.baseTimeout;
        
        // 移除异常值（超过平均值两个标准差的样本）
        const samples = this.removeOutliers(this.networkSamples);
        const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
        
        console.log(`📈 Average response time: ${avg}ms (from ${samples.length} samples)`);
        return avg;
    }

    // 移除异常值
    removeOutliers(samples) {
        if (samples.length < 4) return samples; // 样本太少不处理

        const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
        const std = Math.sqrt(
            samples.reduce((sq, n) => sq + Math.pow(n - avg, 2), 0) / samples.length
        );
        
        return samples.filter(s => Math.abs(s - avg) <= 2 * std);
    }

    // 重置样本数据
    reset() {
        this.networkSamples = [];
    }
}

// 创建超时管理器实例
const timeoutManager = new NetworkTimeoutManager();

// 添加白名单配置
const WHITELIST_DOMAINS = [
  'github.com',
  'gitlab.com',
  'bitbucket.org',
  'notion.so',
  'feishu.cn',
  'yuque.com',
  'figma.com',
  'atlassian.com',
  'jira.com',
  'confluence.com',
  'medium.com',
  'dev.to',
  'stackoverflow.com',
  'zhihu.com',
  'juejin.cn',
  'csdn.net'
];

// 添加白名单检查函数
function isWhitelisted(url) {
  try {
    const urlObj = new URL(url);
    const domain = urlObj.hostname.toLowerCase();
    
    // 检查完整域名和子域名
    return WHITELIST_DOMAINS.some(whitelistedDomain => 
      domain === whitelistedDomain || 
      domain.endsWith('.' + whitelistedDomain)
    );
  } catch (error) {
    return false;
  }
}

async function checkUrlOnce(url) {
  const startTime = Date.now();
  console.group(`🔍 Checking URL: ${url}`);
  
  try {
    const urlObj = new URL(url);
    
    // 添加白名单检查
    if (isWhitelisted(url)) {
      console.log(`✅ Whitelisted domain: ${urlObj.hostname}`);
      console.groupEnd();
      return {
        isValid: true,
        reason: 'Whitelisted domain'
      };
    }

    // 特殊协议检查
    if (specialProtocols.some(protocol => url.startsWith(protocol))) {
      console.log(`🔒 Special protocol detected: ${urlObj.protocol}`);
      console.groupEnd();
      return {
        isValid: true,
        reason: 'Special protocol URL'
      };
    }

    // 使用 fetch 发送请求验证 URL
    return new Promise((resolve, reject) => {
      fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        mode: 'no-cors',
        cache: 'no-cache'
      })
    });
  } catch (error) {
    console.error(`❌ URL parsing error:`, error);
    console.groupEnd();
    return {
      isValid: false,
      reason: 'Invalid URL format'
    };
  }
}

function getStatusCodeReason(code) {
    const reasons = {
        401: 'Requires authentication',
        403: 'Access restricted',
        429: 'Too many requests'
    };
    return reasons[code] || `Status code: ${code}`;
}

function handleStatusCode(statusCode, url) {
  // 2xx: 成功
  if (statusCode >= 200 && statusCode < 300) {
    return { isValid: true };
  }
  
  // 3xx: 重定向
  if (statusCode >= 300 && statusCode < 400) {
    return { 
      isValid: true,
      reason: 'Redirect response'
    };
  }
  
  // 4xx: 客户端错误
  if (statusCode >= 400 && statusCode < 500) {
    // 特殊处理某些 4xx 状态码
    if ([401, 403, 429].includes(statusCode)) {
      return { 
        isValid: true,
        reason: getStatusCodeReason(statusCode)
      };
    }
    if (statusCode === 404) {
      return {
        isValid: false,
        reason: 'Page not found'
      };
    }
    return {
      isValid: false,
      reason: `Client error: ${statusCode}`
    };
  }
  
  // 5xx: 服务器错误
  if (statusCode >= 500) {
    return {
      isValid: true,
      reason: 'Server temporarily unavailable'
    };
  }
}

// 清理 URL 的辅助函数
function cleanupUrl(url) {
  try {
    const urlObj = new URL(url);
    
    // 1. 移除末尾的 # 或 /#
    if (urlObj.hash === '#' || urlObj.hash === '') {
      url = url.replace(/#$/, '');
      url = url.replace(/\/#$/, '/');
    }
    
    // 2. 处理重复的斜杠
    url = url.replace(/([^:]\/)\/+/g, '$1');
    
    // 3. 确保 http/https URL 末尾有斜杠
    if (!url.endsWith('/') && !urlObj.pathname.includes('.') && !urlObj.hash && !urlObj.search) {
      url += '/';
    }
    
    return url;
  } catch (e) {
    return url;
  }
}

// 检测是否为单页面应用 URL 模式
function isSPAUrl(url) {
  try {
    const urlObj = new URL(url);
    
    // 1. 检查是否为常见的 SPA 路由模式
    const spaPatterns = [
      /\/#\//, // Vue/React 常见路由格式
      /\/[#!]$/, // Angular 和其他框架常见格式
      /\/[#!]\//, // 带路径的 hash 路由
    ];
    
    if (spaPatterns.some(pattern => pattern.test(url))) {
      return true;
    }
    
    // 2. 检查是否为纯 hash 路由
    if (urlObj.hash && urlObj.hash !== '#') {
      return true;
    }
    
    return false;
  } catch (e) {
    return false;
  }
}

// 添加重试机制
async function checkUrlWithRetry(url, maxRetries = 2) {
  let lastError;
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, 2000 * i));
      }
      
      const result = await checkUrlOnce(url);
      if (result.isValid || !isRetryableError(result.reason)) {
        return result;
      }
      lastError = result;
    } catch (error) {
      lastError = { isValid: false, reason: error.message };
    }
  }
  
  return lastError;
}

function isRetryableError(error) {
  const retryableErrors = [
    'net::ERR_SOCKET_NOT_CONNECTED',
    'net::ERR_CONNECTION_RESET',
    'net::ERR_NETWORK_CHANGED',
    'net::ERR_CONNECTION_REFUSED',
    'net::ERR_CONNECTION_TIMED_OUT',
    'net::ERR_NETWORK_IO_SUSPENDED',
    'Request Timeout'
  ];
  return retryableErrors.some(e => error?.includes(e));
}

// 添加白名单管理功能
class WhitelistManager {
  constructor() {
    this.customWhitelist = new Set();
  }

  // 从存储加载自定义白名单
  async loadCustomWhitelist() {
    try {
      const result = await chrome.storage.local.get('customWhitelist');
      if (result.customWhitelist) {
        this.customWhitelist = new Set(result.customWhitelist);
      }
    } catch (error) {
      console.error('Error loading custom whitelist:', error);
    }
  }

  // 保存自定义白名单到存储
  async saveCustomWhitelist() {
    try {
      await chrome.storage.local.set({
        customWhitelist: Array.from(this.customWhitelist)
      });
    } catch (error) {
      console.error('Error saving custom whitelist:', error);
    }
  }

  // 添加域名到自定义白名单
  async addDomain(domain) {
    domain = domain.toLowerCase().trim();
    if (!this.customWhitelist.has(domain)) {
      this.customWhitelist.add(domain);
      await this.saveCustomWhitelist();
    }
  }

  // 从自定义白名单移除域名
  async removeDomain(domain) {
    domain = domain.toLowerCase().trim();
    if (this.customWhitelist.has(domain)) {
      this.customWhitelist.delete(domain);
      await this.saveCustomWhitelist();
    }
  }

  // 检查域名是否在白名单中
  isDomainWhitelisted(domain) {
    domain = domain.toLowerCase().trim();
    return WHITELIST_DOMAINS.includes(domain) || 
           this.customWhitelist.has(domain);
  }
}

// 创建白名单管理器实例
const whitelistManager = new WhitelistManager();

// 初始化时加载自定义白名单
whitelistManager.loadCustomWhitelist();

async function checkUrlWithTimeout(url, timeout = 6000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    try {
        const response = await fetch(url, {
            signal: controller.signal
        });
        return { isValid: response.ok };
    } catch (error) {
        if (error.name === 'AbortError') {
            return { isValid: false, reason: 'Timeout' };
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}