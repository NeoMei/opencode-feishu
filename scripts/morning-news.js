#!/usr/bin/env node
/**
 * 早报脚本 - 每天早上发送天气 + AI/机器人/半导体新闻
 * 用法: FEISHU_NEWS_CHAT_ID=xxx ANYSEARCH_API_KEY=xxx node scripts/morning-news.js
 */

import { FeishuAPI } from '../dist/feishu/api.js';
import { IMService } from '../dist/services/im-service.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const configPath = join(homedir(), '.config', 'opencode', 'feishu.json');
const config = JSON.parse(readFileSync(configPath, 'utf-8'));

const api = new FeishuAPI({
  appId: config.appId,
  appSecret: config.appSecret,
});

const imService = new IMService(api);
const CHAT_ID = process.env.FEISHU_NEWS_CHAT_ID || config.newsChatId;
const ANYSEARCH_API_KEY = process.env.ANYSEARCH_API_KEY;
if (!ANYSEARCH_API_KEY) {
  console.error('错误：未设置 ANYSEARCH_API_KEY 环境变量');
  process.exit(1);
}
const ANYSEARCH_CLI = '/tmp/anysearch-skill-main/scripts/anysearch_cli.js';

// 历史记录文件，用于去重
const HISTORY_FILE = join(homedir(), '.config', 'opencode', 'news-history.json');

function loadHistory() {
  if (existsSync(HISTORY_FILE)) {
    try {
      return JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'));
    } catch {
      return [];
    }
  }
  return [];
}

function saveHistory(history) {
  writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(-100), null, 2));
}

function isDuplicate(title, history) {
  const normalized = title.replace(/\s+/g, '').toLowerCase();
  return history.some(h => h.replace(/\s+/g, '').toLowerCase() === normalized);
}

function isEnglishText(text) {
  if (!text) return false;
  const englishChars = text.match(/[a-zA-Z]/g) || [];
  return englishChars.length / text.length > 0.5;
}

async function fetchShanghaiWeather() {
  try {
    const response = await fetch('https://wttr.in/Shanghai?format=%C+%t+%h');
    const weather = await response.text();
    return `☀️ 上海天气：${weather.trim()}`;
  } catch (error) {
    return '☀️ 上海天气：获取失败';
  }
}



function isBlockedDomain(url) {
  const blockedDomains = ['semiinsights.com', 'seminews.com.cn', 'stocktwits.com', 'poweredtemplate.com', 'context.reverso.net', 'szbjxk.com'];
  try {
    const domain = url ? new URL(url).hostname : '';
    const isBlocked = blockedDomains.some(d => domain.includes(d));
    if (isBlocked) {
      console.log(`🚫 黑名单域名: ${domain}`);
    }
    return isBlocked;
  } catch {
    return false;
  }
}

function isValidNewsItem(item, history, strict = true) {
  const url = item.url || '';
  const content = item.content || '';
  const title = item.title || '';
  
  // 先检查黑名单域名（最优先）
  if (isBlockedDomain(url)) {
    console.log(`🚫 黑名单域名被排除: ${url}`);
    return false;
  }
  
  // 排除明显的导航页、标签页
  if (url.includes('/tag/') || url.includes('/tags/') || url.includes('/label/')) return false;
  if (url.includes('search') || url.includes('?q=')) return false;
  
  // 排除标签页、导航页（如 "第 X 页"、"标签"、"热门文章" 等）
  if (title.includes('标签') && title.includes('页')) return false;
  if (title.includes('第') && title.includes('页')) return false;
  if (title.includes('热门文章') || title.includes('本日') || title.includes('七天') || title.includes('本月')) return false;
  
  // 排除产品页（包含型号、规格、datasheet 等）
  if (title.match(/[A-Z0-9]{8,}/)) return false;  // 包含长串型号
  if (content.includes('datasheet') || content.includes('规格书') || content.includes('数据手册')) return false;
  if (content.includes('立即购买') || content.includes('加入购物车')) return false;
  
  // 排除旧内容（2024年及更早的，且不含2025/2026）
  const oldYearMatch = content.match(/20(20|21|22|23|24)/);
  if (oldYearMatch && !content.includes('2026') && !content.includes('2025') && !title.includes('2026') && !title.includes('2025')) return false;
  
  if (strict) {
    // 严格模式：排除内容太短的（至少100字）
    if (!content || content.length < 100) return false;
    
    // 排除导航菜单内容
    const menuPatterns = ['### 新闻', '### 体育', '### 娱乐', '### 财经', '### 汽车', '### 科技', '### 时尚', '### 手机', '### 房产', '### 教育'];
    const hasMenu = menuPatterns.some(pattern => content.includes(pattern));
    if (hasMenu) return false;
    
    // 排除包含大量导航词汇的
    const navWords = ['关于我们', '网站声明', '联系方式', '用户反馈', '网站地图', '帮助中心', '首页', '电报', '话题', '盯盘', '投研', '下载'];
    const navCount = navWords.filter(word => content.includes(word)).length;
    if (navCount >= 3) return false;
    
    // 排除重复标题
    if (isDuplicate(title, history)) return false;
  }
  
  // 宽松模式也检查内容长度（至少50字）
  if (!content || content.length < 50) return false;
  
  return true;
}

async function fetchNewsWithAnysearch(query, minResults = 3) {
  const { execSync } = await import('child_process');
  
  try {
    const cmd = `node ${ANYSEARCH_CLI} search "${query.replace(/"/g, '\\"')}" --max_results 10 --freshness day --api_key ${ANYSEARCH_API_KEY}`;
    console.log(`🔍 搜索: ${query}`);
    const output = execSync(cmd, { encoding: 'utf8', timeout: 30000 });
    
    // Parse anysearch output
    const lines = output.split('\n');
    const results = [];
    let currentResult = null;
    
    for (const line of lines) {
      const titleMatch = line.match(/^### \d+\.\s+(.+)/);
      if (titleMatch) {
        if (currentResult) results.push(currentResult);
        currentResult = { title: titleMatch[1], url: '', content: '' };
      } else if (line.startsWith('- **URL**: ')) {
        if (currentResult) currentResult.url = line.replace('- **URL**: ', '').trim();
      } else if (line.startsWith('- ') && currentResult && !line.includes('URL')) {
        currentResult.content += line.replace('- ', '').trim() + ' ';
      }
    }
    if (currentResult) results.push(currentResult);
    
    if (results.length === 0) {
      throw new Error('未获取到新闻');
    }
    
    // 加载历史记录
    const history = loadHistory();
    
    // 第一轮过滤：严格条件
    let filtered = results.filter(item => isValidNewsItem(item, history, true));
    
    // 如果不够，第二轮过滤：放宽条件
    if (filtered.length < minResults) {
      console.log(`⚠️ 严格过滤后只有 ${filtered.length} 条，放宽条件...`);
      const remaining = results.filter(item => !filtered.includes(item));
      const relaxed = remaining.filter(item => isValidNewsItem(item, history, false));
      filtered = filtered.concat(relaxed);
    }
    
    const validItems = filtered.slice(0, minResults);
    
    // 如果不够，从原始结果补充
    if (validItems.length < minResults) {
      console.log(`⚠️ 过滤后只有 ${validItems.length} 条，从原始结果补充...`);
      const additional = results.filter(r => {
        if (validItems.includes(r)) return false;
        if (isBlockedDomain(r.url || '')) {
          console.log(`🚫 补充阶段排除黑名单: ${r.url}`);
          return false;
        }
        if ((r.content || '').length < 30) return false;
        return true;
      }).slice(0, minResults - validItems.length);
      console.log(`✅ 补充了 ${additional.length} 条`);
      validItems.push(...additional);
    }
    
    if (validItems.length === 0) {
      throw new Error('未获取到有效新闻');
    }
    
    // 更新历史记录
    const newTitles = validItems.slice(0, minResults).map(item => item.title);
    saveHistory([...history, ...newTitles]);
    
    return validItems.slice(0, minResults).map(item => {
      const title = item.title || '无标题';
      const url = item.url || '';
      const domain = url ? new URL(url).hostname.replace('www.', '') : '未知来源';
      
      // 生成一句话摘要
      let summary = generateOneSentenceSummary(item.content, title);
      
      return { 
        title: cleanTitle(title), 
        summary, 
        domain 
      };
    });
  } catch (error) {
    console.error('❌ anysearch 搜索失败:', error.message);
    throw error;
  }
}

function generateOneSentenceSummary(content, title) {
  if (!content) return '暂无摘要';
  
  let text = content;
  try { text = decodeURIComponent(text); } catch {}
  
  // 去掉 HTML 标签
  text = text.replace(/<[^>]*>/g, ' ');
  // 去掉 URL
  text = text.replace(/https?:\/\/[^\s]+/g, ' ');
  // 合并空格
  text = text.replace(/\s+/g, ' ').trim();
  
  // 提取第一个完整句子（长度在30-80字之间）
  const sentences = text.split(/[。！？.!?]/).filter(s => {
    const len = s.trim().length;
    return len >= 20 && len <= 80;
  });
  
  if (sentences.length > 0) {
    return sentences[0].trim();
  }
  
  // 如果没有合适的句子，截取前60字
  if (text.length > 60) {
    return text.substring(0, 60) + '...';
  }
  
  return text || '暂无摘要';
}

function cleanTitle(title) {
  // 去掉常见的网站后缀
  return title
    .replace(/ - [^-]+$/g, '')
    .replace(/_[^_]+$/g, '')
    .replace(/\|[^|]+$/g, '')
    .trim();
}

async function fetchAINews() {
  return await fetchNewsWithAnysearch('人工智能 AI 机器人 最新突破');
}

async function fetchSemiconductorNews() {
  return await fetchNewsWithAnysearch('半导体 芯片 台积电 英伟达 最新新闻');
}

async function fetchWorldNews() {
  return await fetchNewsWithAnysearch('国际新闻 时政 全球热点');
}

function formatNewsSection(title, news) {
  let text = `\n${title}\n`;
  text += '━━━━━━━━━━━━━━━━━━━\n';
  
  if (news.length === 0) {
    text += '\n暂无新闻\n';
    return text;
  }
  
  news.forEach((item, index) => {
    text += `\n📰 ${item.title}\n`;
    if (item.summary && item.summary !== '暂无摘要') {
      text += `📝 ${item.summary}\n`;
    }
    text += `🔗 来源：${item.domain}\n`;
  });
  
  return text;
}

async function sendMorningNews() {
  if (!CHAT_ID) {
    console.error('错误：未设置 FEISHU_NEWS_CHAT_ID');
    process.exit(1);
  }

  console.log('📅 正在生成早报...');
  
  try {
    const weather = await fetchShanghaiWeather();
    const aiNews = await fetchAINews();
    const semiNews = await fetchSemiconductorNews();
    const worldNews = await fetchWorldNews();
    
    const date = new Date().toLocaleDateString('zh-CN', {
      year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
    });
    
    let message = `🌅 ${date} 早报\n`;
    message += '━━━━━━━━━━━━━━━━━━━\n';
    message += `\n${weather}\n`;
    
    message += formatNewsSection('🤖 AI/机器人', aiNews);
    message += formatNewsSection('💻 半导体', semiNews);
    message += formatNewsSection('🌍 国际时政', worldNews);
    
    // 添加总结观点
    message += '\n\n💡 核心观点\n';
    message += '━━━━━━━━━━━━━━━━━━━\n';
    message += '今天 AI 和机器人领域最值得关注的是...\n';
    
    message += '\n\n💡 以上新闻由 AI 助手实时搜索整理';
    
    await imService.sendTextMessage(CHAT_ID, message);
    
    console.log('✅ 早报发送成功！');
  } catch (error) {
    console.error('❌ 早报生成失败:', error.message);
    try {
      await imService.sendTextMessage(CHAT_ID, `⚠️ 早报生成失败\n\n错误：${error.message}`);
    } catch {}
    process.exit(1);
  }
}

sendMorningNews();
