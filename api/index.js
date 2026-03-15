const fetch = require('node-fetch');

const GRAPHQL_URL = 'https://www.aljazeera.com/graphql';

// Helper function to make GraphQL requests
async function graphqlQuery(operationName, variables) {
  const response = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://www.aljazeera.com/',
      'Origin': 'https://www.aljazeera.com'
    },
    body: JSON.stringify({
      operationName,
      variables,
      extensions: {}
    })
  });

  if (!response.ok) {
    throw new Error(`GraphQL request failed: ${response.status}`);
  }

  return response.json();
}

// Get all children IDs for a liveblog
async function getLiveBlogChildren(postName) {
  const data = await graphqlQuery('SingleLiveBlogChildrensQuery', {
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
    const data = await graphqlQuery('LiveBlogUpdateQuery', {
      postID: postId.toString(),
      postType: 'liveblog-update',
      preview: '',
      isAmp: false
    });

    return data.data?.posts || null;
  } catch (error) {
    console.error(`Error fetching update ${postId}:`, error.message);
    return null;
  }
}

// Main API handler
module.exports = async (req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only allow GET requests
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Extract postName from query parameters
    const { postName, postId, all } = req.query;

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

    // If specific postId is provided, fetch only that update
    if (postId) {
      const update = await getUpdateById(postId);
      return res.status(200).json({
        success: true,
        data: update,
        timestamp: new Date().toISOString()
      });
    }

    // Get all children IDs
    const childrenIds = await getLiveBlogChildren(postName);

    // If all=true, fetch all updates
    if (all === 'true') {
      const updates = await Promise.all(
        childrenIds.map(id => getUpdateById(id))
      );

      // Filter out null values (failed requests)
      const validUpdates = updates.filter(update => update !== null);

      return res.status(200).json({
        success: true,
        postName,
        totalUpdates: validUpdates.length,
        data: validUpdates,
        timestamp: new Date().toISOString(),
        cache: {
          maxAge: 30, // Suggest caching for 30 seconds
          nextFetch: new Date(Date.now() + 30000).toISOString()
        }
      });
    }

    // Default: Return just the IDs and metadata
    return res.status(200).json({
      success: true,
      postName,
      childrenCount: childrenIds.length,
      childrenIds,
      message: 'Use all=true parameter to fetch full content',
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
