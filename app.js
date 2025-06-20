const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const fetch = require('node-fetch');
const WebSocket = require('ws');
const sanitizer = require('sanitizer');
const path = require('path');
const fs = require('fs');

const app = express();

// Load config
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const injectScript = fs.readFileSync(path.join(__dirname, 'utils', 'assets', 'inject.js'), 'utf8');
const prefix = config.prefix || '/proxy/';

// キャッシュの設定
const cache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5分

// ミドルウェアの設定
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: 'alloy-proxy',
  resave: false,
  saveUninitialized: true,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true
  }
}));

// 静的ファイルの提供（キャッシュ有効）
app.use(express.static('public', {
  maxAge: '1h',
  etag: true
}));

// メインページのルート
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// プロキシセッションエンドポイント
app.post('/proxy/session/', async (req, res) => {
  try {
    let url = req.body.url;
    if (!url) {
      return res.status(400).json({ error: 'URLが必要です' });
    }

    url = url.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }

    try {
      const urlObj = new URL(url);
      if (!urlObj.hostname) {
        throw new Error('無効なURL');
      }
    } catch (e) {
      return res.status(400).json({ error: '無効なURLです' });
    }

    const encodedUrl = Buffer.from(url).toString('base64');
    res.json({ redirect: prefix + encodedUrl });

  } catch (error) {
    console.error('プロキシエラー:', error);
    res.status(500).json({ error: '内部サーバーエラーが発生しました' });
  }
});

// プロキシルート
app.all('/proxy/:encodedPath(*)', async (req, res) => {
  try {
    // Extract the base64 encoded URL from the path
    const pathParts = req.params.encodedPath.split('/');
    const encodedUrl = pathParts[0];
    const remainingPath = pathParts.slice(1).join('/');
    
    let decodedUrl;
    try {
      decodedUrl = Buffer.from(encodedUrl, 'base64').toString('utf-8');
      const baseUrl = new URL(decodedUrl);
      
      // Append remaining path to the decoded URL
      if (remainingPath) {
        baseUrl.pathname = baseUrl.pathname.replace(/\/$/, '') + '/' + remainingPath;
      }
      
      // Handle query parameters
      if (req.query && Object.keys(req.query).length > 0) {
        const searchParams = new URLSearchParams(req.query);
        baseUrl.search = searchParams.toString();
      }
      
      decodedUrl = baseUrl.toString();
    } catch (e) {
      throw new Error('Invalid URL encoding');
    }

    // キャッシュチェック（GETリクエストのみ）
    const cacheKey = decodedUrl;
    if (req.method === 'GET') {
      const cachedResponse = cache.get(cacheKey);
      if (cachedResponse && Date.now() - cachedResponse.timestamp < CACHE_DURATION) {
        res.set(cachedResponse.headers);
        return res.send(cachedResponse.body);
      }
    }

    // リクエストヘッダーの設定
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
      'Referer': new URL(decodedUrl).origin,
      'Origin': new URL(decodedUrl).origin
    };

    // POSTリクエストの処理
    let body;
    if (req.method === 'POST') {
      headers['Content-Type'] = req.headers['content-type'] || 'application/x-www-form-urlencoded';
      if (headers['Content-Type'].includes('application/x-www-form-urlencoded')) {
        const formData = new URLSearchParams();
        for (const [key, value] of Object.entries(req.body)) {
          formData.append(key, value);
        }
        body = formData.toString();
      } else {
        body = JSON.stringify(req.body);
      }
    }

    const fetchOptions = {
      method: req.method,
      headers: headers,
      body: body,
      redirect: 'follow'
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    fetchOptions.signal = controller.signal;

    const response = await fetch(decodedUrl, fetchOptions);
    clearTimeout(timeoutId);

    // レスポンスヘッダーの設定
    const responseHeaders = {};
    for (const [key, value] of response.headers.entries()) {
      if (!['content-encoding', 'content-length', 'transfer-encoding'].includes(key.toLowerCase())) {
        responseHeaders[key] = value;
        res.setHeader(key, value);
      }
    }

    // コンテンツタイプに基づいて処理
    const contentType = response.headers.get('content-type') || '';
    
    if (contentType.includes('text/html')) {
      let body = await response.text();
      
      // HTML内のURLを書き換え
      body = body.replace(/(?:href|src|action)="([^"]+)"/g, (match, url) => {
        try {
          if (url.startsWith('/')) {
            url = new URL(decodedUrl).origin + url;
          }
          const absoluteUrl = new URL(url, decodedUrl).href;
          if (absoluteUrl.startsWith('http://') || absoluteUrl.startsWith('https://')) {
            const encodedUrl = Buffer.from(absoluteUrl).toString('base64');
            return match.replace(url, prefix + encodedUrl);
          }
        } catch (e) {}
        return match;
      });

      // フォームの処理を改善
      body = body.replace(/<form([^>]*)>/g, (match, attrs) => {
        // action属性がない場合は現在のURLを使用
        if (!attrs.includes('action="')) {
          const encodedCurrentUrl = Buffer.from(decodedUrl).toString('base64');
          return `<form${attrs} action="${prefix}${encodedCurrentUrl}">`;
        }
        
        // action属性がある場合は書き換え
        return match.replace(/action="([^"]+)"/g, (actionMatch, actionUrl) => {
          try {
            if (actionUrl.startsWith('/')) {
              actionUrl = new URL(decodedUrl).origin + actionUrl;
            }
            const absoluteUrl = new URL(actionUrl, decodedUrl).href;
            const encodedUrl = Buffer.from(absoluteUrl).toString('base64');
            return `action="${prefix}${encodedUrl}"`;
          } catch (e) {
            return actionMatch;
          }
        });
      });

      // スクリプトの注入
      const dataDiv = `<div id="_alloy_data" style="display:none" url="${Buffer.from(decodedUrl).toString('base64')}" prefix="${prefix}"></div>`;
      const scriptTag = `<script>${injectScript}</script>`;
      
      body = body.replace('</body>', `${dataDiv}${scriptTag}</body>`);
      if (!body.includes('</body>')) {
        body += `${dataDiv}${scriptTag}`;
      }

      // GETリクエストの場合はキャッシュを更新
      if (req.method === 'GET') {
        cache.set(cacheKey, {
          body: body,
          headers: responseHeaders,
          timestamp: Date.now()
        });
      }

      res.send(body);
    } else {
      // バイナリデータはそのまま転送
      response.body.pipe(res);
    }
  } catch (error) {
    console.error('プロキシエラー:', error);
    if (error.name === 'AbortError') {
      res.status(504).send('タイムアウトエラーが発生しました');
    } else {
      res.status(502).sendFile(path.join(__dirname, 'utils', 'error', 'error.html'));
    }
  }
});

const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, () => {
  console.log(`サーバーがポート ${PORT} で起動しました`);
});

// WebSocketプロキシの設定
require('./ws-proxy.js')(server);