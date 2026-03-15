const fetch = require('node-fetch');

const GRAPHQL_URL = 'https://www.aljazeera.com/graphql';

// Helper: Build the exact URL structure Al Jazeera expects
function buildGraphQLUrl(operationName, variables) {
  const varsEncoded = encodeURIComponent(JSON.stringify(variables));
  return `${GRAPHQL_URL}?wp-site=aje&operationName=${operationName}&variables=${varsEncoded}&extensions={}`;
}

// Helper function to make GraphQL GET requests with proper headers
async function graphqlGetQuery(operationName, variables) {
  const url = buildGraphQLUrl(operationName, variables);
  
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      // Critical: wp-site as BOTH query param AND header
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
    // IMPORTANT: postID must be a NUMBER, not string
    const data = await graphqlGetQuery('LiveBlogUpdateQuery', {
      postID: Number(postId),
      postType: 'liveblog-update',
      preview: '',
      isAmp: false
    });

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
    const { postName, postId, all } = req.query;

    if (!postName && !postId) {
      return res.status(400).json({
        error: 'Missing required parameter',
        message: 'Please provide either "postName" or "postId"',
        example: {
          postName: 'iran-war-live-trump-urges-world-to-keep-hormuz-strait-open',
          postId: '4400931'
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
        timestamp: new Date().toISOString()
      });
    }

    // Return just IDs
    return res.status(200).json({
      success: true,
      postName,
      childrenCount: childrenIds.length,
      childrenIds,
      message: 'Use all=true to fetch full content',
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
