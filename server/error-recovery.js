/**
 * Error Recovery & Retry Logic
 * Handles transient failures with exponential backoff
 */

const RETRYABLE_STATUS_CODES = [408, 429, 500, 502, 503, 504];

export class RetryHandler {
  constructor(maxAttempts = 3, baseDelay = 100, maxDelay = 10000) {
    this.maxAttempts = maxAttempts;
    this.baseDelay = baseDelay;
    this.maxDelay = maxDelay;
  }

  // Calculate exponential backoff with jitter
  getDelay(attempt) {
    const exponential = Math.min(
      this.maxDelay,
      this.baseDelay * Math.pow(2, attempt)
    );
    // Add jitter (±20%)
    const jitter = exponential * 0.2 * (Math.random() - 0.5);
    return Math.max(0, exponential + jitter);
  }

  // Check if status code is retryable
  isRetryable(statusCode, error) {
    if (RETRYABLE_STATUS_CODES.includes(statusCode)) return true;
    if (error && error.code) {
      // Retry on network errors
      const retryableCodes = [
        'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH',
        'ENETUNREACH', 'ENOTFOUND', 'ECONNABORTED'
      ];
      return retryableCodes.includes(error.code);
    }
    return false;
  }

  // Execute with retries
  async execute(fn, context = null) {
    let lastError;
    
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      try {
        const result = await fn.call(context);
        return result;
      } catch (error) {
        lastError = error;
        const statusCode = error.statusCode || (error.response?.statusCode);
        
        // Check if we should retry
        if (!this.isRetryable(statusCode, error) || attempt === this.maxAttempts - 1) {
          throw error;
        }
        
        // Wait before retrying
        const delay = this.getDelay(attempt);
        await new Promise(r => setTimeout(r, delay));
      }
    }
    
    throw lastError;
  }
}

// Global retry handler instance
export const globalRetry = new RetryHandler();

// Helper to create error response
export function createErrorResponse(statusCode, message, originalError = null) {
  const errorId = Math.random().toString(36).slice(2, 11);
  
  return {
    statusCode,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
    body: `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Proxy Error - ${statusCode}</title>
  <style>
    * { margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f5f5; }
    .container { max-width: 600px; margin: 50px auto; padding: 20px; background: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
    h1 { color: #d32f2f; margin-bottom: 10px; }
    .status { font-size: 18px; color: #666; margin-bottom: 20px; }
    .message { color: #333; line-height: 1.6; margin-bottom: 20px; }
    .error-id { background: #f5f5f5; padding: 10px; border-radius: 4px; font-family: monospace; font-size: 12px; color: #666; }
    .help { margin-top: 20px; padding-top: 20px; border-top: 1px solid #eee; font-size: 14px; color: #999; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Error ${statusCode}</h1>
    <p class="status">${getStatusMessage(statusCode)}</p>
    <p class="message">${escapeHtml(message)}</p>
    <div class="error-id">Error ID: ${errorId}</div>
    <div class="help">
      <p>Try:</p>
      <ul style="margin-left: 20px; margin-top: 10px;">
        <li>Refreshing the page</li>
        <li>Checking if the site is online</li>
        <li>Trying again in a few moments</li>
      </ul>
    </div>
  </div>
</body>
</html>`,
  };
}

// HTTP status messages
function getStatusMessage(code) {
  const messages = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    408: 'Request Timeout',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout',
  };
  return messages[code] || 'Error';
}

// Escape HTML for safe display
function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}

// Check if connection error is likely temporary
export function isTemporaryError(error) {
  if (!error) return false;
  
  const temporaryCodes = [
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENETUNREACH',
  ];
  
  return temporaryCodes.includes(error.code);
}
