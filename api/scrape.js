// api/scrape.js
// Simple serverless endpoint to fetch a tiktok profile page server-side,
// extract embedded JSON (SIGI_STATE / INIT_PROPS patterns), and return video items.
//
// Optional: set PROXY_URL env var to a proxy prefix, e.g. "https://my-proxy.example/?q="
// (proxy should accept a target URL as a query param or similar — adjust if needed).

const fetch = global.fetch || require('node-fetch');

module.exports = async (req, res) => {
  try {
    const username = (req.query.user || req.query.u || '').toString().trim().replace(/^@/, '');
    if (!username) return res.status(400).json({ error: 'Missing user parameter' });

    const target = `https://www.tiktok.com/@${encodeURIComponent(username)}`;
    const proxy = process.env.PROXY_URL || ''; // optional: e.g. "https://my-proxy/?url="

    const urlToFetch = proxy ? `${proxy}${encodeURIComponent(target)}` : target;

    // Server-side fetch with browser-like headers
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    };

    const resp = await fetch(urlToFetch, { headers, redirect: 'follow' });
    if (!resp.ok) {
      const txt = await resp.text().catch(()=>'');
      return res.status(Math.max(500, resp.status)).json({ error: 'Fetch failed', status: resp.status, bodySnippet: txt.slice(0, 800) });
    }

    const html = await resp.text();

    // Several patterns TikTok uses for embedding data
    const patterns = [
      /id="SIGI_STATE">([\s\S]*?)<\/script>/i,
      /<script id="SIGI_STATE" type="application\/json">([\s\S]*?)<\/script>/i,
      /window\.__INIT_PROPS__\s*=\s*([\s\S]*?);<\/script>/i,
      /window\["__UNIVERSAL_DATA_FOR_REHYDRATION__"\]\s*=\s*([\s\S]*?);/i,
      /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__".*?>([\s\S]*?)<\/script>/i,
      /<script>\s*?window\['SIGI_STATE'\]\s*=\s*([\s\S]*?)<\/script>/i
    ];

    let jsonString = null;
    for (const pat of patterns) {
      const m = html.match(pat);
      if (m && m[1]) {
        jsonString = m[1].trim();
        break;
      }
    }

    if (!jsonString) {
      // If no JSON found, return a helpful snippet so caller can debug
      return res.status(422).json({ error: 'Could not find embedded JSON on page. Possibly blocked.', snippet: html.slice(0, 1200) });
    }

    // Attempt parse (some pages wrap with HTML-escaped text — try to fix common issues)
    let parsed;
    try {
      parsed = JSON.parse(jsonString);
    } catch (err) {
      // attempt to unescape possible HTML entities or JS escapes
      try {
        const cleaned = jsonString
          .replace(/\n/g, ' ')
          .replace(/\\x3C/g, '<')
          .replace(/\\u003C/g, '<')
          .replace(/<\/script>/g, '<\\/script>');
        parsed = JSON.parse(cleaned);
      } catch (err2) {
        return res.status(500).json({ error: 'JSON parse failed', parseError: err2.toString().slice(0,300) });
      }
    }

    // Try to extract video items from common places:
    // 1) SIGI_STATE.ItemModule
    // 2) parsed.ItemModule
    // 3) parsed.props?.pageProps?.items or similar
    const items = [];

    // helper to push clean item
    const pushItem = (raw) => {
      const v = raw.video || raw;
      const id = raw.awemeId || raw.id || raw.itemId || raw.media_id || raw.video?.vid || v?.vid || null;
      const playAddr = v?.playAddr || (v?.playAddr && v.playAddr[0]) || raw.video?.playAddr || null;
      const downloadAddr = v?.downloadAddr || raw.video?.downloadAddr || null;
      const cover = v?.originCover || v?.cover || v?.dynamicCover || raw.cover || null;
      items.push({
        id,
        desc: raw.desc || raw.description || raw.title || '',
        cover,
        playAddr,
        downloadAddr,
        raw
      });
    };

    // case A: SIGI_STATE-like structure
    if (parsed?.ItemModule && typeof parsed.ItemModule === 'object') {
      Object.values(parsed.ItemModule).forEach(x => pushItem(x));
    }

    // case B: parsed.UserModule?.items or parsed.ItemList
    // Look for common nested candidates
    const searchForItems = (obj) => {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) {
        obj.forEach(searchForItems);
        return;
      }
      // heuristic: objects with awemeId or itemId or video property
      if (obj.awemeId || obj.itemId || obj.video) {
        pushItem(obj);
      } else {
        Object.values(obj).forEach(searchForItems);
      }
    };

    if (items.length === 0) {
      // search in properties
      if (parsed?.props?.pageProps) searchForItems(parsed.props.pageProps);
      else searchForItems(parsed);
    }

    // dedupe by id
    const dedup = [];
    const seen = new Set();
    items.forEach(it => {
      if (!it.id) return;
      if (seen.has(it.id)) return;
      seen.add(it.id);
      dedup.push(it);
    });

    if (dedup.length === 0) {
      return res.status(422).json({ error: 'No video items found in parsed JSON', parsedKeys: Object.keys(parsed).slice(0,20) });
    }

    // Limit output to a reasonable number
    const out = dedup.slice(0, 30).map(it => ({
      id: it.id,
      desc: it.desc,
      cover: it.cover,
      playAddr: Array.isArray(it.playAddr) ? it.playAddr[0] : it.playAddr,
      downloadAddr: it.downloadAddr
    }));

    // Allow same-origin fetch from your frontend
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json({ user: username, count: out.length, items: out });
  } catch (err) {
    console.error('scrape error', err);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(500).json({ error: 'Server error', message: (err && err.message) ? err.message : String(err) });
  }
};
