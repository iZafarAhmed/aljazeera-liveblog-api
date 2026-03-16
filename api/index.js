const fetch = require('node-fetch');

const GRAPHQL_URL = 'https://www.aljazeera.com/graphql';
const CACHE_TTL = 15000; // 15 seconds cache for children list

// In-memory cache (resets on cold start - fine for Vercel)
const cache = new Map();

// Helper: Build the exact URL structure Al Jazeera expects
function buildGraphQLUrl(operationName, variables) {
  const varsEncoded = encodeURIComponent(JSON.stringify(variables));
  return `${GRAPHQL_URL}?wp-site=aje&operationName=${operationName}&variables=${varsEncoded}&extensions={}`;
}

// Helper function to make GraphQL GET requests
async function graphqlGetQuery(operationName, variables) {
  const url = buildGraphQLUrl(operationName, variables);
  
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'wp-site': 'aje',
      'x-wp-site': 'aje',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://www.aljazeera.com/',
      'Origin': 'https://www.aljazeera.com'
    }
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'No error body');
    throw new Error(`GraphQL request failed: ${response.status} - ${errorText.substring(0, 300)}`);
  }

  return response.json();
}

// Get children IDs with caching
async function getLiveBlogChildren(postName) {
  const cacheKey = `children:${postName}`;
  const cached = cache.get(cacheKey);
  
  // Return cached version if still fresh
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  const data = await graphqlGetQuery('SingleLiveBlogChildrensQuery', { postName });

  if (!data.data?.article?.children) {
    throw new Error('No children found for this liveblog');
  }

  const children = data.data.article.children;
  
  // Cache the result
  cache.set(cacheKey, {
    data: children,
    timestamp: Date.now()
  });

  return children;
}

// Get individual update by ID
async function getUpdateById(postId) {
  try {
    const data = await graphqlGetQuery('LiveBlogUpdateQuery', {
      postID: Number(postId),
      postType: 'liveblog-update',
      preview: '',
      isAmp: false
    });
    return data.data?.posts || null;
  } catch (error) {
    console.error(`Error fetching update ${postId}:`, error.message);
    return { error: error.message, postId };
  }
}

// Main API handler
module.exports = async (req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { postName, postId, all, since, lastSeen, auto } = req.query;

    // ─────────────────────────────────────────────────────
    // 🔹 Endpoint 1: Get single update by postId
    // ─────────────────────────────────────────────────────
    if (postId) {
      const update = await getUpdateById(postId);
      if (!update || update.error) {
        return res.status(404).json({ success: false, error: update?.error || 'Not found', postId });
      }
      return res.status(200).json({ success: true, data: update, timestamp: new Date().toISOString() });
    }

    if (!postName) {
      return res.status(400).json({
        error: 'Missing postName parameter',
        example: '?postName=iran-war-live-tehran-rejects-trump-claim-on-talks-gulf-attacks-continue'
      });
    }

    // ─────────────────────────────────────────────────────
    // 🔹 Endpoint 2: Get ALL updates (one-time fetch)
    // ─────────────────────────────────────────────────────
    if (all === 'true') {
      const childrenIds = await getLiveBlogChildren(postName);
      const updates = await Promise.all(childrenIds.map(id => getUpdateById(id)));
      const valid = updates.filter(u => u && !u.error);
      
      return res.status(200).json({
        success: true,
        postName,
        total: valid.length,
        data: valid,
        timestamp: new Date().toISOString()
      });
    }

    // ─────────────────────────────────────────────────────
    // 🔹 Endpoint 3: AUTO-UPDATE MODE (Smart Polling) ⭐
    // ─────────────────────────────────────────────────────
    if (auto === 'true' || since || lastSeen) {
      const childrenIds = await getLiveBlogChildren(postName);
      
      // Parse previously seen IDs (comma-separated or JSON array)
      let seenIds = new Set();
      if (lastSeen) {
        try {
          const parsed = JSON.parse(decodeURIComponent(lastSeen));
          Array.isArray(parsed) ? parsed.forEach(id => seenIds.add(id)) : seenIds.add(parsed);
        } catch {
          lastSeen.split(',').forEach(id => seenIds.add(id.trim()));
        }
      }

      // Find NEW IDs (latest first - Al Jazeera returns newest first)
      const newIds = childrenIds.filter(id => !seenIds.has(id));
      
      // If no new updates, return empty with metadata
      if (newIds.length === 0) {
        return res.status(200).json({
          success: true,
          postName,
          newUpdates: 0,
          message: 'No new updates',
          currentCount: childrenIds.length,
          latestId: childrenIds[0],
          pollAfter: 15, // Suggest client wait 15s before next poll
          timestamp: new Date().toISOString()
        });
      }

      // Fetch content for NEW updates only
      const newUpdates = await Promise.all(newIds.map(id => getUpdateById(id)));
      const validUpdates = newUpdates.filter(u => u && !u.error);

      return res.status(200).json({
        success: true,
        postName,
        newUpdates: validUpdates.length,
        newIds: newIds,
         validUpdates,
        currentCount: childrenIds.length,
        latestId: childrenIds[0],
        pollAfter: 15,
        timestamp: new Date().toISOString(),
        // Helper: encode current IDs for next request's lastSeen param
        nextLastSeen: encodeURIComponent(JSON.stringify(childrenIds.slice(0, 20))) // Keep last 20
      });
    }

    // ─────────────────────────────────────────────────────
    // 🔹 Endpoint 4: Just return children IDs (default)
    // ─────────────────────────────────────────────────────
    const childrenIds = await getLiveBlogChildren(postName);
    return res.status(200).json({
      success: true,
      postName,
      count: childrenIds.length,
      childrenIds,
      latestId: childrenIds[0],
      timestamp: new Date().toISOString(),
      examples: {
        single: `?postId=${childrenIds[0]}`,
        all: `?postName=${postName}&all=true`,
        auto: `?postName=${postName}&auto=true&lastSeen=${encodeURIComponent(JSON.stringify([childrenIds[0]]))}`
      }
    });

  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
};
