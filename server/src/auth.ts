import { IncomingMessage } from 'http';
import { config } from './config.js';

export function verifyToken(token: string | undefined | null): boolean {
  // If no auth token is required on the server, allow all
  if (!config.authToken || config.authToken.trim() === '') {
    return true;
  }
  if (!token) return false;
  return token === config.authToken;
}

export function extractTokenFromRequest(req: IncomingMessage): string | undefined {
  const authHeader = req.headers['authorization'];
  if (authHeader) {
    if (authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7).trim();
    }
    return authHeader.trim();
  }

  // Check URL query parameters
  if (req.url) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const token = url.searchParams.get('token');
      if (token) return token;
    } catch {
      // Ignore URL parse error
    }
  }

  return undefined;
}
