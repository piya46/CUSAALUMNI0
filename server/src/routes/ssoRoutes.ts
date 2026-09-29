import { Router } from 'express';
import { ssoController } from '../controllers/ssoController.js';
import { rateLimit } from '../middleware/security.js';

import { requireService } from '../middleware/serviceSecurity.js';

export const ssoRouter = Router();

ssoRouter.get('/login-context', rateLimit('sso-login-context', 40, 60), ssoController.loginContext);
// Authorization validates the registered callback before handling missing/pending sessions.
ssoRouter.get('/authorize', rateLimit('sso-authorize', 40, 60), ssoController.authorize);
// These two machine-to-machine endpoints authenticate through application-bound API keys.
ssoRouter.post('/token', requireService('identity:read'), ssoController.token);
ssoRouter.post('/introspect', requireService('token:introspect'), ssoController.introspect);
ssoRouter.options('/userinfo', rateLimit('sso-userinfo-preflight', 120, 60), ssoController.userinfoOptions);
ssoRouter.get('/userinfo', rateLimit('sso-userinfo', 120, 60), ssoController.userinfo);
