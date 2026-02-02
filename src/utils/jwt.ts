import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';

export interface JwtPayload {
  userId: string;
  sessionId: string;
}

export function signAccessToken(payload: JwtPayload): string {
  return jwt.sign(payload, config.JWT_SECRET as any, {
    expiresIn: config.JWT_EXPIRES_IN as any,
  });
}

export function signRefreshToken(payload: JwtPayload): string {
  return jwt.sign(payload, config.JWT_SECRET as any, {
    expiresIn: config.JWT_REFRESH_EXPIRES_IN as any,
  });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, config.JWT_SECRET) as JwtPayload;
}

export function decodeToken(token: string): JwtPayload | null {
  try {
    return jwt.decode(token) as JwtPayload;
  } catch {
    return null;
  }
}
