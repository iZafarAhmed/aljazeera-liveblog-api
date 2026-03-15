const fetch = require('node-fetch');
const { URLSearchParams } = require('url');

const GRAPHQL_URL = 'https://www.aljazeera.com/graphql';

// Helper: Build query string for GET request
function buildGraphQLGetUrl(operationName, variables, wpSite = 'aje') {
  const params = new URLSearchParams({
    'wp-site': wpSite,
    'operationName': operationName,
    'variables': JSON.stringify(variables),
    'extensions': '{}'
  });
  return `${GRAPHQL_URL}?${params.toString()}`;
}

// Helper function to make GraphQL GET requests
async function graphqlGetQuery(operationName, variables) {
  const url = buildGraphQLGetUrl(operationName, variables);
  
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://www.aljazeera.com/',
      'Origin': 'https://www.aljazeera.com'
    }
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'No error body');
    throw new Error(`GraphQL request failed: ${response.status} - ${errorText.substring(0, 200)}`);
  }

  return response.json();
}

// Get all children IDs for a liveblog
async function getLiveBlogChildren(postName) {
  const data = await graphqlGetQuery('SingleLiveBlogChildrensQuery', {
    postName
  });

  if (!data.data?.article?.children) {
    throw new Error('No children found for this liveblog');
  }

  return data.data.article.children;
}

// Get individual update by ID
async function getUpdateById(postId) {
  try {
    const data = await graphqlGetQuery('LiveBlogUpdateQuery', {
      postID: postId.toString(),
      postType: 'liveblog-update',
      preview: '',
      isAmp: false
    });

    // Return the posts object directly
    return data.data?.posts || null;
    
  } catch (error) {
    console.error(`Error fetching update ${postId}:`, error.message);
    return {
      error: error.message,
      postId: postId
    };
  }
}

// Main API handler
module.exports = async (req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { postName, postId, all, debug } = req.query;

    if (!postName && !postId) {
      return res.status(400).json({
        error: 'Missing required parameter',
        message: 'Please provide either "postName" or "postId"',
        example: {
          postName: 'iran-war-live-trump-urges-world-to-keep-hormuz-strait-open',
          postId: '4400931',
          all: 'true (optional - fetches all updates)'
        }
      });
    }

    // Fetch specific update by postId
    if (postId) {
      const update = await getUpdateById(postId);
      
      if (!update || update.error) {
        return res.status(404).json({
          success: false,
          error: update?.error || 'Update not found',
          postId: postId,
          timestamp: new Date().toISOString()
        });
      }

      return res.status(200).json({
        success: true,
        data: update,
        timestamp: new Date().toISOString()
      });
    }

    // Get all children IDs
    const childrenIds = await getLiveBlogChildren(postName);

    // Fetch all updates if requested
    if (all === 'true') {
      const updates = await Promise.all(
        childrenIds.map(id => getUpdateById(id))
      );

      const validUpdates = updates.filter(u => u && !u.error);
      const failedUpdates = updates.filter(u => !u || u.error);

      return res.status(200).json({
        success: true,
        postName,
        totalUpdates: validUpdates.length,
        failedCount: failedUpdates.length,
        data: validUpdates,
        failedUpdates: debug === 'true' ? failedUpdates : undefined,
        timestamp: new Date().toISOString(),
        cache: {
          maxAge: 30,
          nextFetch: new Date(Date.now() + 30000).toISOString()
        }
      });
    }

    // Return just IDs
    return res.status(200).json({
      success: true,
      postName,
      childrenCount: childrenIds.length,
      childrenIds,
      message: 'Use all=true to fetch full content',
      example: `?postName=${postName}&all=true`,
      timestamp: new Date().toISOString()
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
