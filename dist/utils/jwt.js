import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
export function signAccessToken(payload) {
    return jwt.sign(payload, config.JWT_SECRET, {
        expiresIn: config.JWT_EXPIRES_IN,
    });
}
export function signRefreshToken(payload) {
    return jwt.sign(payload, config.JWT_SECRET, {
        expiresIn: config.JWT_REFRESH_EXPIRES_IN,
    });
}
export function verifyToken(token) {
    return jwt.verify(token, config.JWT_SECRET);
}
export function decodeToken(token) {
    try {
        return jwt.decode(token);
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=jwt.js.map