import { Router } from 'express';
import { ssoController } from '../controllers/ssoController.js';
import { rateLimit, requireAuth } from '../middleware/security.js';

import { requireService } from '../middleware/serviceSecurity.js';
import { authorizeQueueGate } from '../controllers/waitingRoomController.js';
import { revokeServiceSession } from '../controllers/serviceRevocationController.js';

export const ssoRouter = Router();

ssoRouter.get('/login-context', rateLimit('sso-login-context', 40, 60), ssoController.loginContext);
// Authorization validates the registered callback before handling missing/pending sessions.
ssoRouter.get('/authorize', rateLimit('sso-authorize', 40, 60), authorizeQueueGate, ssoController.authorize);
ssoRouter.get('/consent',requireAuth,rateLimit('sso-consent-view',40,60),ssoController.consentContext);
ssoRouter.post('/consent',requireAuth,rateLimit('sso-consent-decision',20,60),ssoController.consentDecision);
ssoRouter.get('/consents',requireAuth,ssoController.consents);
ssoRouter.delete('/consents/:id',requireAuth,rateLimit('sso-consent-revoke',20,60),ssoController.revokeConsent);
ssoRouter.post('/phone-match',requireService('identity:read'),ssoController.matchPhone);
// These two machine-to-machine endpoints authenticate through application-bound API keys.
ssoRouter.post('/token', requireService('identity:read'), ssoController.token);
ssoRouter.post('/introspect', requireService('token:introspect'), ssoController.introspect);
ssoRouter.post('/revoke', requireService('token:revoke'), revokeServiceSession);
ssoRouter.options('/userinfo', rateLimit('sso-userinfo-preflight', 120, 60), ssoController.userinfoOptions);
ssoRouter.get('/userinfo', rateLimit('sso-userinfo', 120, 60), ssoController.userinfo);
